use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;

use super::protocol::*;
use super::*;

async fn listener() -> (TcpListener, u16) {
    let l = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = l.local_addr().unwrap().port();
    (l, port)
}

fn config(port: u16) -> TelnetConfig {
    TelnetConfig {
        host: "127.0.0.1".into(),
        port,
        size: TerminalSize::new(80, 24).unwrap(),
        term: "xterm".into(),
        tx_newline: TxNewline::Cr,
        rx_newline: RxNewline::Raw,
        connect_timeout: Duration::from_secs(2),
    }
}

async fn read_exact_n(s: &mut TcpStream, n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    timeout(Duration::from_secs(5), s.read_exact(&mut buf))
        .await
        .expect("サーバー側の読み取りがタイムアウト")
        .unwrap();
    buf
}

async fn read_until(s: &mut TelnetSession, needle: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    timeout(Duration::from_secs(5), async {
        while let Some(c) = s.read().await.unwrap() {
            out.extend(c);
            if out.windows(needle.len()).any(|w| w == needle) {
                break;
            }
        }
    })
    .await
    .expect("タイムアウト");
    out
}

#[tokio::test]
async fn receives_data_with_iac_stripped() {
    let (l, port) = listener().await;
    tokio::spawn(async move {
        let (mut sock, _) = l.accept().await.unwrap();
        sock.write_all(&[IAC, DO, 99, b'h', b'i', IAC, IAC, b'!'])
            .await
            .unwrap();
        // 交渉拒否の応答が来るまで接続を保つ
        let mut b = [0u8; 3];
        let _ = sock.read_exact(&mut b).await;
    });
    let mut s = TelnetSession::connect(config(port)).await.unwrap();
    let out = read_until(&mut s, b"!").await;
    assert_eq!(out, [b'h', b'i', 0xff, b'!']);
}

#[tokio::test]
async fn answers_negotiation_and_sends_naws() {
    let (l, port) = listener().await;
    let server = tokio::spawn(async move {
        let (mut sock, _) = l.accept().await.unwrap();
        sock.write_all(&[IAC, DO, OPT_NAWS, IAC, DO, 99])
            .await
            .unwrap();
        let expected_len = 3 + build_naws(80, 24).len() + 3;
        read_exact_n(&mut sock, expected_len).await
    });
    let _s = TelnetSession::connect(config(port)).await.unwrap();
    let got = server.await.unwrap();
    let mut expected = vec![IAC, WILL, OPT_NAWS];
    expected.extend(build_naws(80, 24));
    expected.extend([IAC, WONT, 99]);
    assert_eq!(got, expected);
}

#[tokio::test]
async fn write_escapes_iac_and_converts_newline() {
    let (l, port) = listener().await;
    let server = tokio::spawn(async move {
        let (mut sock, _) = l.accept().await.unwrap();
        read_exact_n(&mut sock, 6).await
    });
    let mut cfg = config(port);
    cfg.tx_newline = TxNewline::CrLf;
    let mut s = TelnetSession::connect(cfg).await.unwrap();
    s.write(&[b'a', 0xff, b'\r', b'b']).await.unwrap();
    assert_eq!(
        server.await.unwrap(),
        [b'a', 0xff, 0xff, b'\r', b'\n', b'b']
    );
}

#[tokio::test]
async fn rx_newline_conversion_is_applied() {
    let (l, port) = listener().await;
    tokio::spawn(async move {
        let (mut sock, _) = l.accept().await.unwrap();
        sock.write_all(b"a\nb\n").await.unwrap();
        let mut b = [0u8; 1];
        let _ = sock.read(&mut b).await;
    });
    let mut cfg = config(port);
    cfg.rx_newline = RxNewline::LfToCrLf;
    let mut s = TelnetSession::connect(cfg).await.unwrap();
    assert_eq!(read_until(&mut s, b"b\r\n").await, b"a\r\nb\r\n");
}

#[tokio::test]
async fn resize_sends_naws_after_negotiation() {
    let (l, port) = listener().await;
    let server = tokio::spawn(async move {
        let (mut sock, _) = l.accept().await.unwrap();
        sock.write_all(&[IAC, DO, OPT_NAWS]).await.unwrap();
        let first = 3 + build_naws(80, 24).len();
        read_exact_n(&mut sock, first).await;
        read_exact_n(&mut sock, build_naws(120, 40).len()).await
    });
    let mut s = TelnetSession::connect(config(port)).await.unwrap();
    // 交渉完了前にresizeしても落ちない。サーバー応答を待ってから再送する。
    tokio::time::sleep(Duration::from_millis(200)).await;
    s.resize(TerminalSize::new(120, 40).unwrap()).await.unwrap();
    assert_eq!(server.await.unwrap(), build_naws(120, 40));
}

#[tokio::test]
async fn remote_close_ends_read_and_blocks_write() {
    let (l, port) = listener().await;
    tokio::spawn(async move {
        let (mut sock, _) = l.accept().await.unwrap();
        sock.write_all(b"bye").await.unwrap();
        // ドロップで切断
    });
    let mut s = TelnetSession::connect(config(port)).await.unwrap();
    read_until(&mut s, b"bye").await;
    let r = timeout(Duration::from_secs(5), async {
        while s.read().await.unwrap().is_some() {}
    })
    .await;
    assert!(r.is_ok());
    // 切断検知後は書き込めない（フリーズしない）
    let w = timeout(Duration::from_secs(5), async {
        for _ in 0..50 {
            if s.write(b"x").await.is_err() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    })
    .await
    .unwrap();
    assert!(w);
}

#[tokio::test]
async fn close_is_idempotent() {
    let (l, port) = listener().await;
    tokio::spawn(async move {
        let (_sock, _) = l.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;
    });
    let mut s = TelnetSession::connect(config(port)).await.unwrap();
    s.close().await.unwrap();
    s.close().await.unwrap();
    assert!(matches!(s.write(b"x").await, Err(TerminalError::Closed)));
    assert!(matches!(
        s.resize(TerminalSize::new(80, 24).unwrap()).await,
        Err(TerminalError::Closed)
    ));
}

#[tokio::test]
async fn connection_refused_is_connection_failed() {
    let (l, port) = listener().await;
    drop(l);
    let r = TelnetSession::connect(config(port)).await;
    assert!(matches!(r, Err(TerminalError::ConnectionFailed(_))));
}

#[tokio::test]
async fn remote_echo_flag_follows_server_will_echo() {
    let (l, port) = listener().await;
    tokio::spawn(async move {
        let (mut sock, _) = l.accept().await.unwrap();
        sock.write_all(&[IAC, WILL, OPT_ECHO, b'x']).await.unwrap();
        let mut b = [0u8; 3];
        let _ = sock.read_exact(&mut b).await;
        tokio::time::sleep(Duration::from_secs(1)).await;
    });
    let mut s = TelnetSession::connect(config(port)).await.unwrap();
    read_until(&mut s, b"x").await;
    assert!(s.remote_echo());
}

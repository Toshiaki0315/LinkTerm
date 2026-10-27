//! SOCKS5 サーバー側のやり取り（`ssh -D` 用）。
//!
//! 対応するのは「認証なし」の `CONNECT` のみ。待ち受けは 127.0.0.1 に限るので認証は不要。
//! 要求された接続先（IPv4 / ドメイン名 / IPv6）を取り出し、結果の応答を返す。

use std::net::{Ipv4Addr, Ipv6Addr};

use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const VERSION: u8 = 5;
const NO_AUTH: u8 = 0x00;
const NO_ACCEPTABLE_METHOD: u8 = 0xff;
const CMD_CONNECT: u8 = 0x01;
const ATYP_IPV4: u8 = 0x01;
const ATYP_DOMAIN: u8 = 0x03;
const ATYP_IPV6: u8 = 0x04;

/// SOCKS5 の応答コード（REP）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reply {
    Succeeded = 0x00,
    GeneralFailure = 0x01,
    ConnectionRefused = 0x05,
    CommandNotSupported = 0x07,
    AddressTypeNotSupported = 0x08,
}

#[derive(Debug, Error)]
pub enum SocksError {
    #[error("SOCKS5ではない接続です")]
    NotSocks5,
    #[error("SOCKS5の認証なしが提示されませんでした")]
    NoAcceptableMethod,
    #[error("SOCKS5のCONNECT以外は対応していません")]
    UnsupportedCommand,
    #[error("SOCKS5の接続先の種類に対応していません")]
    UnsupportedAddress,
    #[error("SOCKS5の接続先が不正です")]
    InvalidAddress,
    #[error("SOCKS5の入出力: {0}")]
    Io(#[from] std::io::Error),
}

/// クライアントのあいさつと要求を読み、接続先 `(ホスト, ポート)` を返す。
/// 対応外の要求には、エラーを返す前に拒否の応答を送る。
pub async fn accept_request<S>(stream: &mut S) -> Result<(String, u16), SocksError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut head = [0u8; 2];
    stream.read_exact(&mut head).await?;
    if head[0] != VERSION {
        return Err(SocksError::NotSocks5);
    }
    let mut methods = vec![0u8; usize::from(head[1])];
    stream.read_exact(&mut methods).await?;
    if !methods.contains(&NO_AUTH) {
        stream.write_all(&[VERSION, NO_ACCEPTABLE_METHOD]).await?;
        return Err(SocksError::NoAcceptableMethod);
    }
    stream.write_all(&[VERSION, NO_AUTH]).await?;

    let mut req = [0u8; 4];
    stream.read_exact(&mut req).await?;
    if req[0] != VERSION {
        return Err(SocksError::NotSocks5);
    }
    if req[1] != CMD_CONNECT {
        send_reply(stream, Reply::CommandNotSupported).await?;
        return Err(SocksError::UnsupportedCommand);
    }
    let host = match req[3] {
        ATYP_IPV4 => {
            let mut b = [0u8; 4];
            stream.read_exact(&mut b).await?;
            Ipv4Addr::from(b).to_string()
        }
        ATYP_IPV6 => {
            let mut b = [0u8; 16];
            stream.read_exact(&mut b).await?;
            Ipv6Addr::from(b).to_string()
        }
        ATYP_DOMAIN => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await?;
            let mut name = vec![0u8; usize::from(len[0])];
            stream.read_exact(&mut name).await?;
            match String::from_utf8(name) {
                Ok(n) if !n.is_empty() => n,
                _ => {
                    send_reply(stream, Reply::GeneralFailure).await?;
                    return Err(SocksError::InvalidAddress);
                }
            }
        }
        _ => {
            send_reply(stream, Reply::AddressTypeNotSupported).await?;
            return Err(SocksError::UnsupportedAddress);
        }
    };
    let mut port = [0u8; 2];
    stream.read_exact(&mut port).await?;
    Ok((host, u16::from_be_bytes(port)))
}

/// 応答を送る（束縛アドレスは 0.0.0.0:0 とする）。
pub async fn send_reply<S>(stream: &mut S, reply: Reply) -> std::io::Result<()>
where
    S: AsyncWrite + Unpin,
{
    stream
        .write_all(&[VERSION, reply as u8, 0, ATYP_IPV4, 0, 0, 0, 0, 0, 0])
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn run(client_bytes: &[u8]) -> (Result<(String, u16), SocksError>, Vec<u8>) {
        let (mut client, mut server) = tokio::io::duplex(1024);
        client.write_all(client_bytes).await.unwrap();
        // 入力の終わりを伝える（途中で切れた入力が待ち続けないことも確かめる）。
        client.shutdown().await.unwrap();
        let result = accept_request(&mut server).await;
        drop(server);
        let mut reply = Vec::new();
        client.read_to_end(&mut reply).await.unwrap();
        (result, reply)
    }

    #[tokio::test]
    async fn domain_connect_is_parsed_and_auth_none_selected() {
        let mut req = vec![5, 1, 0, 5, 1, 0, 3, 11];
        req.extend_from_slice(b"example.com");
        req.extend_from_slice(&443u16.to_be_bytes());
        let (r, reply) = run(&req).await;
        assert_eq!(r.unwrap(), ("example.com".to_string(), 443));
        assert_eq!(reply, vec![5, 0]);
    }

    #[tokio::test]
    async fn ipv4_and_ipv6_are_parsed() {
        let (r, _) = run(&[5, 1, 0, 5, 1, 0, 1, 10, 0, 0, 7, 0, 80]).await;
        assert_eq!(r.unwrap(), ("10.0.0.7".to_string(), 80));
        let mut req = vec![5, 1, 0, 5, 1, 0, 4];
        req.extend_from_slice(&Ipv6Addr::LOCALHOST.octets());
        req.extend_from_slice(&22u16.to_be_bytes());
        let (r, _) = run(&req).await;
        assert_eq!(r.unwrap(), ("::1".to_string(), 22));
    }

    #[tokio::test]
    async fn auth_none_may_be_among_several_methods() {
        let (r, reply) = run(&[5, 2, 2, 0, 5, 1, 0, 1, 1, 2, 3, 4, 0, 25]).await;
        assert_eq!(r.unwrap(), ("1.2.3.4".to_string(), 25));
        assert_eq!(&reply[..2], &[5, 0]);
    }

    #[tokio::test]
    async fn without_auth_none_the_client_is_refused() {
        let (r, reply) = run(&[5, 1, 2]).await;
        assert!(matches!(r, Err(SocksError::NoAcceptableMethod)));
        assert_eq!(reply, vec![5, 0xff]);
    }

    #[tokio::test]
    async fn socks4_or_http_is_not_accepted() {
        let (r, _) = run(b"GET / HTTP/1.1\r\n").await;
        assert!(matches!(r, Err(SocksError::NotSocks5)));
        let (r, _) = run(&[4, 1, 0, 80, 1, 2, 3, 4, 0]).await;
        assert!(matches!(r, Err(SocksError::NotSocks5)));
    }

    #[tokio::test]
    async fn bind_and_udp_are_refused_with_command_not_supported() {
        for cmd in [2u8, 3] {
            let (r, reply) = run(&[5, 1, 0, 5, cmd, 0, 1, 1, 2, 3, 4, 0, 80]).await;
            assert!(matches!(r, Err(SocksError::UnsupportedCommand)));
            assert_eq!(reply[2..4], [5, Reply::CommandNotSupported as u8]);
        }
    }

    #[tokio::test]
    async fn unknown_address_type_is_refused() {
        let (r, reply) = run(&[5, 1, 0, 5, 1, 0, 9, 0]).await;
        assert!(matches!(r, Err(SocksError::UnsupportedAddress)));
        assert_eq!(reply[3], Reply::AddressTypeNotSupported as u8);
    }

    #[tokio::test]
    async fn empty_or_non_utf8_domain_is_rejected() {
        let (r, _) = run(&[5, 1, 0, 5, 1, 0, 3, 0, 0, 80]).await;
        assert!(matches!(r, Err(SocksError::InvalidAddress)));
        let (r, _) = run(&[5, 1, 0, 5, 1, 0, 3, 2, 0xff, 0xfe, 0, 80]).await;
        assert!(matches!(r, Err(SocksError::InvalidAddress)));
    }

    #[tokio::test]
    async fn truncated_input_is_an_io_error_not_a_panic() {
        let (r, _) = run(&[5, 1, 0, 5, 1, 0, 3, 20, b'a']).await;
        assert!(matches!(r, Err(SocksError::Io(_))));
    }

    #[tokio::test]
    async fn reply_is_ten_bytes_with_the_code() {
        let (mut a, mut b) = tokio::io::duplex(64);
        send_reply(&mut a, Reply::ConnectionRefused).await.unwrap();
        drop(a);
        let mut out = Vec::new();
        b.read_to_end(&mut out).await.unwrap();
        assert_eq!(out, vec![5, 5, 0, 1, 0, 0, 0, 0, 0, 0]);
    }
}

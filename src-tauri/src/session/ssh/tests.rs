use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use russh::ChannelOpenFailure;
use russh::keys::{Algorithm, PrivateKey, ssh_key::LineEnding};
use russh::server::{self, Auth, Msg, Server as _, Session, VerifiedPublicKey};
use russh::{Channel, ChannelId, Pty};
use tokio::net::TcpListener;
use tokio::time::timeout;
use zeroize::Zeroizing;

use super::*;
use crate::session::{HostKeyApprover, InMemoryKnownHosts, KnownHostsStore};

#[derive(Default)]
struct ServerState {
    window: Mutex<Option<(u32, u32)>>,
    pty_requested: Mutex<bool>,
    /// 受けた direct-tcpip（踏み台としての転送）要求 `(host, port)`。
    direct: Mutex<Vec<(String, u32)>>,
    /// 転送用のチャネル。シェルのエコー処理の対象にしない。
    forwarded: Mutex<std::collections::HashSet<ChannelId>>,
    /// パスワード認証の試行回数（踏み台にパスワードが送られていないことの確認用）。
    password_attempts: std::sync::atomic::AtomicUsize,
}

#[derive(Clone)]
struct MockServer {
    state: Arc<ServerState>,
    authorized_key: Option<russh::keys::PublicKey>,
    /// 踏み台としての転送（direct-tcpip）を許可するか。
    allow_forwarding: bool,
}

impl server::Server for MockServer {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}

impl server::Handler for MockServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        self.state
            .password_attempts
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if user == "alice" && password == "secret" {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        key: VerifiedPublicKey<'_>,
    ) -> Result<Auth, Self::Error> {
        match &self.authorized_key {
            Some(k) if user == "alice" && k == key.public_key => Ok(Auth::Accept),
            _ => Ok(Auth::reject()),
        }
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.state
            .direct
            .lock()
            .unwrap()
            .push((host_to_connect.to_owned(), port_to_connect));
        self.state.forwarded.lock().unwrap().insert(channel.id());
        if !self.allow_forwarding {
            reply
                .reject(ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        }
        match tokio::net::TcpStream::connect((host_to_connect, port_to_connect as u16)).await {
            Ok(mut tcp) => {
                reply.accept().await;
                tokio::spawn(async move {
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut stream, &mut tcp).await;
                });
            }
            Err(_) => reply.reject(ChannelOpenFailure::ConnectFailed).await,
        }
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        col: u32,
        row: u32,
        _pw: u32,
        _ph: u32,
        _modes: &[(Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        *self.state.pty_requested.lock().unwrap() = true;
        *self.state.window.lock().unwrap() = Some((col, row));
        session.channel_success(channel)
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(channel, b"welcome\r\n".to_vec())
    }

    async fn window_change_request(
        &mut self,
        _channel: ChannelId,
        col: u32,
        row: u32,
        _pw: u32,
        _ph: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        *self.state.window.lock().unwrap() = Some((col, row));
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.state.forwarded.lock().unwrap().contains(&channel) {
            // 転送チャネルのデータは、チャネルのストリーム側が処理する。
            return Ok(());
        }
        if data == b"drop" {
            // 接続を異常切断する（チャネルのCloseを送らない）。
            return Err(russh::Error::Disconnect);
        }
        if data == b"exit\n" {
            session.eof(channel)?;
            session.close(channel)?;
        } else {
            session.data(channel, data.to_vec())?;
        }
        Ok(())
    }
}

struct Harness {
    port: u16,
    state: Arc<ServerState>,
    host_fingerprint: String,
}

async fn start_server(authorized_key: Option<russh::keys::PublicKey>) -> Harness {
    start_server_with(authorized_key, false).await
}

async fn start_server_with(
    authorized_key: Option<russh::keys::PublicKey>,
    allow_forwarding: bool,
) -> Harness {
    let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let host_fingerprint = host_key
        .public_key()
        .fingerprint(russh::keys::HashAlg::Sha256)
        .to_string();
    let config = Arc::new(server::Config {
        keys: vec![host_key],
        auth_rejection_time: Duration::from_millis(1),
        auth_rejection_time_initial: Some(Duration::from_millis(0)),
        ..Default::default()
    });
    let state = Arc::new(ServerState::default());
    let mut srv = MockServer {
        state: state.clone(),
        authorized_key,
        allow_forwarding,
    };
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = srv.run_on_socket(config, &listener).await;
    });
    Harness {
        port,
        state,
        host_fingerprint,
    }
}

struct Approve(bool);

#[async_trait]
impl HostKeyApprover for Approve {
    async fn approve_unknown(&self, _: &str, _: u16, _: &str) -> bool {
        self.0
    }
}

fn config(port: u16, auth: SshAuth) -> SshConfig {
    SshConfig {
        host: "127.0.0.1".into(),
        port,
        username: "alice".into(),
        auth,
        size: TerminalSize::new(80, 24).unwrap(),
        term: "xterm-256color".into(),
        keepalive_interval: Some(Duration::from_secs(30)),
        jump_hosts: vec![],
    }
}

fn password(p: &str) -> SshAuth {
    SshAuth::Password(Zeroizing::new(p.into()))
}

async fn connect(
    h: &Harness,
    auth: SshAuth,
    hosts: Arc<InMemoryKnownHosts>,
    approve: bool,
) -> Result<SshSession, TerminalError> {
    SshSession::connect(config(h.port, auth), hosts, Arc::new(Approve(approve))).await
}

async fn read_until(s: &mut SshSession, needle: &str) -> String {
    let mut out = Vec::new();
    let r = timeout(Duration::from_secs(5), async {
        while let Some(c) = s.read().await.unwrap() {
            out.extend(c);
            if String::from_utf8_lossy(&out).contains(needle) {
                break;
            }
        }
    })
    .await;
    assert!(
        r.is_ok(),
        "タイムアウト: {:?}",
        String::from_utf8_lossy(&out)
    );
    String::from_utf8_lossy(&out).into_owned()
}

#[tokio::test]
async fn password_login_echo_and_pty() {
    let h = start_server(None).await;
    let hosts = Arc::new(InMemoryKnownHosts::default());
    let mut s = connect(&h, password("secret"), hosts.clone(), true)
        .await
        .unwrap();
    read_until(&mut s, "welcome").await;
    s.write(b"ping\n").await.unwrap();
    read_until(&mut s, "ping").await;
    assert!(*h.state.pty_requested.lock().unwrap());
    assert_eq!(*h.state.window.lock().unwrap(), Some((80, 24)));
    // 承認されたホスト鍵が保存される
    assert_eq!(
        hosts.lookup("127.0.0.1", h.port).unwrap().as_deref(),
        Some(h.host_fingerprint.as_str())
    );
    s.close().await.unwrap();
}

#[tokio::test]
async fn wrong_password_is_authentication_failure() {
    let h = start_server(None).await;
    let r = connect(
        &h,
        password("wrong"),
        Arc::new(InMemoryKnownHosts::default()),
        true,
    )
    .await;
    assert!(matches!(r, Err(TerminalError::AuthenticationFailed(_))));
}

#[tokio::test]
async fn unapproved_unknown_host_is_rejected() {
    let h = start_server(None).await;
    let hosts = Arc::new(InMemoryKnownHosts::default());
    let r = connect(&h, password("secret"), hosts.clone(), false).await;
    assert!(matches!(r, Err(TerminalError::HostKeyRejected(_))));
    assert!(hosts.lookup("127.0.0.1", h.port).unwrap().is_none());
}

#[tokio::test]
async fn changed_host_key_is_rejected_even_if_user_would_approve() {
    let h = start_server(None).await;
    let hosts = Arc::new(InMemoryKnownHosts::default());
    hosts.save("127.0.0.1", h.port, "SHA256:other").unwrap();
    let r = connect(&h, password("secret"), hosts, true).await;
    assert!(matches!(r, Err(TerminalError::HostKeyRejected(_))));
}

#[tokio::test]
async fn resize_sends_window_change() {
    let h = start_server(None).await;
    let mut s = connect(
        &h,
        password("secret"),
        Arc::new(InMemoryKnownHosts::default()),
        true,
    )
    .await
    .unwrap();
    s.resize(TerminalSize::new(132, 43).unwrap()).await.unwrap();
    // サーバー側の反映を待つ
    let r = timeout(Duration::from_secs(5), async {
        while *h.state.window.lock().unwrap() != Some((132, 43)) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(r.is_ok());
}

#[tokio::test]
async fn read_ends_when_remote_closes_channel() {
    let h = start_server(None).await;
    let mut s = connect(
        &h,
        password("secret"),
        Arc::new(InMemoryKnownHosts::default()),
        true,
    )
    .await
    .unwrap();
    s.write(b"exit\n").await.unwrap();
    let r = timeout(Duration::from_secs(5), async {
        while s.read().await.unwrap().is_some() {}
    })
    .await;
    assert!(r.is_ok());
    assert!(matches!(s.write(b"x").await, Err(TerminalError::Closed)));
}

#[tokio::test]
async fn close_is_idempotent_and_blocks_further_use() {
    let h = start_server(None).await;
    let mut s = connect(
        &h,
        password("secret"),
        Arc::new(InMemoryKnownHosts::default()),
        true,
    )
    .await
    .unwrap();
    s.close().await.unwrap();
    s.close().await.unwrap();
    assert!(matches!(s.write(b"x").await, Err(TerminalError::Closed)));
    assert!(matches!(
        s.resize(TerminalSize::new(80, 24).unwrap()).await,
        Err(TerminalError::Closed)
    ));
}

fn write_key(dir: &std::path::Path, key: &PrivateKey) -> PathBuf {
    let path = dir.join("id_ed25519");
    std::fs::write(&path, key.to_openssh(LineEnding::LF).unwrap()).unwrap();
    path
}

#[tokio::test]
async fn private_key_login() {
    let user_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let dir = std::env::temp_dir().join(format!("linkterm-ssh-key-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = write_key(&dir, &user_key);

    let h = start_server(Some(user_key.public_key().clone())).await;
    let mut s = connect(
        &h,
        SshAuth::PrivateKey {
            path: path.clone(),
            passphrase: None,
        },
        Arc::new(InMemoryKnownHosts::default()),
        true,
    )
    .await
    .unwrap();
    read_until(&mut s, "welcome").await;

    // 別の鍵では認証できない
    let other = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let other_path = dir.join("other");
    std::fs::write(&other_path, other.to_openssh(LineEnding::LF).unwrap()).unwrap();
    let r = connect(
        &h,
        SshAuth::PrivateKey {
            path: other_path,
            passphrase: None,
        },
        Arc::new(InMemoryKnownHosts::default()),
        true,
    )
    .await;
    assert!(matches!(r, Err(TerminalError::AuthenticationFailed(_))));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn missing_key_file_is_authentication_error_with_context() {
    let h = start_server(None).await;
    let r = connect(
        &h,
        SshAuth::PrivateKey {
            path: "/nonexistent/key".into(),
            passphrase: None,
        },
        Arc::new(InMemoryKnownHosts::default()),
        true,
    )
    .await;
    match r {
        Err(TerminalError::AuthenticationFailed(m)) => assert!(m.contains("/nonexistent/key")),
        other => panic!("unexpected: {:?}", other.err()),
    }
}

#[tokio::test]
async fn connection_refused_is_connection_failed() {
    // 使われていないポートを確保してから解放する
    let l = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = l.local_addr().unwrap().port();
    drop(l);
    let r = SshSession::connect(
        config(port, password("secret")),
        Arc::new(InMemoryKnownHosts::default()),
        Arc::new(Approve(true)),
    )
    .await;
    assert!(matches!(r, Err(TerminalError::ConnectionFailed(_))));
}

#[tokio::test]
async fn abrupt_disconnect_is_reported_as_an_error_not_a_clean_eof() {
    let h = start_server(None).await;
    let mut s = connect(
        &h,
        password("secret"),
        Arc::new(InMemoryKnownHosts::default()),
        true,
    )
    .await
    .unwrap();
    s.write(b"drop").await.unwrap();
    let r = timeout(Duration::from_secs(5), async {
        loop {
            match s.read().await {
                Ok(Some(_)) => continue,
                other => return other,
            }
        }
    })
    .await
    .expect("タイムアウト");
    assert!(
        matches!(r, Err(TerminalError::Disconnected(_))),
        "予期しない切断はエラーとして伝わるべき: {r:?}"
    );
}

// ---- 踏み台（ProxyJump） ----

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("linkterm-jump-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 鍵を作り、秘密鍵ファイルのパスと公開鍵を返す。
fn new_key(dir: &std::path::Path, file: &str) -> (PathBuf, russh::keys::PublicKey) {
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let path = dir.join(file);
    std::fs::write(&path, key.to_openssh(LineEnding::LF).unwrap()).unwrap();
    (path, key.public_key().clone())
}

fn jump(h: &Harness, identity: Option<&PathBuf>) -> JumpHost {
    JumpHost {
        host: "127.0.0.1".into(),
        port: h.port,
        username: "alice".into(),
        identity_files: identity.cloned().into_iter().collect(),
    }
}

async fn connect_via(
    target: &Harness,
    jumps: Vec<JumpHost>,
    auth: SshAuth,
    hosts: Arc<InMemoryKnownHosts>,
    approve: bool,
) -> Result<SshSession, TerminalError> {
    let mut cfg = config(target.port, auth);
    cfg.jump_hosts = jumps;
    SshSession::connect(cfg, hosts, Arc::new(Approve(approve))).await
}

#[tokio::test]
async fn connects_through_a_jump_host_without_sending_the_password_to_it() {
    let dir = temp_dir("basic");
    let (key_path, public) = new_key(&dir, "jump_key");
    let target = start_server(None).await;
    let bastion = start_server_with(Some(public), true).await;
    let hosts = Arc::new(InMemoryKnownHosts::default());
    let mut s = connect_via(
        &target,
        vec![jump(&bastion, Some(&key_path))],
        password("secret"),
        hosts.clone(),
        true,
    )
    .await
    .unwrap();
    read_until(&mut s, "welcome").await;
    s.write(b"ping\n").await.unwrap();
    read_until(&mut s, "ping").await;

    // 目的のホストへは、踏み台の転送を通って接続している。
    assert_eq!(
        *bastion.state.direct.lock().unwrap(),
        vec![("127.0.0.1".to_string(), target.port as u32)]
    );
    // 踏み台にはパスワード認証を試みていない（目的のホストのパスワードを漏らさない）。
    assert_eq!(
        bastion
            .state
            .password_attempts
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    // 各ホストの鍵がそれぞれ確認・保存されている。
    assert_eq!(
        hosts.lookup("127.0.0.1", bastion.port).unwrap().as_deref(),
        Some(bastion.host_fingerprint.as_str())
    );
    assert_eq!(
        hosts.lookup("127.0.0.1", target.port).unwrap().as_deref(),
        Some(target.host_fingerprint.as_str())
    );
    s.close().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn chains_through_multiple_jump_hosts_in_order() {
    let dir = temp_dir("chain");
    let (key_path, public) = new_key(&dir, "jump_key");
    let target = start_server(None).await;
    let second = start_server_with(Some(public.clone()), true).await;
    let first = start_server_with(Some(public), true).await;
    let mut s = connect_via(
        &target,
        vec![
            jump(&first, Some(&key_path)),
            jump(&second, Some(&key_path)),
        ],
        password("secret"),
        Arc::new(InMemoryKnownHosts::default()),
        true,
    )
    .await
    .unwrap();
    read_until(&mut s, "welcome").await;
    assert_eq!(
        *first.state.direct.lock().unwrap(),
        vec![("127.0.0.1".to_string(), second.port as u32)]
    );
    assert_eq!(
        *second.state.direct.lock().unwrap(),
        vec![("127.0.0.1".to_string(), target.port as u32)]
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn the_targets_private_key_is_also_tried_on_the_jump_host() {
    let dir = temp_dir("samekey");
    let (key_path, public) = new_key(&dir, "shared_key");
    let target = start_server(Some(public.clone())).await;
    let bastion = start_server_with(Some(public), true).await;
    let mut s = connect_via(
        &target,
        vec![jump(&bastion, None)], // 踏み台には鍵を指定していない
        SshAuth::PrivateKey {
            path: key_path,
            passphrase: None,
        },
        Arc::new(InMemoryKnownHosts::default()),
        true,
    )
    .await
    .unwrap();
    read_until(&mut s, "welcome").await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn jump_host_authentication_failure_names_the_jump_host_and_never_contacts_the_target() {
    let dir = temp_dir("authfail");
    let (key_path, _unauthorized) = new_key(&dir, "wrong_key");
    let (_, other_public) = new_key(&dir, "other_key");
    let target = start_server(None).await;
    let bastion = start_server_with(Some(other_public), true).await;
    let r = connect_via(
        &target,
        vec![jump(&bastion, Some(&key_path))],
        password("secret"),
        Arc::new(InMemoryKnownHosts::default()),
        true,
    )
    .await;
    match r {
        Err(TerminalError::AuthenticationFailed(m)) => {
            assert!(m.contains("踏み台"), "{m}");
            assert!(m.contains(&bastion.port.to_string()), "{m}");
        }
        other => panic!("unexpected: {:?}", other.err()),
    }
    assert!(target.state.direct.lock().unwrap().is_empty());
    assert_eq!(
        target
            .state
            .password_attempts
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_jump_host_that_forbids_forwarding_is_reported() {
    let dir = temp_dir("noforward");
    let (key_path, public) = new_key(&dir, "jump_key");
    let target = start_server(None).await;
    let bastion = start_server_with(Some(public), false).await;
    let r = connect_via(
        &target,
        vec![jump(&bastion, Some(&key_path))],
        password("secret"),
        Arc::new(InMemoryKnownHosts::default()),
        true,
    )
    .await;
    match r {
        Err(TerminalError::ConnectionFailed(m)) => {
            assert!(m.contains("踏み台"), "{m}");
            assert!(m.contains("転送"), "{m}");
        }
        other => panic!("unexpected: {:?}", other.err()),
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn an_unreachable_jump_host_is_a_connection_failure_mentioning_it() {
    let l = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let dead_port = l.local_addr().unwrap().port();
    drop(l);
    let target = start_server(None).await;
    let r = connect_via(
        &target,
        vec![JumpHost {
            host: "127.0.0.1".into(),
            port: dead_port,
            username: "alice".into(),
            identity_files: vec![],
        }],
        password("secret"),
        Arc::new(InMemoryKnownHosts::default()),
        true,
    )
    .await;
    match r {
        Err(TerminalError::ConnectionFailed(m)) => {
            assert!(m.contains(&dead_port.to_string()), "{m}")
        }
        other => panic!("unexpected: {:?}", other.err()),
    }
}

#[tokio::test]
async fn an_unapproved_jump_host_key_stops_the_connection_before_the_target() {
    let dir = temp_dir("hostkey");
    let (key_path, public) = new_key(&dir, "jump_key");
    let target = start_server(None).await;
    let bastion = start_server_with(Some(public), true).await;
    let hosts = Arc::new(InMemoryKnownHosts::default());
    let r = connect_via(
        &target,
        vec![jump(&bastion, Some(&key_path))],
        password("secret"),
        hosts.clone(),
        false,
    )
    .await;
    match r {
        Err(TerminalError::HostKeyRejected(m)) => {
            assert!(m.contains(&bastion.port.to_string()), "{m}")
        }
        other => panic!("unexpected: {:?}", other.err()),
    }
    assert!(hosts.lookup("127.0.0.1", target.port).unwrap().is_none());
    assert!(bastion.state.direct.lock().unwrap().is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_changed_host_key_on_a_jump_host_is_rejected() {
    let dir = temp_dir("hostkey-changed");
    let (key_path, public) = new_key(&dir, "jump_key");
    let target = start_server(None).await;
    let bastion = start_server_with(Some(public), true).await;
    let hosts = Arc::new(InMemoryKnownHosts::default());
    hosts
        .save("127.0.0.1", bastion.port, "SHA256:other")
        .unwrap();
    let r = connect_via(
        &target,
        vec![jump(&bastion, Some(&key_path))],
        password("secret"),
        hosts,
        true,
    )
    .await;
    assert!(matches!(r, Err(TerminalError::HostKeyRejected(_))));
    let _ = std::fs::remove_dir_all(dir);
}

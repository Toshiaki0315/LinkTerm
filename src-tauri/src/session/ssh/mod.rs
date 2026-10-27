//! `russh` によるSSHセッション。
//!
//! チャネルは専用タスクが所有し、読み書き・リサイズ・終了はメッセージ経由で行う。
//! これにより受信待ち中でも送信できる。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use russh::client::{self, Handle, Msg};
use russh::keys::{HashAlg, PublicKey, load_secret_key};
use russh::{Channel, ChannelMsg, Disconnect, keys::PublicKeyOrCertificate};
use tokio::sync::mpsc;
use zeroize::Zeroizing;

use super::{
    HostKeyApprover, KnownHostsStore, TerminalError, TerminalSession, TerminalSize, verify_host_key,
};

const OUTPUT_CAPACITY: usize = 64;
const COMMAND_CAPACITY: usize = 64;
/// 応答のないキープアライブがこの回数続いたら切断とみなす。
const KEEPALIVE_MAX: usize = 3;

pub enum SshAuth {
    Password(Zeroizing<String>),
    PrivateKey {
        path: PathBuf,
        passphrase: Option<Zeroizing<String>>,
    },
    /// `SSH_AUTH_SOCK` のSSH Agentを使う。
    Agent,
}

/// 踏み台（ProxyJump）の1段分。目的のホストへは、この踏み台を通って接続する。
///
/// 踏み台の認証には、SSH Agent・`identity_files`・（鍵認証なら）目的のホストと同じ鍵を、この順に試す。
/// 目的のホストのパスワードは、踏み台には絶対に送らない。
#[derive(Debug, Clone)]
pub struct JumpHost {
    pub host: String,
    pub port: u16,
    pub username: String,
    /// 試す秘密鍵（パスフレーズなしで読めるもの）。
    pub identity_files: Vec<PathBuf>,
}

pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    pub size: TerminalSize,
    pub term: String,
    pub keepalive_interval: Option<Duration>,
    /// 経由する踏み台。先頭から順に接続する。
    pub jump_hosts: Vec<JumpHost>,
    /// ローカルポートフォワード（`-L`）。
    pub forwards: Vec<LocalForward>,
}

/// ローカルポートフォワード（`ssh -L bind_port:dest_host:dest_port`）。
/// 待ち受けは安全のため 127.0.0.1 に限る。`bind_port` が 0 なら空いているポートが割り当てられる。
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalForward {
    pub bind_port: u16,
    pub dest_host: String,
    pub dest_port: u16,
}

/// ホスト鍵を検証するクライアントハンドラ。拒否理由は呼び出し側へ伝えるため共有する。
struct ClientHandler {
    host: String,
    port: u16,
    known_hosts: Arc<dyn KnownHostsStore>,
    approver: Arc<dyn HostKeyApprover>,
    rejection: Arc<Mutex<Option<TerminalError>>>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fingerprint = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.fingerprint(HashAlg::Sha256),
            PublicKeyOrCertificate::Certificate(cert) => {
                cert.public_key().fingerprint(HashAlg::Sha256)
            }
        }
        .to_string();
        match verify_host_key(
            self.known_hosts.as_ref(),
            self.approver.as_ref(),
            &self.host,
            self.port,
            &fingerprint,
        )
        .await
        {
            Ok(()) => Ok(true),
            Err(e) => {
                if let Ok(mut slot) = self.rejection.lock() {
                    *slot = Some(e);
                }
                Ok(false)
            }
        }
    }
}

enum Command {
    Data(Vec<u8>),
    Resize(TerminalSize),
    Close,
}

type Output = Result<Vec<u8>, TerminalError>;

pub struct SshSession {
    forward_addrs: Vec<std::net::SocketAddr>,
    commands: mpsc::Sender<Command>,
    output: mpsc::Receiver<Output>,
    closed: bool,
}

fn auth_failed(context: impl std::fmt::Display, e: impl std::fmt::Display) -> TerminalError {
    TerminalError::AuthenticationFailed(format!("{context}: {e}"))
}

async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    auth: &SshAuth,
) -> Result<(), TerminalError> {
    let result = match auth {
        SshAuth::Password(password) => handle
            .authenticate_password(user, password.as_str())
            .await
            .map_err(|e| auth_failed("パスワード認証", e))?,
        SshAuth::PrivateKey { path, passphrase } => {
            authenticate_with_key(
                handle,
                user,
                path,
                passphrase.as_deref().map(String::as_str),
            )
            .await?
        }
        SshAuth::Agent => authenticate_with_agent(handle, user).await?,
    };
    if result.success() {
        Ok(())
    } else {
        Err(TerminalError::AuthenticationFailed(format!(
            "サーバーが {user} の認証を拒否しました"
        )))
    }
}

/// 秘密鍵ファイルで公開鍵認証する。
async fn authenticate_with_key(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    path: &std::path::Path,
    passphrase: Option<&str>,
) -> Result<client::AuthResult, TerminalError> {
    let key = load_secret_key(path, passphrase)
        .map_err(|e| auth_failed(format!("秘密鍵 {} の読み込み", path.display()), e))?;
    let hash = handle
        .best_supported_rsa_hash()
        .await
        .map_err(|e| auth_failed("RSAハッシュの選択", e))?
        .flatten();
    handle
        .authenticate_publickey(
            user,
            russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash),
        )
        .await
        .map_err(|e| auth_failed("公開鍵認証", e))
}

/// 踏み台を認証する。SSH Agent → 設定の鍵 → 目的のホストと同じ鍵、の順に試す。
///
/// 目的のホストのパスワードは、踏み台には使わない（別のホストへ漏らさないため）。
async fn authenticate_jump(
    handle: &mut Handle<ClientHandler>,
    hop: &JumpHost,
    target_auth: &SshAuth,
) -> Result<(), TerminalError> {
    let mut tried: Vec<String> = Vec::new();
    // Agent が無い・鍵がない場合は、黙って次の方法へ進む。
    match authenticate_with_agent(handle, &hop.username).await {
        Ok(result) if result.success() => return Ok(()),
        Ok(_) => tried.push("SSH Agent".into()),
        Err(_) => {}
    }
    let mut candidates: Vec<(&std::path::Path, Option<&str>)> = hop
        .identity_files
        .iter()
        .map(|p| (p.as_path(), None))
        .collect();
    if let SshAuth::PrivateKey { path, passphrase } = target_auth {
        candidates.push((path.as_path(), passphrase.as_deref().map(String::as_str)));
    }
    for (path, passphrase) in candidates {
        if !path.exists() {
            continue;
        }
        match authenticate_with_key(handle, &hop.username, path, passphrase).await {
            Ok(result) if result.success() => return Ok(()),
            Ok(_) => tried.push(path.display().to_string()),
            // 読み込めない鍵（パスフレーズつき等）は飛ばす。
            Err(_) => tried.push(format!("{}（読み込めません）", path.display())),
        }
    }
    let tried = if tried.is_empty() {
        "使える鍵がありません".to_owned()
    } else {
        tried.join(", ")
    };
    Err(TerminalError::AuthenticationFailed(format!(
        "踏み台 {}:{} の認証に失敗しました（試した方法: {tried}）",
        hop.host, hop.port
    )))
}

async fn authenticate_with_agent(
    handle: &mut Handle<ClientHandler>,
    user: &str,
) -> Result<client::AuthResult, TerminalError> {
    let mut agent = russh::keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|e| auth_failed("SSH Agentへの接続", e))?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| auth_failed("SSH Agentの鍵一覧の取得", e))?;
    let mut last = None;
    for identity in identities {
        let Some(key) = agent_public_key(&identity) else {
            continue;
        };
        let result = handle
            .authenticate_publickey_with(user, key, None, &mut agent)
            .await
            .map_err(|e| auth_failed("SSH Agentによる認証", e))?;
        let success = result.success();
        last = Some(result);
        if success {
            break;
        }
    }
    last.ok_or_else(|| {
        TerminalError::AuthenticationFailed("SSH Agentに利用可能な鍵がありません".into())
    })
}

fn agent_public_key(identity: &russh::keys::agent::AgentIdentity) -> Option<PublicKey> {
    match identity {
        russh::keys::agent::AgentIdentity::PublicKey { key, .. } => Some(key.clone()),
        _ => None,
    }
}

/// 接続する1段。
enum Hop<'a> {
    Jump(&'a JumpHost),
    Target { host: &'a str, port: u16 },
}

impl Hop<'_> {
    fn address(&self) -> (&str, u16) {
        match self {
            Hop::Jump(j) => (&j.host, j.port),
            Hop::Target { host, port } => (host, *port),
        }
    }

    /// エラーメッセージに入れる、接続先の説明。
    fn label(&self) -> String {
        let (host, port) = self.address();
        match self {
            Hop::Jump(_) => format!("踏み台 {host}:{port}"),
            Hop::Target { .. } => format!("{host}:{port}"),
        }
    }
}

/// 1つのホストへ接続する。`via` があれば、その踏み台を通って（direct-tcpip で）接続する。
/// ホスト鍵は、このホストのものを確認する。
async fn open_hop(
    via: Option<(&Handle<ClientHandler>, &JumpHost)>,
    hop: Hop<'_>,
    client_config: Arc<client::Config>,
    known_hosts: Arc<dyn KnownHostsStore>,
    approver: Arc<dyn HostKeyApprover>,
) -> Result<Handle<ClientHandler>, TerminalError> {
    let (host, port) = hop.address();
    let rejection = Arc::new(Mutex::new(None));
    let handler = ClientHandler {
        host: host.to_owned(),
        port,
        known_hosts,
        approver,
        rejection: rejection.clone(),
    };
    let connected = match via {
        None => client::connect(client_config, (host, port), handler).await,
        Some((previous, previous_hop)) => {
            let channel = previous
                .channel_open_direct_tcpip(host, u32::from(port), "127.0.0.1", 0)
                .await
                .map_err(|e| {
                    TerminalError::ConnectionFailed(format!(
                        "踏み台 {}:{} が {host}:{port} への転送を許可しませんでした: {e}",
                        previous_hop.host, previous_hop.port
                    ))
                })?;
            client::connect_stream(client_config, channel.into_stream(), handler).await
        }
    };
    // ホスト鍵が拒否された場合、russh側のエラーより具体的な理由を優先する。
    if let Some(e) = rejection.lock().ok().and_then(|mut r| r.take()) {
        return Err(e);
    }
    connected.map_err(|e| TerminalError::ConnectionFailed(format!("{} への接続: {e}", hop.label())))
}

impl SshSession {
    /// ローカルポートフォワードの実際の待ち受けアドレス（設定の順）。
    pub fn forward_addrs(&self) -> &[std::net::SocketAddr] {
        &self.forward_addrs
    }

    /// ローカルポートフォワードの実際の待ち受けポート（設定の順）。
    pub fn forward_ports(&self) -> Vec<u16> {
        self.forward_addrs.iter().map(|a| a.port()).collect()
    }

    pub async fn connect(
        config: SshConfig,
        known_hosts: Arc<dyn KnownHostsStore>,
        approver: Arc<dyn HostKeyApprover>,
    ) -> Result<Self, TerminalError> {
        let client_config = Arc::new(client::Config {
            keepalive_interval: config.keepalive_interval,
            keepalive_max: KEEPALIVE_MAX,
            ..Default::default()
        });

        // 踏み台を順に経由する。各ホストの鍵は、それぞれ確認・保存する。
        let mut jumps: Vec<Handle<ClientHandler>> = Vec::new();
        for hop in &config.jump_hosts {
            let via = jumps.last().zip(
                jumps
                    .len()
                    .checked_sub(1)
                    .and_then(|i| config.jump_hosts.get(i)),
            );
            let mut handle = open_hop(
                via,
                Hop::Jump(hop),
                client_config.clone(),
                known_hosts.clone(),
                approver.clone(),
            )
            .await?;
            authenticate_jump(&mut handle, hop, &config.auth).await?;
            jumps.push(handle);
        }
        let via = jumps.last().zip(config.jump_hosts.last());
        let mut handle = open_hop(
            via,
            Hop::Target {
                host: &config.host,
                port: config.port,
            },
            client_config,
            known_hosts,
            approver,
        )
        .await?;

        authenticate(&mut handle, &config.username, &config.auth).await?;

        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| TerminalError::ConnectionFailed(format!("チャネルを開けません: {e}")))?;
        channel
            .request_pty(
                false,
                &config.term,
                config.size.cols.into(),
                config.size.rows.into(),
                0,
                0,
                &[],
            )
            .await
            .map_err(|e| TerminalError::ConnectionFailed(format!("PTY要求に失敗: {e}")))?;
        channel
            .request_shell(false)
            .await
            .map_err(|e| TerminalError::ConnectionFailed(format!("シェル要求に失敗: {e}")))?;

        let handle = Arc::new(handle);
        let (forwarders, forward_addrs) = start_forwards(&handle, &config.forwards).await?;

        let (cmd_tx, cmd_rx) = mpsc::channel(COMMAND_CAPACITY);
        let (out_tx, out_rx) = mpsc::channel(OUTPUT_CAPACITY);
        tokio::spawn(pump(handle, jumps, forwarders, channel, cmd_rx, out_tx));

        Ok(Self {
            forward_addrs,
            commands: cmd_tx,
            output: out_rx,
            closed: false,
        })
    }
}

/// ローカルポートフォワードの待ち受けを始める。全部の待ち受けに成功しなければエラー。
async fn start_forwards(
    handle: &Arc<Handle<ClientHandler>>,
    forwards: &[LocalForward],
) -> Result<(Vec<tokio::task::JoinHandle<()>>, Vec<std::net::SocketAddr>), TerminalError> {
    let mut listeners = Vec::new();
    for forward in forwards {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", forward.bind_port))
            .await
            .map_err(|e| {
                TerminalError::ConnectionFailed(format!(
                    "ポートフォワード 127.0.0.1:{} を待ち受けできません: {e}",
                    forward.bind_port
                ))
            })?;
        listeners.push((listener, forward.clone()));
    }
    let mut tasks = Vec::new();
    let mut addrs = Vec::new();
    for (listener, forward) in listeners {
        addrs.push(
            listener
                .local_addr()
                .map_err(|e| TerminalError::io("ポートフォワードの待ち受けアドレスの取得", e))?,
        );
        tasks.push(tokio::spawn(forward_accept_loop(
            listener,
            forward,
            handle.clone(),
        )));
    }
    Ok((tasks, addrs))
}

/// 接続を受け付け、1接続ごとにSSHのdirect-tcpipチャネルへ中継する。
/// このタスクが止まると、`JoinSet` の破棄で中継中の接続もまとめて止まる。
async fn forward_accept_loop(
    listener: tokio::net::TcpListener,
    forward: LocalForward,
    handle: Arc<Handle<ClientHandler>>,
) {
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((mut socket, peer)) = accepted else { break };
                let handle = handle.clone();
                let forward = forward.clone();
                connections.spawn(async move {
                    // 転送先に繋がらなければ、この接続だけを閉じる。
                    let Ok(channel) = handle
                        .channel_open_direct_tcpip(
                            forward.dest_host.as_str(),
                            u32::from(forward.dest_port),
                            "127.0.0.1",
                            u32::from(peer.port()),
                        )
                        .await
                    else {
                        return;
                    };
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                });
            }
            // 終わった接続のタスクを回収する。
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
}

/// チャネルの入出力を仲介する。
///
/// 正常終了（リモートの `Close`、またはこちらからの終了要求）では `output` を閉じるだけにし、
/// 送信失敗や予期しない切断はエラーとして `output` へ流して読み取り側へ理由を伝える。
async fn pump(
    handle: Arc<Handle<ClientHandler>>,
    // 目的のホストへの通り道。セッションが終わるまで保持する（閉じるとトンネルが切れる）。
    jumps: Vec<Handle<ClientHandler>>,
    // ポートフォワードの待ち受け。セッションの終了とともに止める。
    forwarders: Vec<tokio::task::JoinHandle<()>>,
    mut channel: Channel<Msg>,
    mut commands: mpsc::Receiver<Command>,
    output: mpsc::Sender<Output>,
) {
    let failure: Option<TerminalError> = loop {
        tokio::select! {
            cmd = commands.recv() => match cmd {
                Some(Command::Data(data)) => {
                    if let Err(e) = channel.data(&data[..]).await {
                        break Some(TerminalError::Disconnected(format!("SSH送信に失敗しました: {e}")));
                    }
                }
                Some(Command::Resize(size)) => {
                    if let Err(e) = channel
                        .window_change(size.cols.into(), size.rows.into(), 0, 0)
                        .await
                    {
                        break Some(TerminalError::Disconnected(format!(
                            "SSHのリサイズ通知に失敗しました: {e}"
                        )));
                    }
                }
                Some(Command::Close) | None => break None,
            },
            msg = channel.wait() => match msg {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    if output.send(Ok(data.to_vec())).await.is_err() {
                        break None;
                    }
                }
                Some(ChannelMsg::Close) => break None,
                // Close を受け取らずに受信が尽きた = 接続が途中で切れた。
                None => break Some(TerminalError::Disconnected(
                    "リモートから予期せず切断されました".into(),
                )),
                Some(_) => {}
            },
        }
    };
    if let Some(e) = failure {
        // 読み取り側が既にいなければ通知先はない。
        let _ = output.send(Err(e)).await;
    }
    for forwarder in &forwarders {
        forwarder.abort();
    }
    let _ = channel.close().await;
    let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
    for jump in jumps.iter().rev() {
        let _ = jump.disconnect(Disconnect::ByApplication, "", "en").await;
    }
}

#[async_trait]
impl TerminalSession for SshSession {
    async fn write(&mut self, data: &[u8]) -> Result<(), TerminalError> {
        if self.closed {
            return Err(TerminalError::Closed);
        }
        self.commands
            .send(Command::Data(data.to_vec()))
            .await
            .map_err(|_| TerminalError::Closed)
    }

    async fn read(&mut self) -> Result<Option<Vec<u8>>, TerminalError> {
        self.output.recv().await.transpose()
    }

    async fn resize(&mut self, size: TerminalSize) -> Result<(), TerminalError> {
        if self.closed {
            return Err(TerminalError::Closed);
        }
        self.commands
            .send(Command::Resize(size))
            .await
            .map_err(|_| TerminalError::Closed)
    }

    async fn close(&mut self) -> Result<(), TerminalError> {
        if !self.closed {
            self.closed = true;
            // 既にタスクが終了している場合は送信失敗してよい。
            let _ = self.commands.send(Command::Close).await;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;

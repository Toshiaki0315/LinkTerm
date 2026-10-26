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

pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    pub size: TerminalSize,
    pub term: String,
    pub keepalive_interval: Option<Duration>,
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
            let key = load_secret_key(path, passphrase.as_ref().map(|p| p.as_str()))
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
                .map_err(|e| auth_failed("公開鍵認証", e))?
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

impl SshSession {
    pub async fn connect(
        config: SshConfig,
        known_hosts: Arc<dyn KnownHostsStore>,
        approver: Arc<dyn HostKeyApprover>,
    ) -> Result<Self, TerminalError> {
        let rejection = Arc::new(Mutex::new(None));
        let handler = ClientHandler {
            host: config.host.clone(),
            port: config.port,
            known_hosts,
            approver,
            rejection: rejection.clone(),
        };
        let client_config = Arc::new(client::Config {
            keepalive_interval: config.keepalive_interval,
            keepalive_max: KEEPALIVE_MAX,
            ..Default::default()
        });

        let connected =
            client::connect(client_config, (config.host.as_str(), config.port), handler).await;
        // ホスト鍵が拒否された場合、russh側のエラーより具体的な理由を優先する。
        if let Some(e) = rejection.lock().ok().and_then(|mut r| r.take()) {
            return Err(e);
        }
        let mut handle = connected.map_err(|e| {
            TerminalError::ConnectionFailed(format!(
                "{}:{} への接続: {e}",
                config.host, config.port
            ))
        })?;

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

        let (cmd_tx, cmd_rx) = mpsc::channel(COMMAND_CAPACITY);
        let (out_tx, out_rx) = mpsc::channel(OUTPUT_CAPACITY);
        tokio::spawn(pump(handle, channel, cmd_rx, out_tx));

        Ok(Self {
            commands: cmd_tx,
            output: out_rx,
            closed: false,
        })
    }
}

/// チャネルの入出力を仲介する。
///
/// 正常終了（リモートの `Close`、またはこちらからの終了要求）では `output` を閉じるだけにし、
/// 送信失敗や予期しない切断はエラーとして `output` へ流して読み取り側へ理由を伝える。
async fn pump(
    handle: Handle<ClientHandler>,
    mut channel: Channel<Msg>,
    mut commands: mpsc::Receiver<Command>,
    output: mpsc::Sender<Output>,
) {
    let failure: Option<TerminalError> = loop {
        tokio::select! {
            cmd = commands.recv() => match cmd {
                Some(Command::Data(data)) => {
                    if let Err(e) = channel.data(&data[..]).await {
                        break Some(TerminalError::ConnectionFailed(format!("SSH送信に失敗しました: {e}")));
                    }
                }
                Some(Command::Resize(size)) => {
                    if let Err(e) = channel
                        .window_change(size.cols.into(), size.rows.into(), 0, 0)
                        .await
                    {
                        break Some(TerminalError::ConnectionFailed(format!(
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
                None => break Some(TerminalError::ConnectionFailed(
                    "SSH接続が予期せず切断されました".into(),
                )),
                Some(_) => {}
            },
        }
    };
    if let Some(e) = failure {
        // 読み取り側が既にいなければ通知先はない。
        let _ = output.send(Err(e)).await;
    }
    let _ = channel.close().await;
    let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
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

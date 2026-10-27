//! Tauri IPC（Commands / Events）。ロジックは `SessionManager` と各セッションに置き、ここは変換のみ行う。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use zeroize::Zeroizing;

use crate::approvals::{ApprovalBook, HostKeyRequest};
use crate::fonts::{FontError, FontFamily};
use crate::manager::{DisplayMode, EventSink, ManagerError, SessionManager};
use crate::profiles::{Profile, ProfileError, ProfileStore};
use crate::recent::{RecentConnection, RecentError, RecentStore};
use crate::session::{
    Codec, ControlSignal, CredentialStore, FileKnownHosts, HostKeyApprover, KeychainStore,
    LocalForward, LocalShellConfig, LocalShellSession, LogConfig, LogError, RemoteForward,
    RxNewline, SerialConfig, SerialSession, SessionLogger, SshAuth, SshConfig, SshSession,
    TelnetConfig, TelnetSession, TerminalError, TerminalSession, TerminalSize, TxNewline,
    list_ports,
};
use crate::session_state::{SessionState, SessionStateError, SessionStateStore};
use crate::settings::{Settings, SettingsError, SettingsStore};
use crate::ssh_config::{
    RequestedTarget, SshConfig as SshConfigFile, SshConfigError, build_jump_hosts,
    default_config_path, merge_forwards, merge_remote_forwards, pick_identity_file, resolve_target,
};

pub const EVENT_DATA: &str = "terminal-data";
pub const EVENT_CLOSED: &str = "terminal-closed";
pub const EVENT_LOG_ERROR: &str = "terminal-log-error";
pub const EVENT_ECHO: &str = "terminal-echo";
pub const EVENT_HOST_KEY_REQUEST: &str = "ssh-host-key-request";

const KEYCHAIN_SERVICE: &str = "com.linkterm.app";
const HOST_KEY_APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const SSH_KEEPALIVE: Duration = Duration::from_secs(30);
const DEFAULT_TERM: &str = "xterm-256color";
/// 選べる端末の種類（TERM）。リモートへ送る文字列なので、許可したものだけを通す。
const TERM_TYPES: &[&str] = &[
    "xterm-256color",
    "xterm",
    "vt100",
    "vt102",
    "vt220",
    "ansi",
    "linux",
];

/// フロントエンドへ返すエラー。文脈つきメッセージの文字列として渡す。
#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error(transparent)]
    Terminal(#[from] TerminalError),
    #[error(transparent)]
    Manager(#[from] ManagerError),
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Log(#[from] LogError),
    #[error(transparent)]
    Profile(#[from] ProfileError),
    #[error(transparent)]
    Settings(#[from] SettingsError),
    #[error(transparent)]
    Font(#[from] FontError),
    #[error(transparent)]
    SshConfig(#[from] SshConfigError),
    #[error(transparent)]
    SessionState(#[from] SessionStateError),
    #[error(transparent)]
    Recent(#[from] RecentError),
    #[error("認証情報の操作に失敗しました: {0}")]
    Credential(#[from] crate::session::CredentialError),
}

impl Serialize for CommandError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

type CommandResult<T> = Result<T, CommandError>;

#[derive(Clone, Serialize)]
struct DataPayload<'a> {
    id: &'a str,
    /// base64（生バイト列。エンコーディング変換はフロントで行う）
    data: String,
}

#[derive(Clone, Serialize)]
struct ClosedPayload<'a> {
    id: &'a str,
    reason: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EchoPayload<'a> {
    id: &'a str,
    remote_echo: bool,
}

#[derive(Clone, Serialize)]
struct LogErrorPayload<'a> {
    id: &'a str,
    message: &'a str,
}

struct TauriSink(AppHandle);

impl EventSink for TauriSink {
    fn data(&self, id: &str, data: &[u8]) {
        let payload = DataPayload {
            id,
            data: BASE64.encode(data),
        };
        if let Err(e) = self.0.emit(EVENT_DATA, payload) {
            eprintln!("イベント送信に失敗しました ({EVENT_DATA}): {e}");
        }
    }

    fn closed(&self, id: &str, reason: Option<String>) {
        if let Err(e) = self.0.emit(EVENT_CLOSED, ClosedPayload { id, reason }) {
            eprintln!("イベント送信に失敗しました ({EVENT_CLOSED}): {e}");
        }
    }

    fn echo_changed(&self, id: &str, remote_echo: bool) {
        if let Err(e) = self.0.emit(EVENT_ECHO, EchoPayload { id, remote_echo }) {
            eprintln!("イベント送信に失敗しました ({EVENT_ECHO}): {e}");
        }
    }

    fn log_error(&self, id: &str, message: &str) {
        if let Err(e) = self
            .0
            .emit(EVENT_LOG_ERROR, LogErrorPayload { id, message })
        {
            eprintln!("イベント送信に失敗しました ({EVENT_LOG_ERROR}): {e}");
        }
    }
}

/// 未知のホスト鍵をフロントのダイアログで承認させる。
struct TauriApprover {
    app: AppHandle,
    book: Arc<ApprovalBook>,
}

#[async_trait]
impl HostKeyApprover for TauriApprover {
    async fn approve_unknown(&self, host: &str, port: u16, fingerprint: &str) -> bool {
        let (request, rx) = self.book.register(host, port, fingerprint);
        let request_id = request.request_id.clone();
        // フロントの購読前でも `pending_host_key_requests` で取り込めるよう、登録してから通知する。
        if self.app.emit(EVENT_HOST_KEY_REQUEST, request).is_err() {
            self.book.cancel(&request_id);
            return false;
        }
        // タイムアウト・ウィンドウ破棄時は拒否（安全側）。
        let answer = tokio::time::timeout(HOST_KEY_APPROVAL_TIMEOUT, rx).await;
        self.book.cancel(&request_id);
        matches!(answer, Ok(Ok(true)))
    }
}

pub struct AppState {
    pub manager: SessionManager,
    known_hosts: Arc<FileKnownHosts>,
    credentials: KeychainStore,
    approver: Arc<TauriApprover>,
    approvals: Arc<ApprovalBook>,
    log_paths: LogPathReserver,
    profiles: ProfileStore,
    settings: SettingsStore,
    session_state: SessionStateStore,
    recent: RecentStore,
}

impl AppState {
    pub fn new(app: &AppHandle) -> Result<Self, tauri::Error> {
        let dir = app.path().app_data_dir()?;
        let approvals = Arc::new(ApprovalBook::default());
        Ok(Self {
            manager: SessionManager::new(Arc::new(TauriSink(app.clone()))),
            known_hosts: Arc::new(FileKnownHosts::new(dir.join("known_hosts.json"))),
            credentials: KeychainStore::new(KEYCHAIN_SERVICE),
            approver: Arc::new(TauriApprover {
                app: app.clone(),
                book: approvals.clone(),
            }),
            approvals,
            log_paths: LogPathReserver::default(),
            profiles: ProfileStore::new(dir.join("profiles.json")),
            settings: SettingsStore::new(dir.join("settings.json")),
            session_state: SessionStateStore::new(dir.join("session_state.json")),
            recent: RecentStore::new(dir.join("recent.json")),
        })
    }
}

/// 未指定なら `xterm-256color`。許可した種類以外は拒否する。
fn term_for(label: Option<&str>) -> CommandResult<String> {
    match label {
        None => Ok(DEFAULT_TERM.into()),
        Some(t) if TERM_TYPES.contains(&t) => Ok(t.into()),
        Some(t) => Err(CommandError::Invalid(format!(
            "未対応の端末の種類です: {t}"
        ))),
    }
}

fn size(cols: u16, rows: u16) -> CommandResult<TerminalSize> {
    Ok(TerminalSize::new(cols, rows)?)
}

/// 未指定ならUTF-8。
fn codec_for(label: Option<&str>) -> CommandResult<Codec> {
    Ok(match label {
        None => Codec::utf8(),
        Some(l) => Codec::new(l)?,
    })
}

fn credential_account(username: &str, host: &str, port: u16) -> String {
    format!("{username}@{host}:{port}")
}

/// 起動するシェル。ユーザー入力は受け取らず、環境の `SHELL` を `/etc/shells` で検証する。
fn login_shell() -> String {
    const FALLBACK: &str = "/bin/zsh";
    let Ok(shell) = std::env::var("SHELL") else {
        return FALLBACK.into();
    };
    let allowed = std::fs::read_to_string("/etc/shells")
        .map(|t| t.lines().any(|l| l.trim() == shell))
        .unwrap_or(false);
    if allowed { shell } else { FALLBACK.into() }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartLocalShell {
    cols: u16,
    rows: u16,
    encoding: Option<String>,
}

#[tauri::command]
pub async fn start_local_shell(
    state: State<'_, AppState>,
    req: StartLocalShell,
) -> CommandResult<String> {
    let codec = codec_for(req.encoding.as_deref())?;
    let session = LocalShellSession::spawn(LocalShellConfig {
        program: login_shell(),
        args: vec!["-l".into()],
        size: size(req.cols, req.rows)?,
        cwd: None,
    })?;
    Ok(state.manager.start(Box::new(session), codec).await)
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SshAuthRequest {
    Password {
        password: String,
        remember: bool,
    },
    /// Keychain に保存済みのパスワードを使う。
    Keychain,
    #[serde(rename_all = "camelCase")]
    KeyFile {
        path: PathBuf,
        passphrase: Option<String>,
    },
    Agent,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSsh {
    host: String,
    port: u16,
    username: String,
    auth: SshAuthRequest,
    cols: u16,
    rows: u16,
    encoding: Option<String>,
    /// 端末の種類（TERM）。未指定は `xterm-256color`。
    #[serde(default)]
    term_type: Option<String>,
    /// `~/.ssh/config` を使う（別名・User・Port・IdentityFile・ProxyJump の解決）。
    #[serde(default = "default_true")]
    use_ssh_config: bool,
    /// 踏み台（`[user@]host[:port],...`）。空なら `~/.ssh/config` の ProxyJump を使う。
    #[serde(default)]
    jump_hosts: String,
    /// ローカルポートフォワード（`-L`）。
    #[serde(default)]
    forwards: Vec<LocalForward>,
    /// SOCKS5 プロキシ（`-D`）の待ち受けポート。
    #[serde(default)]
    dynamic_forwards: Vec<u16>,
    /// リモートフォワード（`-R`）。
    #[serde(default)]
    remote_forwards: Vec<RemoteForward>,
}

fn default_true() -> bool {
    true
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// `~/.ssh/config` を読む。使わない設定・ホームが不明な場合は空の設定。
fn load_ssh_config(enabled: bool) -> Result<SshConfigFile, SshConfigError> {
    match (enabled, home_dir()) {
        (true, Some(home)) => SshConfigFile::load(&default_config_path(&home), Some(&home)),
        _ => Ok(SshConfigFile::default()),
    }
}

/// ダイアログのホスト名の候補にする、`~/.ssh/config` の別名。
#[tauri::command]
pub fn list_ssh_hosts() -> CommandResult<Vec<String>> {
    Ok(load_ssh_config(true)?.host_aliases())
}

#[tauri::command]
pub async fn start_ssh(state: State<'_, AppState>, req: StartSsh) -> CommandResult<String> {
    let codec = codec_for(req.encoding.as_deref())?;
    let config = load_ssh_config(req.use_ssh_config)?;
    let target = resolve_target(
        &config,
        &RequestedTarget {
            host: req.host.clone(),
            port: req.port,
            username: req.username.clone(),
            jump_hosts: req.jump_hosts.clone(),
        },
    )?;
    let account = credential_account(&target.username, &target.hostname, target.port);
    let mut remember: Option<Zeroizing<String>> = None;
    let auth = match req.auth {
        SshAuthRequest::Password {
            password,
            remember: r,
        } => {
            let password = Zeroizing::new(password);
            if r {
                remember = Some(password.clone());
            }
            SshAuth::Password(password)
        }
        SshAuthRequest::Keychain => {
            let saved = state.credentials.load(&account)?.ok_or_else(|| {
                CommandError::Invalid(format!("{account} のパスワードがKeychainにありません"))
            })?;
            SshAuth::Password(saved)
        }
        SshAuthRequest::KeyFile { path, passphrase } => SshAuth::PrivateKey {
            // 空なら、`~/.ssh/config` の IdentityFile から選ぶ。
            path: pick_identity_file(&path, &target.identity_files, home_dir().as_deref())?,
            passphrase: passphrase.map(Zeroizing::new),
        },
        SshAuthRequest::Agent => SshAuth::Agent,
    };
    // ~/.ssh/config の LocalForward / DynamicForward も合わせる（use_ssh_config が false なら空）。
    let (forwards, dynamic_forwards) = merge_forwards(
        req.forwards.clone(),
        req.dynamic_forwards.clone(),
        target.local_forwards.clone(),
        target.dynamic_forwards.clone(),
    );
    let remote_forwards =
        merge_remote_forwards(req.remote_forwards.clone(), target.remote_forwards.clone());
    let session = SshSession::connect(
        SshConfig {
            host: target.hostname.clone(),
            port: target.port,
            username: target.username.clone(),
            auth,
            size: size(req.cols, req.rows)?,
            term: term_for(req.term_type.as_deref())?,
            keepalive_interval: Some(SSH_KEEPALIVE),
            jump_hosts: build_jump_hosts(&config, &target.jumps, &target.username),
            forwards,
            dynamic_forwards,
            remote_forwards,
        },
        state.known_hosts.clone(),
        state.approver.clone(),
    )
    .await?;
    // 認証に成功した場合のみ保存する。
    if let Some(password) = remember {
        state.credentials.save(&account, &password)?;
    }
    Ok(state.manager.start(Box::new(session), codec).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTelnet {
    host: String,
    port: u16,
    cols: u16,
    rows: u16,
    encoding: Option<String>,
    /// 端末の種類（TERM）。未指定は `xterm-256color`。
    #[serde(default)]
    term_type: Option<String>,
    #[serde(default)]
    tx_newline: TxNewline,
    #[serde(default)]
    rx_newline: RxNewline,
}

#[tauri::command]
pub async fn start_telnet(state: State<'_, AppState>, req: StartTelnet) -> CommandResult<String> {
    let codec = codec_for(req.encoding.as_deref())?;
    let session = TelnetSession::connect(TelnetConfig {
        host: req.host,
        port: req.port,
        size: size(req.cols, req.rows)?,
        term: term_for(req.term_type.as_deref())?,
        tx_newline: req.tx_newline,
        rx_newline: req.rx_newline,
        connect_timeout: CONNECT_TIMEOUT,
    })
    .await?;
    Ok(state.manager.start(Box::new(session), codec).await)
}

#[tauri::command]
pub async fn start_serial(
    state: State<'_, AppState>,
    config: SerialConfig,
    encoding: Option<String>,
) -> CommandResult<String> {
    let codec = codec_for(encoding.as_deref())?;
    let session: Box<dyn TerminalSession> = Box::new(SerialSession::open(&config)?);
    Ok(state.manager.start(session, codec).await)
}

#[tauri::command]
pub fn list_serial_ports() -> CommandResult<Vec<String>> {
    Ok(list_ports()?)
}

#[tauri::command]
pub async fn terminal_write(
    state: State<'_, AppState>,
    id: String,
    data: String,
) -> CommandResult<()> {
    Ok(state.manager.write(&id, &data).await?)
}

#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> CommandResult<()> {
    Ok(state.manager.resize(&id, size(cols, rows)?).await?)
}

/// シリアルの制御信号（DTR/RTS）を設定する。
#[tauri::command]
pub async fn serial_set_control(
    state: State<'_, AppState>,
    id: String,
    signal: ControlSignal,
    on: bool,
) -> CommandResult<()> {
    Ok(state.manager.set_control(&id, signal, on).await?)
}

/// シリアルにブレーク信号を送る。
#[tauri::command]
pub async fn serial_send_break(state: State<'_, AppState>, id: String) -> CommandResult<()> {
    Ok(state.manager.send_break(&id).await?)
}

/// 受信データの表示方法（テキスト／16進ダンプ）を切り替える。
#[tauri::command]
pub async fn set_display_mode(
    state: State<'_, AppState>,
    id: String,
    mode: DisplayMode,
) -> CommandResult<()> {
    Ok(state.manager.set_display(&id, mode).await?)
}

#[tauri::command]
pub async fn terminal_close(state: State<'_, AppState>, id: String) -> CommandResult<()> {
    Ok(state.manager.close(&id).await?)
}

/// ログファイル名に使えるよう、英数字・`-`・`_`・`.` 以外を `_` に置き換える。
fn sanitize_file_stem(title: &str) -> String {
    let stem: String = title
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let stem = stem.trim_matches('.');
    if stem.is_empty() {
        "session".into()
    } else {
        stem.to_owned()
    }
}

/// 既定ログパスの予約簿。
///
/// 存在確認だけでは同時に呼ばれたときに同じ候補を返してしまうため、返したパスを記録して以後は避ける。
#[derive(Debug, Default)]
pub struct LogPathReserver {
    reserved: std::sync::Mutex<std::collections::HashSet<PathBuf>>,
}

impl LogPathReserver {
    /// `<dir>/<stem>-<timestamp>.log`。存在する、または予約済みなら `-1`, `-2` … を付けて避け、
    /// 返すパスを予約する。
    pub fn reserve(&self, dir: &std::path::Path, stem: &str, timestamp: &str) -> PathBuf {
        // 確認と予約を同じロック内で行い、同時呼び出しでも重複させない。
        // ロックの毒化は集合の整合性を壊さないため無視してよい。
        let mut reserved = self.reserved.lock().unwrap_or_else(|e| e.into_inner());
        let candidates = std::iter::once(dir.join(format!("{stem}-{timestamp}.log")))
            .chain((1..).map(|n| dir.join(format!("{stem}-{timestamp}-{n}.log"))));
        for path in candidates {
            if !path.exists() && reserved.insert(path.clone()) {
                return path;
            }
        }
        unreachable!("候補は無限に続く")
    }
}

/// ログの保存先の既定値（`~/Library/Logs/<identifier>/<title>-<日時>.log`）。ディレクトリも作成する。
#[tauri::command]
pub fn default_log_path(
    app: AppHandle,
    state: State<'_, AppState>,
    title: String,
) -> CommandResult<String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| CommandError::Invalid(format!("ログディレクトリを取得できません: {e}")))?;
    std::fs::create_dir_all(&dir).map_err(|e| {
        CommandError::Terminal(TerminalError::io(format!("{} の作成", dir.display()), e))
    })?;
    let timestamp = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f");
    let path = state
        .log_paths
        .reserve(&dir, &sanitize_file_stem(&title), &timestamp.to_string());
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn start_session_log(
    state: State<'_, AppState>,
    id: String,
    config: LogConfig,
) -> CommandResult<()> {
    begin_session_log(&state.manager, &id, &config).await
}

/// ログを開始する。ファイルを開く（上書きなら切り詰める）前に、セッションの存在を確認する。
async fn begin_session_log(
    manager: &SessionManager,
    id: &str,
    config: &LogConfig,
) -> CommandResult<()> {
    if !manager.contains(id).await {
        return Err(ManagerError::UnknownSession(id.to_owned()).into());
    }
    let logger = SessionLogger::open(config)?;
    Ok(manager.set_logger(id, Some(logger)).await?)
}

#[tauri::command]
pub async fn stop_session_log(state: State<'_, AppState>, id: String) -> CommandResult<()> {
    Ok(state.manager.set_logger(&id, None).await?)
}

#[tauri::command]
pub async fn respond_host_key(
    state: State<'_, AppState>,
    request_id: String,
    approved: bool,
) -> CommandResult<()> {
    if state.approvals.respond(&request_id, approved) {
        Ok(())
    } else {
        Err(CommandError::Invalid(format!(
            "承認要求 {request_id} は存在しないか期限切れです"
        )))
    }
}

/// インストール済みのフォントの一覧（設定画面の選択肢）。時間がかかり得るため別スレッドで取得する。
#[tauri::command]
pub async fn list_fonts() -> CommandResult<Vec<FontFamily>> {
    tauri::async_runtime::spawn_blocking(crate::fonts::installed_families)
        .await
        .map_err(|e| CommandError::Invalid(format!("フォント一覧の取得が中断されました: {e}")))?
        .map_err(CommandError::from)
}

/// 前回終了時のタブ構成（接続先のみ）。
#[tauri::command]
pub fn get_session_state(state: State<'_, AppState>) -> CommandResult<SessionState> {
    Ok(state.session_state.load()?)
}

/// 最近使った接続先（新しい順）。
#[tauri::command]
pub fn get_recent_connections(state: State<'_, AppState>) -> CommandResult<Vec<RecentConnection>> {
    Ok(state.recent.load()?)
}

/// 最近使った接続先を保存する。パスワード類は保存されない。
#[tauri::command]
pub fn save_recent_connections(
    state: State<'_, AppState>,
    entries: Vec<RecentConnection>,
) -> CommandResult<()> {
    state.recent.save(entries)?;
    Ok(())
}

/// タブ構成を保存する。パスワード類は保存されない。
#[tauri::command]
pub fn save_session_state(state: State<'_, AppState>, session: SessionState) -> CommandResult<()> {
    state.session_state.save(session)?;
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> CommandResult<Settings> {
    Ok(state.settings.load()?)
}

/// 設定を検証して保存し、保存した値を返す。
#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> CommandResult<Settings> {
    Ok(state.settings.save(settings)?)
}

#[tauri::command]
pub fn list_profiles(state: State<'_, AppState>) -> CommandResult<Vec<Profile>> {
    Ok(state.profiles.list()?)
}

/// 接続プロファイルを保存する（`id` があれば更新）。パスワード類は保存されない。
#[tauri::command]
pub fn save_profile(
    state: State<'_, AppState>,
    id: Option<String>,
    name: String,
    values: serde_json::Value,
) -> CommandResult<Profile> {
    Ok(state.profiles.save(id.as_deref(), &name, values)?)
}

#[tauri::command]
pub fn delete_profile(state: State<'_, AppState>, id: String) -> CommandResult<bool> {
    Ok(state.profiles.delete(&id)?)
}

/// 未応答のホスト鍵承認要求。フロントが購読を始める前に出た要求を取り込むために使う。
#[tauri::command]
pub fn pending_host_key_requests(state: State<'_, AppState>) -> Vec<HostKeyRequest> {
    state.approvals.pending()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_account_format() {
        assert_eq!(
            credential_account("alice", "example.com", 22),
            "alice@example.com:22"
        );
    }

    #[test]
    fn term_for_defaults_and_allows_only_known_types() {
        assert_eq!(term_for(None).unwrap(), "xterm-256color");
        assert_eq!(term_for(Some("vt100")).unwrap(), "vt100");
        assert_eq!(term_for(Some("linux")).unwrap(), "linux");
        assert!(term_for(Some("")).is_err());
        assert!(term_for(Some("xterm; rm -rf /")).is_err());
        assert!(term_for(Some("VT100")).is_err());
    }

    #[test]
    fn login_shell_is_an_absolute_path() {
        assert!(login_shell().starts_with('/'));
    }

    #[test]
    fn codec_for_defaults_to_utf8_and_validates_label() {
        assert_eq!(codec_for(None).unwrap().name(), "UTF-8");
        assert_eq!(codec_for(Some("Shift_JIS")).unwrap().name(), "Shift_JIS");
        assert!(codec_for(Some("bogus")).is_err());
    }

    #[test]
    fn sanitize_file_stem_replaces_unsafe_characters() {
        assert_eq!(sanitize_file_stem("alice@example.com"), "alice_example.com");
        assert_eq!(sanitize_file_stem("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(
            sanitize_file_stem("cu.usbserial @115200"),
            "cu.usbserial__115200"
        );
        assert_eq!(sanitize_file_stem("..."), "session");
        assert_eq!(sanitize_file_stem(""), "session");
    }

    #[test]
    fn size_rejects_zero() {
        assert!(size(0, 10).is_err());
        assert!(size(80, 24).is_ok());
    }

    #[test]
    fn command_error_serializes_as_message() {
        let e = CommandError::Invalid("x".into());
        assert_eq!(serde_json::to_string(&e).unwrap(), "\"x\"");
    }

    #[test]
    fn ssh_auth_request_deserializes_by_kind() {
        let a: SshAuthRequest =
            serde_json::from_str(r#"{"kind":"password","password":"p","remember":true}"#).unwrap();
        assert!(matches!(a, SshAuthRequest::Password { remember: true, .. }));
        let a: SshAuthRequest =
            serde_json::from_str(r#"{"kind":"keyFile","path":"/k","passphrase":null}"#).unwrap();
        assert!(matches!(a, SshAuthRequest::KeyFile { .. }));
        assert!(serde_json::from_str::<SshAuthRequest>(r#"{"kind":"agent"}"#).is_ok());
        assert!(serde_json::from_str::<SshAuthRequest>(r#"{"kind":"bogus"}"#).is_err());
    }

    #[test]
    fn reserve_is_plain_when_free() {
        let dir = std::env::temp_dir().join(format!("linkterm-ulp-free-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(
            LogPathReserver::default().reserve(&dir, "alice", "20260101-000000-123"),
            dir.join("alice-20260101-000000-123.log")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reserve_avoids_existing_files() {
        let dir = std::env::temp_dir().join(format!("linkterm-ulp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let reserver = LogPathReserver::default();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..5 {
            let p = reserver.reserve(&dir, "t", "20260101-000000-000");
            assert!(seen.insert(p.clone()), "重複: {p:?}");
            std::fs::write(&p, "x").unwrap();
        }
        assert!(dir.join("t-20260101-000000-000-1.log").exists());
        assert!(dir.join("t-20260101-000000-000-4.log").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reserve_returns_distinct_paths_even_before_files_exist() {
        let dir = std::env::temp_dir().join(format!("linkterm-resv-{}", std::process::id()));
        let reserver = LogPathReserver::default();
        let a = reserver.reserve(&dir, "t", "20260101-000000-000");
        let b = reserver.reserve(&dir, "t", "20260101-000000-000");
        assert_ne!(a, b);
        assert_eq!(b, dir.join("t-20260101-000000-000-1.log"));
    }

    #[test]
    fn concurrent_reservations_never_collide() {
        let dir = std::env::temp_dir().join(format!("linkterm-resv-conc-{}", std::process::id()));
        let reserver = Arc::new(LogPathReserver::default());
        let n = 32;
        let barrier = Arc::new(std::sync::Barrier::new(n));
        let handles: Vec<_> = (0..n)
            .map(|_| {
                let (r, b, d) = (reserver.clone(), barrier.clone(), dir.clone());
                std::thread::spawn(move || {
                    b.wait();
                    r.reserve(&d, "t", "20260101-000000-000")
                })
            })
            .collect();
        let paths: std::collections::HashSet<_> =
            handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(paths.len(), n);
    }

    struct NoopSink;
    impl EventSink for NoopSink {
        fn data(&self, _: &str, _: &[u8]) {}
        fn closed(&self, _: &str, _: Option<String>) {}
        fn log_error(&self, _: &str, _: &str) {}
        fn echo_changed(&self, _: &str, _: bool) {}
    }

    fn log_config(path: PathBuf, append: bool) -> LogConfig {
        LogConfig {
            path,
            mode: crate::session::LogMode::Text,
            timestamps: false,
            append,
        }
    }

    #[tokio::test]
    async fn begin_session_log_with_unknown_id_does_not_touch_the_file() {
        let dir = std::env::temp_dir().join(format!("linkterm-bsl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("existing.log");
        std::fs::write(&path, "keep me\n").unwrap();
        let manager = SessionManager::new(Arc::new(NoopSink));
        let r = begin_session_log(
            &manager,
            "no-such-session",
            &log_config(path.clone(), false),
        )
        .await;
        assert!(matches!(
            r,
            Err(CommandError::Manager(ManagerError::UnknownSession(_)))
        ));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "keep me\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn begin_session_log_starts_logging_for_a_live_session() {
        let dir = std::env::temp_dir().join(format!("linkterm-bsl-ok-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.log");
        let manager = SessionManager::new(Arc::new(NoopSink));
        let session = LocalShellSession::spawn(LocalShellConfig {
            program: "/bin/cat".into(),
            args: vec![],
            size: TerminalSize::new(80, 24).unwrap(),
            cwd: None,
        })
        .unwrap();
        let id = manager.start(Box::new(session), Codec::utf8()).await;
        begin_session_log(&manager, &id, &log_config(path.clone(), false))
            .await
            .unwrap();
        manager.write(&id, "logged-line\r").await.unwrap();
        let ok = tokio::time::timeout(Duration::from_secs(5), async {
            while !std::fs::read_to_string(&path).is_ok_and(|t| t.contains("logged-line")) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        assert!(ok.is_ok());
        manager.close_all().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn overwrite_log_is_truncated_once_registered_with_a_live_session() {
        let dir = std::env::temp_dir().join(format!("linkterm-bsl-trunc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.log");
        std::fs::write(&path, "old content\n").unwrap();
        let manager = SessionManager::new(Arc::new(NoopSink));
        let session = LocalShellSession::spawn(LocalShellConfig {
            program: "/bin/cat".into(),
            args: vec![],
            size: TerminalSize::new(80, 24).unwrap(),
            cwd: None,
        })
        .unwrap();
        let id = manager.start(Box::new(session), Codec::utf8()).await;
        begin_session_log(&manager, &id, &log_config(path.clone(), false))
            .await
            .unwrap();
        // 開始コマンドの応答の時点で切り詰め済み（待たずに確認できる）。
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
        manager.close_all().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}

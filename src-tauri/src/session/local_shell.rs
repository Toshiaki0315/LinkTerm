use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, SlavePty, native_pty_system};
use tokio::sync::mpsc;

use super::{TerminalError, TerminalSession, TerminalSize};

const READ_BUFFER_SIZE: usize = 8192;
const CHANNEL_CAPACITY: usize = 64;
/// 子プロセスが終了してから、PTYのスレーブ側を閉じるまでの猶予。
///
/// macOS ではスレーブ側を閉じた時点で、読み取り前の出力が破棄されることがある。
/// 子が一瞬で終了しても、読み取りスレッドが出力を取り切れるよう、閉じるのを少し遅らせる。
const EXIT_DRAIN_GRACE: Duration = Duration::from_millis(150);

/// 親側が保持している PTY のスレーブ側。閉じると、読み取りスレッドが EOF を受け取る。
type SlaveHolder = Arc<Mutex<Option<Box<dyn SlavePty + Send>>>>;

fn release_slave(holder: &SlaveHolder) {
    // ロックの毒化は保持データの整合性を壊さないため無視してよい。
    holder.lock().unwrap_or_else(|e| e.into_inner()).take();
}

/// ローカルシェルの起動設定。ユーザー入力をシェルへ渡さず、引数配列で保持する。
#[derive(Debug, Clone)]
pub struct LocalShellConfig {
    pub program: String,
    pub args: Vec<String>,
    pub size: TerminalSize,
    /// 開始ディレクトリ。`None` ならホームディレクトリ（[`default_start_dir`]）。
    pub cwd: Option<PathBuf>,
}

/// 開始ディレクトリの既定値。起動方法（Finder / `make dev` / ターミナル）に関わらずホームにする。
///
/// ホームが存在するディレクトリでない場合のみ、現在のディレクトリへフォールバックする。
pub fn default_start_dir(current: Option<PathBuf>, home: Option<PathBuf>) -> Option<PathBuf> {
    home.filter(|h| h.is_dir()).or(current)
}

/// 子プロセスに設定する端末関連の環境変数。親（起動元のターミナル等）の値は上書きする。
///
/// `TERM_PROGRAM` などを引き継ぐと、シェルが起動元（Apple Terminal 等）向けの処理
/// （セッション復元メッセージなど）を実行してしまう。
pub fn terminal_env() -> Vec<(&'static str, String)> {
    vec![
        ("TERM", "xterm-256color".into()),
        ("COLORTERM", "truecolor".into()),
        ("TERM_PROGRAM", "LinkTerm".into()),
        ("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION").into()),
    ]
}

/// 子プロセスから取り除く、起動元ターミナル固有の環境変数。
pub const INHERITED_TERMINAL_VARS: &[&str] = &["TERM_SESSION_ID", "ITERM_SESSION_ID"];

/// `portable-pty` 経由のローカルシェルセッション。環境変数は親プロセスから継承する。
pub struct LocalShellSession {
    master: Box<dyn MasterPty + Send>,
    writer: Option<Box<dyn Write + Send>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    slave: SlaveHolder,
    rx: mpsc::Receiver<Vec<u8>>,
    closed: bool,
}

fn pty_size(size: TerminalSize) -> PtySize {
    PtySize {
        rows: size.rows,
        cols: size.cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

impl LocalShellSession {
    pub fn spawn(config: LocalShellConfig) -> Result<Self, TerminalError> {
        let pair = native_pty_system()
            .openpty(pty_size(config.size))
            .map_err(|e| TerminalError::ConnectionFailed(format!("PTYを開けません: {e}")))?;

        let mut cmd = CommandBuilder::new(&config.program);
        cmd.args(&config.args);
        for name in INHERITED_TERMINAL_VARS {
            cmd.env_remove(name);
        }
        for (name, value) in terminal_env() {
            cmd.env(name, value);
        }
        let start_dir = config.cwd.or_else(|| {
            default_start_dir(
                std::env::current_dir().ok(),
                std::env::var_os("HOME").map(PathBuf::from),
            )
        });
        if let Some(dir) = start_dir {
            cmd.cwd(dir);
        }
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| {
            TerminalError::ConnectionFailed(format!("{} を起動できません: {e}", config.program))
        })?;
        let killer = child.clone_killer();
        // スレーブ側はすぐには閉じない（出力の取りこぼし防止）。子の終了を待つスレッドが、
        // 猶予のあとで閉じ、読み取りスレッドが EOF を受け取れるようにする。
        let slave: SlaveHolder = Arc::new(Mutex::new(Some(pair.slave)));
        let waiter_slave = slave.clone();
        std::thread::spawn(move || {
            let _ = child.wait();
            std::thread::sleep(EXIT_DRAIN_GRACE);
            release_slave(&waiter_slave);
        });

        let mut reader = pair.master.try_clone_reader().map_err(|e| {
            TerminalError::ConnectionFailed(format!("PTY読み取りを開始できません: {e}"))
        })?;
        let writer = pair.master.take_writer().map_err(|e| {
            TerminalError::ConnectionFailed(format!("PTY書き込みを開始できません: {e}"))
        })?;

        let (tx, rx) = mpsc::channel(CHANNEL_CAPACITY);
        std::thread::spawn(move || {
            let mut buf = [0u8; READ_BUFFER_SIZE];
            loop {
                match reader.read(&mut buf) {
                    // EOF、またはPTY切断（EIO）で終了する。
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.blocking_send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        Ok(Self {
            master: pair.master,
            writer: Some(writer),
            killer,
            slave,
            rx,
            closed: false,
        })
    }
}

#[async_trait]
impl TerminalSession for LocalShellSession {
    async fn write(&mut self, data: &[u8]) -> Result<(), TerminalError> {
        let writer = self.writer.as_mut().ok_or(TerminalError::Closed)?;
        writer
            .write_all(data)
            .and_then(|()| writer.flush())
            .map_err(|e| TerminalError::io("PTYへの書き込み", e))
    }

    async fn read(&mut self) -> Result<Option<Vec<u8>>, TerminalError> {
        Ok(self.rx.recv().await)
    }

    async fn resize(&mut self, size: TerminalSize) -> Result<(), TerminalError> {
        if self.closed {
            return Err(TerminalError::Closed);
        }
        self.master
            .resize(pty_size(size))
            .map_err(|e| TerminalError::io("PTYのリサイズ", std::io::Error::other(e.to_string())))
    }

    async fn close(&mut self) -> Result<(), TerminalError> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        self.writer = None;
        // 既に終了済みの場合のエラーは無視してよい。
        let _ = self.killer.kill();
        release_slave(&self.slave);
        self.rx.close();
        Ok(())
    }
}

impl Drop for LocalShellSession {
    fn drop(&mut self) {
        if !self.closed {
            let _ = self.killer.kill();
            release_slave(&self.slave);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::time::timeout;

    fn config(program: &str, args: &[&str]) -> LocalShellConfig {
        LocalShellConfig {
            program: program.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            size: TerminalSize::new(80, 24).unwrap(),
            cwd: None,
        }
    }

    /// 終了またはタイムアウトまで出力を集める。
    async fn collect(s: &mut LocalShellSession, needle: &str) -> String {
        let mut out = Vec::new();
        let r = timeout(Duration::from_secs(5), async {
            while let Some(chunk) = s.read().await.unwrap() {
                out.extend(chunk);
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
    async fn receives_output_of_program() {
        let mut s = LocalShellSession::spawn(config("/bin/echo", &["hello-pty"])).unwrap();
        assert!(collect(&mut s, "hello-pty").await.contains("hello-pty"));
    }

    #[tokio::test]
    async fn args_are_not_interpreted_by_shell() {
        let mut s = LocalShellSession::spawn(config("/bin/echo", &["$(echo injected);x"])).unwrap();
        let out = collect(&mut s, ";x").await;
        assert!(out.contains("$(echo injected);x"), "{out}");
    }

    #[tokio::test]
    async fn write_reaches_process_and_echoes() {
        let mut s = LocalShellSession::spawn(config("/bin/cat", &[])).unwrap();
        s.write(b"ping\n").await.unwrap();
        assert!(collect(&mut s, "ping").await.contains("ping"));
        s.close().await.unwrap();
    }

    #[tokio::test]
    async fn read_returns_none_after_process_exits() {
        let mut s = LocalShellSession::spawn(config("/usr/bin/true", &[])).unwrap();
        let r = timeout(Duration::from_secs(5), async {
            while s.read().await.unwrap().is_some() {}
        })
        .await;
        assert!(r.is_ok());
    }

    #[tokio::test]
    async fn resize_is_visible_to_process() {
        let mut s =
            LocalShellSession::spawn(config("/bin/sh", &["-c", "sleep 0.5; stty size"])).unwrap();
        s.resize(TerminalSize::new(100, 30).unwrap()).await.unwrap();
        assert!(collect(&mut s, "30 100").await.contains("30 100"));
    }

    #[tokio::test]
    async fn spawn_fails_for_missing_program() {
        let r = LocalShellSession::spawn(config("/nonexistent/prog", &[]));
        assert!(matches!(r, Err(TerminalError::ConnectionFailed(_))));
    }

    #[tokio::test]
    async fn operations_fail_after_close() {
        let mut s = LocalShellSession::spawn(config("/bin/cat", &[])).unwrap();
        s.close().await.unwrap();
        s.close().await.unwrap();
        assert!(matches!(s.write(b"x").await, Err(TerminalError::Closed)));
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("linkterm-cwd-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn root_current_dir_uses_home() {
        let home = temp_dir("home");
        assert_eq!(
            default_start_dir(Some("/".into()), Some(home.clone())),
            Some(home.clone())
        );
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn missing_current_dir_uses_home() {
        let home = temp_dir("home-none");
        assert_eq!(
            default_start_dir(None, Some(home.clone())),
            Some(home.clone())
        );
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn home_is_used_even_when_current_dir_is_not_root() {
        // `make dev` など、起動元が `/` 以外でも常にホームから始める。
        let home = temp_dir("home-always");
        let project = temp_dir("project");
        assert_eq!(
            default_start_dir(Some(project.clone()), Some(home.clone())),
            Some(home.clone())
        );
        let _ = std::fs::remove_dir_all(home);
        let _ = std::fs::remove_dir_all(project);
    }

    #[test]
    fn current_dir_is_kept_when_home_is_unusable() {
        let project = temp_dir("project-fallback");
        assert_eq!(
            default_start_dir(Some(project.clone()), None),
            Some(project.clone())
        );
        assert_eq!(
            default_start_dir(Some(project.clone()), Some("/nonexistent-home-dir".into())),
            Some(project.clone())
        );
        let _ = std::fs::remove_dir_all(project);
    }

    #[test]
    fn root_is_kept_when_home_is_unusable() {
        assert_eq!(
            default_start_dir(Some("/".into()), None),
            Some(PathBuf::from("/"))
        );
        assert_eq!(
            default_start_dir(Some("/".into()), Some("/nonexistent-home-dir".into())),
            Some(PathBuf::from("/"))
        );
        let file = std::env::temp_dir().join(format!("linkterm-cwd-file-{}", std::process::id()));
        std::fs::write(&file, "x").unwrap();
        assert_eq!(
            default_start_dir(Some("/".into()), Some(file.clone())),
            Some(PathBuf::from("/"))
        );
        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn nothing_available_yields_none() {
        assert_eq!(default_start_dir(None, None), None);
    }

    #[tokio::test]
    async fn explicit_cwd_is_used_for_the_process() {
        let dir = temp_dir("explicit");
        let mut cfg = config("/bin/pwd", &[]);
        cfg.cwd = Some(dir.clone());
        let mut s = LocalShellSession::spawn(cfg).unwrap();
        let out = collect(&mut s, dir.file_name().unwrap().to_str().unwrap()).await;
        assert!(out.contains(dir.to_str().unwrap()), "{out}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn terminal_env_identifies_linkterm_and_supports_color() {
        let env: std::collections::HashMap<_, _> = terminal_env().into_iter().collect();
        assert_eq!(env["TERM"], "xterm-256color");
        assert_eq!(env["COLORTERM"], "truecolor");
        assert_eq!(env["TERM_PROGRAM"], "LinkTerm");
        assert_eq!(env["TERM_PROGRAM_VERSION"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn inherited_terminal_session_vars_are_listed_for_removal() {
        assert!(INHERITED_TERMINAL_VARS.contains(&"TERM_SESSION_ID"));
    }

    #[tokio::test]
    async fn spawned_shell_sees_linkterm_environment() {
        let mut s = LocalShellSession::spawn(config("/usr/bin/env", &[])).unwrap();
        let out = collect(&mut s, "TERM_PROGRAM_VERSION").await;
        assert!(out.contains("TERM_PROGRAM=LinkTerm"), "{out}");
        assert!(out.contains("TERM=xterm-256color"), "{out}");
        assert!(!out.contains("Apple_Terminal"), "{out}");
    }

    /// 起動してすぐ終了するプログラムの出力も、取りこぼさず受け取れること（負荷が高い環境でも）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn output_of_instantly_exiting_programs_is_never_lost() {
        let mut lost = Vec::new();
        for n in 0..150 {
            let marker = format!("fast-exit-{n}");
            let mut s = LocalShellSession::spawn(config("/bin/echo", &[marker.as_str()])).unwrap();
            let got = timeout(Duration::from_secs(5), async {
                let mut out = Vec::new();
                while let Some(chunk) = s.read().await.unwrap() {
                    out.extend(chunk);
                    if String::from_utf8_lossy(&out).contains(&marker) {
                        return true;
                    }
                }
                false
            })
            .await
            .unwrap_or(false);
            if !got {
                lost.push(n);
            }
        }
        assert!(lost.is_empty(), "出力が失われた回: {lost:?}");
    }
}

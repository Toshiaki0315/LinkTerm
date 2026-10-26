use std::io::{Read, Write};

use async_trait::async_trait;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::mpsc;

use super::{TerminalError, TerminalSession, TerminalSize};

const READ_BUFFER_SIZE: usize = 8192;
const CHANNEL_CAPACITY: usize = 64;

/// ローカルシェルの起動設定。ユーザー入力をシェルへ渡さず、引数配列で保持する。
#[derive(Debug, Clone)]
pub struct LocalShellConfig {
    pub program: String,
    pub args: Vec<String>,
    pub size: TerminalSize,
}

/// `portable-pty` 経由のローカルシェルセッション。環境変数は親プロセスから継承する。
pub struct LocalShellSession {
    master: Box<dyn MasterPty + Send>,
    writer: Option<Box<dyn Write + Send>>,
    child: Box<dyn Child + Send + Sync>,
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
        if let Ok(cwd) = std::env::current_dir() {
            cmd.cwd(cwd);
        }
        let child = pair.slave.spawn_command(cmd).map_err(|e| {
            TerminalError::ConnectionFailed(format!("{} を起動できません: {e}", config.program))
        })?;
        // 子プロセス終了時にリーダーがEOFを受け取れるよう、スレーブ側を閉じる。
        drop(pair.slave);

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
            child,
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
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.rx.close();
        Ok(())
    }
}

impl Drop for LocalShellSession {
    fn drop(&mut self) {
        if !self.closed {
            let _ = self.child.kill();
            let _ = self.child.wait();
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
}

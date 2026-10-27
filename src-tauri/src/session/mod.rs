//! 全プロトコル共通のターミナルセッション抽象。

mod codec;
mod credentials;
mod error;
pub mod hex;
mod known_hosts;
mod local_shell;
mod log;
#[cfg(test)]
mod mock;
mod newline;
mod serial;
mod ssh;
pub mod telnet;

pub use codec::{Codec, SUPPORTED_ENCODINGS};
pub use credentials::{CredentialError, CredentialStore, InMemoryStore, KeychainStore};
pub use error::TerminalError;
pub use known_hosts::{
    FileKnownHosts, HostKeyApprover, HostKeyStatus, InMemoryKnownHosts, KnownHostsStore,
    check_host_key, verify_host_key,
};
pub use local_shell::{LocalShellConfig, LocalShellSession};
pub use log::{Clock, LogConfig, LogError, LogMode, SessionLogger};
pub use newline::{IncomingConverter, RxNewline, TxNewline, convert_outgoing};
pub use serial::{
    DataBits, FlowControl, Parity, SerialConfig, SerialControl, SerialSession, StopBits, list_ports,
};
pub use ssh::{JumpHost, LocalForward, RemoteForward, SshAuth, SshConfig, SshSession};
pub use telnet::{TelnetConfig, TelnetSession};

use async_trait::async_trait;

/// シリアルの制御信号。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ControlSignal {
    /// Data Terminal Ready
    Dtr,
    /// Request To Send
    Rts,
}

/// ターミナルのウィンドウサイズ。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

impl TerminalSize {
    pub fn new(cols: u16, rows: u16) -> Result<Self, TerminalError> {
        if cols == 0 || rows == 0 {
            return Err(TerminalError::InvalidSize { cols, rows });
        }
        Ok(Self { cols, rows })
    }
}

/// Local Shell / SSH / Telnet / Serial が実装する共通トレイト。
///
/// 受信データはエンコーディング変換やログ(Tee)を挟めるよう、生バイト列のまま扱う。
#[async_trait]
pub trait TerminalSession: Send {
    /// 端末へバイト列を送信する。
    async fn write(&mut self, data: &[u8]) -> Result<(), TerminalError>;
    /// 受信バイト列を待つ。セッション終了時は `Ok(None)`。
    async fn read(&mut self) -> Result<Option<Vec<u8>>, TerminalError>;
    /// 端末サイズを変更する。
    async fn resize(&mut self, size: TerminalSize) -> Result<(), TerminalError>;
    /// セッションを閉じる。複数回呼んでもエラーにしない。
    async fn close(&mut self) -> Result<(), TerminalError>;
    /// 接続先がエコーを担当しているか。判定できないプロトコルは `None`。
    ///
    /// 変化したときは、読み取りが空のチャンクで起こされる（呼び出し側はその都度これを確認する）。
    fn echo_state(&self) -> Option<bool> {
        None
    }
    /// 制御信号（DTR/RTS）を設定する。対応しない接続は `Unsupported`。
    async fn set_control(
        &mut self,
        _signal: ControlSignal,
        _on: bool,
    ) -> Result<(), TerminalError> {
        Err(TerminalError::Unsupported("制御信号の操作".into()))
    }
    /// ブレーク信号を送る。対応しない接続は `Unsupported`。
    async fn send_break(&mut self) -> Result<(), TerminalError> {
        Err(TerminalError::Unsupported("ブレーク送信".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::mock::MockSession;
    use super::*;

    #[test]
    fn size_rejects_zero() {
        assert!(TerminalSize::new(0, 24).is_err());
        assert!(TerminalSize::new(80, 0).is_err());
        assert_eq!(
            TerminalSize::new(80, 24).unwrap(),
            TerminalSize { cols: 80, rows: 24 }
        );
    }

    #[tokio::test]
    async fn mock_echoes_written_data() {
        let mut s = MockSession::new();
        s.write(b"hello").await.unwrap();
        assert_eq!(s.read().await.unwrap(), Some(b"hello".to_vec()));
    }

    #[tokio::test]
    async fn mock_records_resize() {
        let mut s = MockSession::new();
        let size = TerminalSize::new(120, 40).unwrap();
        s.resize(size).await.unwrap();
        assert_eq!(s.last_size(), Some(size));
    }

    #[tokio::test]
    async fn closed_session_rejects_write_and_ends_read() {
        let mut s = MockSession::new();
        s.close().await.unwrap();
        s.close().await.unwrap(); // 冪等
        assert!(matches!(s.write(b"x").await, Err(TerminalError::Closed)));
        assert_eq!(s.read().await.unwrap(), None);
    }

    #[tokio::test]
    async fn usable_as_trait_object() {
        let mut s: Box<dyn TerminalSession> = Box::new(MockSession::new());
        s.write(b"a").await.unwrap();
        assert_eq!(s.read().await.unwrap(), Some(b"a".to_vec()));
    }
}

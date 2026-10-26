//! シリアル通信セッション（`tokio-serial`）。
//!
//! USB抜去などのI/Oエラーは即座に読み取り側へ通知し、以降の書き込みを失敗させる。

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio_serial::SerialPortBuilderExt;

use super::{TerminalError, TerminalSession, TerminalSize};

const READ_BUFFER_SIZE: usize = 4096;
const OUTPUT_CAPACITY: usize = 64;
const COMMAND_CAPACITY: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DataBits {
    Five,
    Six,
    Seven,
    Eight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Parity {
    None,
    Odd,
    Even,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StopBits {
    One,
    Two,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FlowControl {
    None,
    Software,
    Hardware,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SerialConfig {
    pub port: String,
    pub baud_rate: u32,
    pub data_bits: DataBits,
    pub parity: Parity,
    pub stop_bits: StopBits,
    pub flow_control: FlowControl,
}

impl SerialConfig {
    /// 一般的な 115200 8N1 の設定。
    pub fn new(port: impl Into<String>, baud_rate: u32) -> Self {
        Self {
            port: port.into(),
            baud_rate,
            data_bits: DataBits::Eight,
            parity: Parity::None,
            stop_bits: StopBits::One,
            flow_control: FlowControl::None,
        }
    }

    fn validate(&self) -> Result<(), TerminalError> {
        if self.port.trim().is_empty() {
            return Err(TerminalError::ConnectionFailed(
                "シリアルポート名が空です".into(),
            ));
        }
        if self.baud_rate == 0 {
            return Err(TerminalError::ConnectionFailed(
                "ボーレートは1以上で指定してください".into(),
            ));
        }
        Ok(())
    }
}

impl From<DataBits> for tokio_serial::DataBits {
    fn from(v: DataBits) -> Self {
        match v {
            DataBits::Five => Self::Five,
            DataBits::Six => Self::Six,
            DataBits::Seven => Self::Seven,
            DataBits::Eight => Self::Eight,
        }
    }
}

impl From<Parity> for tokio_serial::Parity {
    fn from(v: Parity) -> Self {
        match v {
            Parity::None => Self::None,
            Parity::Odd => Self::Odd,
            Parity::Even => Self::Even,
        }
    }
}

impl From<StopBits> for tokio_serial::StopBits {
    fn from(v: StopBits) -> Self {
        match v {
            StopBits::One => Self::One,
            StopBits::Two => Self::Two,
        }
    }
}

impl From<FlowControl> for tokio_serial::FlowControl {
    fn from(v: FlowControl) -> Self {
        match v {
            FlowControl::None => Self::None,
            FlowControl::Software => Self::Software,
            FlowControl::Hardware => Self::Hardware,
        }
    }
}

/// 接続可能なシリアルポート名の一覧。
pub fn list_ports() -> Result<Vec<String>, TerminalError> {
    let ports = tokio_serial::available_ports().map_err(|e| {
        TerminalError::io(
            "シリアルポート一覧の取得",
            std::io::Error::other(e.to_string()),
        )
    })?;
    Ok(ports.into_iter().map(|p| p.port_name).collect())
}

enum Command {
    Data(Vec<u8>),
    Close,
}

type Output = Result<Vec<u8>, TerminalError>;

pub struct SerialSession {
    commands: mpsc::Sender<Command>,
    output: mpsc::Receiver<Output>,
    closed: bool,
}

impl SerialSession {
    pub fn open(config: &SerialConfig) -> Result<Self, TerminalError> {
        config.validate()?;
        let stream = tokio_serial::new(&config.port, config.baud_rate)
            .data_bits(config.data_bits.into())
            .parity(config.parity.into())
            .stop_bits(config.stop_bits.into())
            .flow_control(config.flow_control.into())
            .open_native_async()
            .map_err(|e| {
                TerminalError::ConnectionFailed(format!("{} を開けません: {e}", config.port))
            })?;
        Ok(Self::from_stream(stream))
    }

    /// 任意の非同期ストリームからセッションを作る（テストでPTYペアを使うため公開）。
    pub fn from_stream<S>(stream: S) -> Self
    where
        S: AsyncRead + AsyncWrite + Send + 'static,
    {
        let (cmd_tx, cmd_rx) = mpsc::channel(COMMAND_CAPACITY);
        let (out_tx, out_rx) = mpsc::channel(OUTPUT_CAPACITY);
        tokio::spawn(pump(stream, cmd_rx, out_tx));
        Self {
            commands: cmd_tx,
            output: out_rx,
            closed: false,
        }
    }
}

async fn pump<S>(stream: S, mut commands: mpsc::Receiver<Command>, output: mpsc::Sender<Output>)
where
    S: AsyncRead + AsyncWrite,
{
    let (mut reader, mut writer) = tokio::io::split(stream);
    let mut buf = vec![0u8; READ_BUFFER_SIZE];
    loop {
        tokio::select! {
            read = reader.read(&mut buf) => match read {
                Ok(0) => break,
                Ok(n) => {
                    if output.send(Ok(buf[..n].to_vec())).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = output.send(Err(TerminalError::io("シリアル受信", e))).await;
                    break;
                }
            },
            cmd = commands.recv() => match cmd {
                Some(Command::Data(data)) => {
                    if let Err(e) = writer.write_all(&data).await {
                        let _ = output.send(Err(TerminalError::io("シリアル送信", e))).await;
                        break;
                    }
                }
                Some(Command::Close) | None => break,
            },
        }
    }
}

#[async_trait]
impl TerminalSession for SerialSession {
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

    /// シリアルには端末サイズの概念がないため何もしない。
    async fn resize(&mut self, _size: TerminalSize) -> Result<(), TerminalError> {
        if self.closed {
            return Err(TerminalError::Closed);
        }
        Ok(())
    }

    async fn close(&mut self) -> Result<(), TerminalError> {
        if !self.closed {
            self.closed = true;
            let _ = self.commands.send(Command::Close).await;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::time::timeout;
    use tokio_serial::SerialStream;

    use super::*;

    fn pair() -> (SerialSession, SerialStream) {
        let (a, b) = SerialStream::pair().unwrap();
        (SerialSession::from_stream(a), b)
    }

    async fn read_until(s: &mut SerialSession, needle: &[u8]) -> Vec<u8> {
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
    async fn receives_bytes_from_device() {
        let (mut s, mut dev) = pair();
        dev.write_all(b"OK\r\n").await.unwrap();
        assert_eq!(read_until(&mut s, b"OK").await, b"OK\r\n");
    }

    #[tokio::test]
    async fn sends_bytes_unmodified() {
        let (mut s, mut dev) = pair();
        s.write(&[0x00, 0xff, b'\r']).await.unwrap();
        let mut buf = [0u8; 3];
        timeout(Duration::from_secs(5), dev.read_exact(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(buf, [0x00, 0xff, b'\r']);
    }

    #[tokio::test]
    async fn device_removal_ends_session_without_freezing() {
        let (mut s, dev) = pair();
        drop(dev); // USB抜去相当
        let end = timeout(Duration::from_secs(5), async {
            while let Ok(Some(_)) = s.read().await {}
        })
        .await;
        assert!(end.is_ok(), "切断を検知できずフリーズした");
        let failed = timeout(Duration::from_secs(5), async {
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
        assert!(failed);
    }

    #[tokio::test]
    async fn close_is_idempotent_and_blocks_use() {
        let (mut s, _dev) = pair();
        s.close().await.unwrap();
        s.close().await.unwrap();
        assert!(matches!(s.write(b"x").await, Err(TerminalError::Closed)));
        assert!(matches!(
            s.resize(TerminalSize::new(80, 24).unwrap()).await,
            Err(TerminalError::Closed)
        ));
    }

    #[tokio::test]
    async fn resize_is_a_noop_while_open() {
        let (mut s, _dev) = pair();
        s.resize(TerminalSize::new(80, 24).unwrap()).await.unwrap();
    }

    #[tokio::test]
    async fn opening_missing_port_fails_with_context() {
        let r = SerialSession::open(&SerialConfig::new("/dev/does-not-exist", 115200));
        match r {
            Err(TerminalError::ConnectionFailed(m)) => assert!(m.contains("/dev/does-not-exist")),
            other => panic!("unexpected: {:?}", other.err()),
        }
    }

    #[tokio::test]
    async fn invalid_config_is_rejected_before_opening() {
        assert!(SerialSession::open(&SerialConfig::new("", 115200)).is_err());
        assert!(SerialSession::open(&SerialConfig::new("/dev/null", 0)).is_err());
    }

    #[test]
    fn config_defaults_to_8n1() {
        let c = SerialConfig::new("/dev/x", 9600);
        assert_eq!(c.data_bits, DataBits::Eight);
        assert_eq!(c.parity, Parity::None);
        assert_eq!(c.stop_bits, StopBits::One);
        assert_eq!(c.flow_control, FlowControl::None);
    }

    #[test]
    fn list_ports_does_not_fail() {
        assert!(list_ports().is_ok());
    }
}

//! シリアル通信セッション（`tokio-serial`）。
//!
//! USB抜去などのI/Oエラーは即座に読み取り側へ通知し、以降の書き込みを失敗させる。

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio_serial::{SerialPort, SerialPortBuilderExt};

use super::{
    ControlSignal, IncomingConverter, RxNewline, TerminalError, TerminalSession, TerminalSize,
    TxNewline, convert_outgoing,
};

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
    /// 送信時の改行（既定は変換なし）。
    #[serde(default)]
    pub tx_newline: TxNewline,
    /// 受信時の改行の表示変換（既定は変換なし）。
    #[serde(default)]
    pub rx_newline: RxNewline,
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
            tx_newline: TxNewline::default(),
            rx_newline: RxNewline::default(),
        }
    }

    fn validate(&self) -> Result<(), TerminalError> {
        if self.port.trim().is_empty() {
            return Err(TerminalError::ConnectionFailed(
                "シリアルポート名が空です".into(),
            ));
        }
        // 手入力されたパスで任意のファイルを開かないよう、デバイスファイル（/dev 以下）に限る。
        let under_dev = self
            .port
            .strip_prefix("/dev/")
            .is_some_and(|rest| !rest.is_empty());
        if !under_dev || self.port.contains("..") || self.port.contains('\0') {
            return Err(TerminalError::ConnectionFailed(format!(
                "シリアルポートは /dev/ 以下のデバイスを指定してください: {}",
                self.port.escape_debug()
            )));
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

/// シリアルポートの制御信号の操作。
pub trait SerialControl: Send {
    fn set_dtr(&mut self, on: bool) -> std::io::Result<()>;
    fn set_rts(&mut self, on: bool) -> std::io::Result<()>;
    fn set_break(&mut self, on: bool) -> std::io::Result<()>;
}

/// 制御信号に対応しないストリーム用（テストの PTY など）。
struct NoControl;

impl SerialControl for NoControl {
    fn set_dtr(&mut self, _: bool) -> std::io::Result<()> {
        Err(std::io::Error::other("対応していません"))
    }
    fn set_rts(&mut self, _: bool) -> std::io::Result<()> {
        Err(std::io::Error::other("対応していません"))
    }
    fn set_break(&mut self, _: bool) -> std::io::Result<()> {
        Err(std::io::Error::other("対応していません"))
    }
}

/// ブレーク信号を出し続ける既定の時間。
pub const DEFAULT_BREAK: std::time::Duration = std::time::Duration::from_millis(250);

type Reply = oneshot::Sender<Result<(), TerminalError>>;

enum Command {
    Data(Vec<u8>),
    Control {
        signal: ControlSignal,
        on: bool,
        reply: Reply,
    },
    Break {
        duration: std::time::Duration,
        reply: Reply,
    },
    Close,
}

type Output = Result<Vec<u8>, TerminalError>;

pub struct SerialSession {
    commands: mpsc::Sender<Command>,
    output: mpsc::Receiver<Output>,
    tx_newline: TxNewline,
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
        // 制御信号の操作は、読み書きと同時に行えるよう複製したハンドルで行う。
        let control = stream
            .try_clone()
            .map(|port| Box::new(NativeControl(port)) as Box<dyn SerialControl>)
            .unwrap_or_else(|_| Box::new(NoControl));
        Ok(Self::build(
            stream,
            control,
            config.tx_newline,
            config.rx_newline,
        ))
    }

    /// 任意の非同期ストリームからセッションを作る（テストでPTYペアを使うため公開）。
    pub fn from_stream<S>(stream: S) -> Self
    where
        S: AsyncRead + AsyncWrite + Send + 'static,
    {
        Self::from_stream_with_control(stream, Box::new(NoControl))
    }

    /// 制御信号の操作つきでセッションを作る。
    pub fn from_stream_with_control<S>(stream: S, control: Box<dyn SerialControl>) -> Self
    where
        S: AsyncRead + AsyncWrite + Send + 'static,
    {
        Self::build(stream, control, TxNewline::default(), RxNewline::default())
    }

    /// 改行変換つきでセッションを作る。
    pub fn from_stream_with_newlines<S>(stream: S, tx: TxNewline, rx: RxNewline) -> Self
    where
        S: AsyncRead + AsyncWrite + Send + 'static,
    {
        Self::build(stream, Box::new(NoControl), tx, rx)
    }

    fn build<S>(
        stream: S,
        control: Box<dyn SerialControl>,
        tx_newline: TxNewline,
        rx_newline: RxNewline,
    ) -> Self
    where
        S: AsyncRead + AsyncWrite + Send + 'static,
    {
        let (cmd_tx, cmd_rx) = mpsc::channel(COMMAND_CAPACITY);
        let (out_tx, out_rx) = mpsc::channel(OUTPUT_CAPACITY);
        let rx_converter = IncomingConverter::new(rx_newline);
        tokio::spawn(pump(stream, control, rx_converter, cmd_rx, out_tx));
        Self {
            commands: cmd_tx,
            output: out_rx,
            tx_newline,
            closed: false,
        }
    }
}

async fn pump<S>(
    stream: S,
    mut control: Box<dyn SerialControl>,
    mut rx_converter: IncomingConverter,
    mut commands: mpsc::Receiver<Command>,
    output: mpsc::Sender<Output>,
) where
    S: AsyncRead + AsyncWrite,
{
    let (mut reader, mut writer) = tokio::io::split(stream);
    let mut buf = vec![0u8; READ_BUFFER_SIZE];
    loop {
        tokio::select! {
            read = reader.read(&mut buf) => match read {
                Ok(0) => break,
                Ok(n) => {
                    if output.send(Ok(rx_converter.convert(&buf[..n]))).await.is_err() {
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
                Some(Command::Control { signal, on, reply }) => {
                    let (name, result) = match signal {
                        ControlSignal::Dtr => ("DTR", control.set_dtr(on)),
                        ControlSignal::Rts => ("RTS", control.set_rts(on)),
                    };
                    let _ = reply.send(
                        result.map_err(|e| TerminalError::io(format!("{name}の設定"), e)),
                    );
                }
                Some(Command::Break { duration, reply }) => {
                    let result = send_break(control.as_mut(), duration).await;
                    let _ = reply.send(result);
                }
                Some(Command::Close) | None => break,
            },
        }
    }
}

/// ブレークを出して `duration` 待ち、解除する。途中で失敗しても解除を試みる。
async fn send_break(
    control: &mut dyn SerialControl,
    duration: std::time::Duration,
) -> Result<(), TerminalError> {
    control
        .set_break(true)
        .map_err(|e| TerminalError::io("ブレーク送信", e))?;
    tokio::time::sleep(duration).await;
    control
        .set_break(false)
        .map_err(|e| TerminalError::io("ブレークの解除", e))
}

/// `tokio-serial` のポート（複製したハンドル）による制御信号の操作。
struct NativeControl(Box<dyn tokio_serial::SerialPort>);

impl SerialControl for NativeControl {
    fn set_dtr(&mut self, on: bool) -> std::io::Result<()> {
        self.0
            .write_data_terminal_ready(on)
            .map_err(|e| std::io::Error::other(e.to_string()))
    }
    fn set_rts(&mut self, on: bool) -> std::io::Result<()> {
        self.0
            .write_request_to_send(on)
            .map_err(|e| std::io::Error::other(e.to_string()))
    }
    fn set_break(&mut self, on: bool) -> std::io::Result<()> {
        let result = if on {
            self.0.set_break()
        } else {
            self.0.clear_break()
        };
        result.map_err(|e| std::io::Error::other(e.to_string()))
    }
}

impl SerialSession {
    /// 指定した長さのブレーク信号を送る。
    pub async fn send_break_for(
        &mut self,
        duration: std::time::Duration,
    ) -> Result<(), TerminalError> {
        let (reply, ack) = oneshot::channel();
        self.send_control(Command::Break { duration, reply }, ack)
            .await
    }

    async fn send_control(
        &mut self,
        command: Command,
        ack: oneshot::Receiver<Result<(), TerminalError>>,
    ) -> Result<(), TerminalError> {
        if self.closed {
            return Err(TerminalError::Closed);
        }
        self.commands
            .send(command)
            .await
            .map_err(|_| TerminalError::Closed)?;
        ack.await.map_err(|_| TerminalError::Closed)?
    }
}

#[async_trait]
impl TerminalSession for SerialSession {
    async fn write(&mut self, data: &[u8]) -> Result<(), TerminalError> {
        if self.closed {
            return Err(TerminalError::Closed);
        }
        self.commands
            .send(Command::Data(convert_outgoing(data, self.tx_newline)))
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

    async fn set_control(&mut self, signal: ControlSignal, on: bool) -> Result<(), TerminalError> {
        let (reply, ack) = oneshot::channel();
        self.send_control(Command::Control { signal, on, reply }, ack)
            .await
    }

    async fn send_break(&mut self) -> Result<(), TerminalError> {
        self.send_break_for(DEFAULT_BREAK).await
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

    use std::sync::{Arc, Mutex};

    use super::super::ControlSignal;

    #[derive(Clone, Default)]
    struct Calls(Arc<Mutex<Vec<(String, std::time::Instant)>>>);

    struct MockControl {
        calls: Calls,
        fail: bool,
    }

    impl MockControl {
        fn record(&self, what: String) -> std::io::Result<()> {
            if self.fail {
                return Err(std::io::Error::other("ioctl failed"));
            }
            self.calls
                .0
                .lock()
                .unwrap()
                .push((what, std::time::Instant::now()));
            Ok(())
        }
    }

    impl SerialControl for MockControl {
        fn set_dtr(&mut self, on: bool) -> std::io::Result<()> {
            self.record(format!("dtr={on}"))
        }
        fn set_rts(&mut self, on: bool) -> std::io::Result<()> {
            self.record(format!("rts={on}"))
        }
        fn set_break(&mut self, on: bool) -> std::io::Result<()> {
            self.record(format!("break={on}"))
        }
    }

    fn controlled(fail: bool) -> (SerialSession, SerialStream, Calls) {
        let (a, b) = SerialStream::pair().unwrap();
        let calls = Calls::default();
        let control = MockControl {
            calls: calls.clone(),
            fail,
        };
        (
            SerialSession::from_stream_with_control(a, Box::new(control)),
            b,
            calls,
        )
    }

    fn names(calls: &Calls) -> Vec<String> {
        calls
            .0
            .lock()
            .unwrap()
            .iter()
            .map(|(n, _)| n.clone())
            .collect()
    }

    #[tokio::test]
    async fn transmit_newline_is_converted() {
        let (a, mut dev) = SerialStream::pair().unwrap();
        let mut s = SerialSession::from_stream_with_newlines(a, TxNewline::CrLf, RxNewline::Raw);
        s.write(b"ls\r").await.unwrap();
        let mut buf = [0u8; 4];
        timeout(Duration::from_secs(5), dev.read_exact(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&buf, b"ls\r\n");
    }

    #[tokio::test]
    async fn received_lf_can_be_shown_as_crlf() {
        let (a, mut dev) = SerialStream::pair().unwrap();
        let mut s = SerialSession::from_stream_with_newlines(a, TxNewline::Cr, RxNewline::LfToCrLf);
        dev.write_all(b"a\nb\r\nc").await.unwrap();
        assert_eq!(read_until(&mut s, b"c").await, b"a\r\nb\r\nc");
    }

    #[tokio::test]
    async fn newlines_are_untouched_by_default() {
        let (mut s, mut dev) = pair();
        dev.write_all(b"a\nb").await.unwrap();
        assert_eq!(read_until(&mut s, b"b").await, b"a\nb");
        s.write(b"x\r").await.unwrap();
        let mut buf = [0u8; 2];
        timeout(Duration::from_secs(5), dev.read_exact(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&buf, b"x\r");
    }

    #[test]
    fn config_newlines_default_to_raw_and_deserialize_without_them() {
        let c = SerialConfig::new("/dev/x", 9600);
        assert_eq!(c.tx_newline, TxNewline::Cr);
        assert_eq!(c.rx_newline, RxNewline::Raw);
        let json = r#"{"port":"/dev/x","baud_rate":9600,"data_bits":"Eight","parity":"None","stop_bits":"One","flow_control":"None"}"#;
        let c: SerialConfig = serde_json::from_str(json).unwrap();
        assert_eq!(c.tx_newline, TxNewline::Cr);
    }

    #[tokio::test]
    async fn dtr_and_rts_are_forwarded_to_the_port() {
        let (mut s, _dev, calls) = controlled(false);
        s.set_control(ControlSignal::Dtr, false).await.unwrap();
        s.set_control(ControlSignal::Rts, true).await.unwrap();
        s.set_control(ControlSignal::Dtr, true).await.unwrap();
        assert_eq!(names(&calls), vec!["dtr=false", "rts=true", "dtr=true"]);
    }

    #[tokio::test]
    async fn break_is_asserted_then_released_after_the_duration() {
        let (mut s, _dev, calls) = controlled(false);
        s.send_break_for(std::time::Duration::from_millis(60))
            .await
            .unwrap();
        assert_eq!(names(&calls), vec!["break=true", "break=false"]);
        let times: Vec<_> = calls.0.lock().unwrap().iter().map(|(_, t)| *t).collect();
        assert!(times[1] - times[0] >= std::time::Duration::from_millis(55));
    }

    #[tokio::test]
    async fn default_break_uses_the_standard_duration() {
        let (mut s, _dev, calls) = controlled(false);
        let started = std::time::Instant::now();
        s.send_break().await.unwrap();
        assert!(started.elapsed() >= DEFAULT_BREAK);
        assert_eq!(names(&calls), vec!["break=true", "break=false"]);
    }

    #[tokio::test]
    async fn streams_without_control_report_unsupported_or_an_io_error() {
        let (mut s, _dev) = pair();
        assert!(s.set_control(ControlSignal::Dtr, true).await.is_err());
        assert!(s.send_break().await.is_err());
    }

    #[tokio::test]
    async fn control_failures_are_reported_with_context() {
        let (mut s, _dev, _calls) = controlled(true);
        let err = s.set_control(ControlSignal::Rts, true).await.unwrap_err();
        assert!(err.to_string().contains("RTS"), "{err}");
        assert!(err.to_string().contains("ioctl failed"), "{err}");
        let err = s.send_break().await.unwrap_err();
        assert!(err.to_string().contains("ioctl failed"), "{err}");
    }

    #[tokio::test]
    async fn control_after_close_is_an_error() {
        let (mut s, _dev, _calls) = controlled(false);
        s.close().await.unwrap();
        assert!(matches!(
            s.set_control(ControlSignal::Dtr, true).await,
            Err(TerminalError::Closed)
        ));
        assert!(matches!(s.send_break().await, Err(TerminalError::Closed)));
    }

    #[tokio::test]
    async fn data_still_flows_after_control_operations() {
        let (mut s, mut dev, _calls) = controlled(false);
        s.set_control(ControlSignal::Dtr, false).await.unwrap();
        dev.write_all(b"OK").await.unwrap();
        assert_eq!(read_until(&mut s, b"OK").await, b"OK");
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
    fn manually_typed_port_names_must_be_device_files_under_dev() {
        for bad in [
            "/etc/passwd",
            "relative/path",
            "COM3",
            "/dev/../etc/passwd",
            "/dev/",
            "/dev",
            "/devices/x",
            "/dev/tty\u{0}x",
        ] {
            let r = SerialSession::open(&SerialConfig::new(bad, 115200));
            match r {
                Err(TerminalError::ConnectionFailed(m)) => {
                    assert!(m.contains("/dev/"), "{bad}: {m}")
                }
                other => panic!("{bad} が受理された: {:?}", other.err()),
            }
        }
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

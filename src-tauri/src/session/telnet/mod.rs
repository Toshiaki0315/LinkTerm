//! Telnet セッション（TCP + IAC交渉）。

pub mod protocol;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, tcp::OwnedWriteHalf};
use tokio::sync::mpsc;
use tokio::time::timeout;

use self::protocol::{Negotiator, TelnetEvent, TelnetParser, escape_iac};
use super::{
    IncomingConverter, RxNewline, TerminalError, TerminalSession, TerminalSize, TxNewline,
    convert_outgoing,
};

const READ_BUFFER_SIZE: usize = 8192;
const OUTPUT_CAPACITY: usize = 64;
const COMMAND_CAPACITY: usize = 64;

/// Telnet の接続設定。
pub struct TelnetConfig {
    pub host: String,
    pub port: u16,
    pub size: TerminalSize,
    pub term: String,
    pub tx_newline: TxNewline,
    pub rx_newline: RxNewline,
    pub connect_timeout: Duration,
}

enum Command {
    Data(Vec<u8>),
    Resize(TerminalSize),
    Close,
}

type Output = Result<Vec<u8>, TerminalError>;

pub struct TelnetSession {
    commands: mpsc::Sender<Command>,
    output: mpsc::Receiver<Output>,
    remote_echo: Arc<AtomicBool>,
    tx_newline: TxNewline,
    closed: bool,
}

impl TelnetSession {
    pub async fn connect(config: TelnetConfig) -> Result<Self, TerminalError> {
        let addr = format!("{}:{}", config.host, config.port);
        let stream = timeout(
            config.connect_timeout,
            TcpStream::connect((config.host.as_str(), config.port)),
        )
        .await
        .map_err(|_| {
            TerminalError::ConnectionFailed(format!("{addr} への接続がタイムアウトしました"))
        })?
        .map_err(|e| TerminalError::ConnectionFailed(format!("{addr} への接続: {e}")))?;
        stream
            .set_nodelay(true)
            .map_err(|e| TerminalError::io("TCP_NODELAYの設定", e))?;

        let negotiator = Negotiator::new(&config.term, config.size.cols, config.size.rows);
        let remote_echo = Arc::new(AtomicBool::new(false));
        let (cmd_tx, cmd_rx) = mpsc::channel(COMMAND_CAPACITY);
        let (out_tx, out_rx) = mpsc::channel(OUTPUT_CAPACITY);
        tokio::spawn(pump(
            stream,
            negotiator,
            IncomingConverter::new(config.rx_newline),
            remote_echo.clone(),
            cmd_rx,
            out_tx,
        ));

        Ok(Self {
            commands: cmd_tx,
            output: out_rx,
            remote_echo,
            tx_newline: config.tx_newline,
            closed: false,
        })
    }

    /// サーバーが ECHO を担当しているか。`false` ならローカルエコーが必要な場合がある。
    pub fn remote_echo(&self) -> bool {
        self.remote_echo.load(Ordering::Relaxed)
    }
}

async fn pump(
    stream: TcpStream,
    mut negotiator: Negotiator,
    mut rx_converter: IncomingConverter,
    remote_echo: Arc<AtomicBool>,
    mut commands: mpsc::Receiver<Command>,
    output: mpsc::Sender<Output>,
) {
    let (mut reader, mut writer) = stream.into_split();
    let mut parser = TelnetParser::new();
    let mut buf = vec![0u8; READ_BUFFER_SIZE];
    loop {
        tokio::select! {
            read = reader.read(&mut buf) => match read {
                Ok(0) => break,
                Ok(n) => {
                    let mut reply = Vec::new();
                    for event in parser.feed(&buf[..n]) {
                        match &event {
                            TelnetEvent::Data(d) => {
                                let converted = rx_converter.convert(d);
                                if output.send(Ok(converted)).await.is_err() {
                                    return;
                                }
                            }
                            _ => reply.extend(negotiator.handle(&event)),
                        }
                    }
                    let echo = negotiator.remote_echo();
                    if remote_echo.swap(echo, Ordering::Relaxed) != echo {
                        // データを伴わない交渉でも、呼び出し側が状態を確認できるよう空のチャンクで起こす。
                        if output.send(Ok(Vec::new())).await.is_err() {
                            return;
                        }
                    }
                    if !reply.is_empty() && write_all(&mut writer, &reply, &output).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = output.send(Err(TerminalError::io("Telnet受信", e))).await;
                    break;
                }
            },
            cmd = commands.recv() => match cmd {
                Some(Command::Data(data)) => {
                    if write_all(&mut writer, &data, &output).await.is_err() {
                        break;
                    }
                }
                Some(Command::Resize(size)) => {
                    if let Some(naws) = negotiator.resize(size.cols, size.rows)
                        && write_all(&mut writer, &naws, &output).await.is_err()
                    {
                        break;
                    }
                }
                Some(Command::Close) | None => break,
            },
        }
    }
    let _ = writer.shutdown().await;
}

/// 書き込みに失敗したらエラーを読み取り側へ通知する。
async fn write_all(
    writer: &mut OwnedWriteHalf,
    data: &[u8],
    output: &mpsc::Sender<Output>,
) -> Result<(), ()> {
    if let Err(e) = writer.write_all(data).await {
        let _ = output.send(Err(TerminalError::io("Telnet送信", e))).await;
        return Err(());
    }
    Ok(())
}

#[async_trait]
impl TerminalSession for TelnetSession {
    async fn write(&mut self, data: &[u8]) -> Result<(), TerminalError> {
        if self.closed {
            return Err(TerminalError::Closed);
        }
        let payload = escape_iac(&convert_outgoing(data, self.tx_newline));
        self.commands
            .send(Command::Data(payload))
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
            // 既に切断済みなら送信失敗してよい。
            let _ = self.commands.send(Command::Close).await;
        }
        Ok(())
    }

    fn echo_state(&self) -> Option<bool> {
        Some(self.remote_echo())
    }
}

#[cfg(test)]
mod tests;

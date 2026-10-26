//! 複数のターミナルセッションを管理し、入出力をイベントとして通知する。

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use thiserror::Error;
use tokio::sync::{Mutex, mpsc};

use crate::session::{TerminalError, TerminalSession, TerminalSize};

#[derive(Debug, Error)]
pub enum ManagerError {
    #[error("セッション {0} は存在しません")]
    UnknownSession(String),
    #[error("セッション操作に失敗しました: {0}")]
    Session(#[from] TerminalError),
}

/// セッションからの通知先。Tauri では `emit` に変換される。
pub trait EventSink: Send + Sync + 'static {
    fn data(&self, id: &str, data: &[u8]);
    /// セッション終了。`reason` はエラーによる終了時のみ。
    fn closed(&self, id: &str, reason: Option<String>);
}

type Sessions = Arc<Mutex<HashMap<String, mpsc::Sender<Command>>>>;

const COMMAND_CAPACITY: usize = 256;

enum Command {
    Write(Vec<u8>),
    Resize(TerminalSize),
    Close,
}

pub struct SessionManager {
    sink: Arc<dyn EventSink>,
    sessions: Sessions,
    next_id: AtomicU64,
}

impl SessionManager {
    pub fn new(sink: Arc<dyn EventSink>) -> Self {
        Self {
            sink,
            sessions: Arc::default(),
            next_id: AtomicU64::new(1),
        }
    }

    /// セッションを登録し、入出力の仲介を開始してIDを返す。
    pub async fn start(&self, session: Box<dyn TerminalSession>) -> String {
        let id = format!("session-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = mpsc::channel(COMMAND_CAPACITY);
        self.sessions.lock().await.insert(id.clone(), tx);
        tokio::spawn(run_session(
            id.clone(),
            session,
            rx,
            self.sink.clone(),
            self.sessions.clone(),
        ));
        id
    }

    async fn sender(&self, id: &str) -> Result<mpsc::Sender<Command>, ManagerError> {
        self.sessions
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| ManagerError::UnknownSession(id.to_owned()))
    }

    async fn send(&self, id: &str, command: Command) -> Result<(), ManagerError> {
        self.sender(id)
            .await?
            .send(command)
            .await
            .map_err(|_| ManagerError::UnknownSession(id.to_owned()))
    }

    pub async fn write(&self, id: &str, data: Vec<u8>) -> Result<(), ManagerError> {
        self.send(id, Command::Write(data)).await
    }

    pub async fn resize(&self, id: &str, size: TerminalSize) -> Result<(), ManagerError> {
        self.send(id, Command::Resize(size)).await
    }

    /// セッションを閉じる。以降そのIDへの操作は `UnknownSession` になる。
    pub async fn close(&self, id: &str) -> Result<(), ManagerError> {
        let tx = self
            .sessions
            .lock()
            .await
            .remove(id)
            .ok_or_else(|| ManagerError::UnknownSession(id.to_owned()))?;
        // 既に終了している場合は送信失敗してよい。
        let _ = tx.send(Command::Close).await;
        Ok(())
    }

    /// アプリ終了時に全セッションを閉じる。
    pub async fn close_all(&self) {
        let all: Vec<_> = self.sessions.lock().await.drain().collect();
        for (_, tx) in all {
            let _ = tx.send(Command::Close).await;
        }
    }

    pub async fn session_count(&self) -> usize {
        self.sessions.lock().await.len()
    }
}

/// 1セッションを所有し、受信とコマンド処理を1タスクで仲介する。
/// `read()` はキャンセル安全であることを前提とする。
async fn run_session(
    id: String,
    mut session: Box<dyn TerminalSession>,
    mut commands: mpsc::Receiver<Command>,
    sink: Arc<dyn EventSink>,
    sessions: Sessions,
) {
    let reason = loop {
        tokio::select! {
            read = session.read() => match read {
                Ok(Some(data)) => sink.data(&id, &data),
                Ok(None) => break None,
                Err(e) => break Some(e.to_string()),
            },
            cmd = commands.recv() => match cmd {
                Some(Command::Write(data)) => {
                    if let Err(e) = session.write(&data).await {
                        break Some(e.to_string());
                    }
                }
                Some(Command::Resize(size)) => {
                    if let Err(e) = session.resize(size).await {
                        break Some(e.to_string());
                    }
                }
                Some(Command::Close) | None => break None,
            },
        }
    };
    let close_result = session.close().await;
    sessions.lock().await.remove(&id);
    let reason = reason.or_else(|| {
        close_result
            .err()
            .map(|e| format!("終了処理に失敗しました: {e}"))
    });
    sink.closed(&id, reason);
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;

    use async_trait::async_trait;
    use tokio::time::timeout;

    use super::*;

    #[derive(Default)]
    struct RecordingSink {
        data: StdMutex<Vec<(String, Vec<u8>)>>,
        closed: StdMutex<Vec<(String, Option<String>)>>,
    }

    impl EventSink for RecordingSink {
        fn data(&self, id: &str, data: &[u8]) {
            self.data.lock().unwrap().push((id.into(), data.to_vec()));
        }
        fn closed(&self, id: &str, reason: Option<String>) {
            self.closed.lock().unwrap().push((id.into(), reason));
        }
    }

    impl RecordingSink {
        fn received(&self, id: &str) -> Vec<u8> {
            self.data
                .lock()
                .unwrap()
                .iter()
                .filter(|(i, _)| i == id)
                .flat_map(|(_, d)| d.clone())
                .collect()
        }
    }

    type SharedSize = Arc<StdMutex<Option<TerminalSize>>>;
    type SharedFlag = Arc<StdMutex<bool>>;

    /// 書き込みをエコーし、"fail" を書くと受信エラーで終わるテスト用セッション。
    struct EchoSession {
        tx: mpsc::UnboundedSender<Result<Vec<u8>, TerminalError>>,
        rx: mpsc::UnboundedReceiver<Result<Vec<u8>, TerminalError>>,
        size: Arc<StdMutex<Option<TerminalSize>>>,
        closed: Arc<StdMutex<bool>>,
    }

    impl EchoSession {
        fn new() -> (Self, SharedSize, SharedFlag) {
            let (tx, rx) = mpsc::unbounded_channel();
            let size = Arc::new(StdMutex::new(None));
            let closed = Arc::new(StdMutex::new(false));
            (
                Self {
                    tx,
                    rx,
                    size: size.clone(),
                    closed: closed.clone(),
                },
                size,
                closed,
            )
        }
    }

    #[async_trait]
    impl TerminalSession for EchoSession {
        async fn write(&mut self, data: &[u8]) -> Result<(), TerminalError> {
            if data == b"fail" {
                let _ = self.tx.send(Err(TerminalError::Closed));
            } else if data == b"eof" {
                // 送信側を閉じることで read が None になるよう、ダミーを置き換える
                let (_tx, rx) = mpsc::unbounded_channel();
                self.rx = rx;
            } else {
                let _ = self.tx.send(Ok(data.to_vec()));
            }
            Ok(())
        }
        async fn read(&mut self) -> Result<Option<Vec<u8>>, TerminalError> {
            match self.rx.recv().await {
                Some(r) => r.map(Some),
                None => Ok(None),
            }
        }
        async fn resize(&mut self, size: TerminalSize) -> Result<(), TerminalError> {
            *self.size.lock().unwrap() = Some(size);
            Ok(())
        }
        async fn close(&mut self) -> Result<(), TerminalError> {
            *self.closed.lock().unwrap() = true;
            Ok(())
        }
    }

    async fn wait_for(mut cond: impl FnMut() -> bool) {
        timeout(Duration::from_secs(5), async {
            while !cond() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("条件が満たされずタイムアウト");
    }

    fn setup() -> (SessionManager, Arc<RecordingSink>) {
        let sink = Arc::new(RecordingSink::default());
        (SessionManager::new(sink.clone()), sink)
    }

    #[tokio::test]
    async fn write_is_forwarded_and_output_emitted() {
        let (m, sink) = setup();
        let (s, _, _) = EchoSession::new();
        let id = m.start(Box::new(s)).await;
        m.write(&id, b"hello".to_vec()).await.unwrap();
        wait_for(|| sink.received(&id) == b"hello").await;
    }

    #[tokio::test]
    async fn ids_are_unique_and_outputs_isolated() {
        let (m, sink) = setup();
        let (a, _, _) = EchoSession::new();
        let (b, _, _) = EchoSession::new();
        let ia = m.start(Box::new(a)).await;
        let ib = m.start(Box::new(b)).await;
        assert_ne!(ia, ib);
        m.write(&ia, b"A".to_vec()).await.unwrap();
        m.write(&ib, b"B".to_vec()).await.unwrap();
        wait_for(|| sink.received(&ia) == b"A" && sink.received(&ib) == b"B").await;
        assert_eq!(m.session_count().await, 2);
    }

    #[tokio::test]
    async fn resize_reaches_session() {
        let (m, _) = setup();
        let (s, size, _) = EchoSession::new();
        let id = m.start(Box::new(s)).await;
        let want = TerminalSize::new(100, 30).unwrap();
        m.resize(&id, want).await.unwrap();
        wait_for(|| *size.lock().unwrap() == Some(want)).await;
    }

    #[tokio::test]
    async fn close_closes_session_and_notifies_without_reason() {
        let (m, sink) = setup();
        let (s, _, closed) = EchoSession::new();
        let id = m.start(Box::new(s)).await;
        m.close(&id).await.unwrap();
        wait_for(|| *closed.lock().unwrap()).await;
        wait_for(|| !sink.closed.lock().unwrap().is_empty()).await;
        assert_eq!(sink.closed.lock().unwrap()[0], (id.clone(), None));
        assert_eq!(m.session_count().await, 0);
        assert!(matches!(
            m.write(&id, b"x".to_vec()).await,
            Err(ManagerError::UnknownSession(_))
        ));
    }

    #[tokio::test]
    async fn remote_end_of_stream_notifies_closed_and_removes_session() {
        let (m, sink) = setup();
        let (s, _, _) = EchoSession::new();
        let id = m.start(Box::new(s)).await;
        m.write(&id, b"eof".to_vec()).await.unwrap();
        wait_for(|| !sink.closed.lock().unwrap().is_empty()).await;
        assert_eq!(sink.closed.lock().unwrap()[0], (id.clone(), None));
        wait_for_count(&m, 0).await;
    }

    #[tokio::test]
    async fn read_error_notifies_closed_with_reason() {
        let (m, sink) = setup();
        let (s, _, _) = EchoSession::new();
        let id = m.start(Box::new(s)).await;
        m.write(&id, b"fail".to_vec()).await.unwrap();
        wait_for(|| !sink.closed.lock().unwrap().is_empty()).await;
        let (cid, reason) = sink.closed.lock().unwrap()[0].clone();
        assert_eq!(cid, id);
        assert!(reason.is_some());
        wait_for_count(&m, 0).await;
    }

    async fn wait_for_count(m: &SessionManager, n: usize) {
        timeout(Duration::from_secs(5), async {
            while m.session_count().await != n {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("セッション数が期待値にならない");
    }

    #[tokio::test]
    async fn unknown_session_is_an_error() {
        let (m, _) = setup();
        assert!(matches!(
            m.write("nope", vec![]).await,
            Err(ManagerError::UnknownSession(_))
        ));
        assert!(matches!(
            m.resize("nope", TerminalSize::new(1, 1).unwrap()).await,
            Err(ManagerError::UnknownSession(_))
        ));
        assert!(matches!(
            m.close("nope").await,
            Err(ManagerError::UnknownSession(_))
        ));
    }

    #[tokio::test]
    async fn close_all_closes_every_session() {
        let (m, _) = setup();
        let (a, _, ca) = EchoSession::new();
        let (b, _, cb) = EchoSession::new();
        m.start(Box::new(a)).await;
        m.start(Box::new(b)).await;
        m.close_all().await;
        wait_for(|| *ca.lock().unwrap() && *cb.lock().unwrap()).await;
    }
}

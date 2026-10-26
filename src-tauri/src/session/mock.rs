use std::collections::VecDeque;

use async_trait::async_trait;

use super::{TerminalError, TerminalSession, TerminalSize};

/// テスト用セッション。書き込んだデータをそのまま受信キューへエコーする。
#[derive(Debug, Default)]
pub struct MockSession {
    inbox: VecDeque<Vec<u8>>,
    size: Option<TerminalSize>,
    closed: bool,
}

impl MockSession {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn last_size(&self) -> Option<TerminalSize> {
        self.size
    }
}

#[async_trait]
impl TerminalSession for MockSession {
    async fn write(&mut self, data: &[u8]) -> Result<(), TerminalError> {
        if self.closed {
            return Err(TerminalError::Closed);
        }
        self.inbox.push_back(data.to_vec());
        Ok(())
    }

    async fn read(&mut self) -> Result<Option<Vec<u8>>, TerminalError> {
        Ok(self.inbox.pop_front())
    }

    async fn resize(&mut self, size: TerminalSize) -> Result<(), TerminalError> {
        if self.closed {
            return Err(TerminalError::Closed);
        }
        self.size = Some(size);
        Ok(())
    }

    async fn close(&mut self) -> Result<(), TerminalError> {
        self.closed = true;
        self.inbox.clear();
        Ok(())
    }
}

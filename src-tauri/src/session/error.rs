use thiserror::Error;

/// ターミナルセッション共通のエラー型。
#[derive(Debug, Error)]
pub enum TerminalError {
    #[error("接続に失敗しました: {0}")]
    ConnectionFailed(String),
    #[error("接続が切断されました: {0}")]
    Disconnected(String),
    #[error("認証に失敗しました: {0}")]
    AuthenticationFailed(String),
    #[error("ホスト鍵を信頼できません: {0}")]
    HostKeyRejected(String),
    #[error("未対応の文字コードです: {0}")]
    UnsupportedEncoding(String),
    #[error("セッションは既に閉じられています")]
    Closed,
    #[error("無効なサイズです: {cols}x{rows}")]
    InvalidSize { cols: u16, rows: u16 },
    #[error("I/Oエラー ({context}): {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
}

impl TerminalError {
    /// `std::io::Error` に文脈を付与して変換する。
    pub fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        Self::Io {
            context: context.into(),
            source,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error;

    #[test]
    fn io_error_keeps_context_and_source() {
        let err = TerminalError::io(
            "シリアルポートの読み取り",
            std::io::Error::new(std::io::ErrorKind::BrokenPipe, "device removed"),
        );
        assert!(err.to_string().contains("シリアルポートの読み取り"));
        assert!(err.source().is_some());
    }

    #[test]
    fn invalid_size_message_contains_dimensions() {
        let err = TerminalError::InvalidSize { cols: 0, rows: 24 };
        assert_eq!(err.to_string(), "無効なサイズです: 0x24");
    }

    #[test]
    fn disconnected_message_has_no_redundant_prefix() {
        let err = TerminalError::Disconnected("リモートが接続を閉じました".into());
        assert_eq!(
            err.to_string(),
            "接続が切断されました: リモートが接続を閉じました"
        );
    }
}

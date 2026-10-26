//! セッションログ（Tee分岐）。受信データを表示とは独立にファイルへ記録する。

use std::fs::{File, OpenOptions, Permissions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum LogError {
    #[error("ログファイルの操作に失敗しました ({context}): {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LogMode {
    /// 受信した生バイト列をそのまま記録する（文字コード変換前）。
    Raw,
    /// エスケープシーケンスを除いた表示テキストを記録する。
    Text,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogConfig {
    pub path: PathBuf,
    pub mode: LogMode,
    /// 各行の先頭に時刻を付ける（`Text` モードのみ有効）。
    pub timestamps: bool,
    /// 既存ファイルに追記する。`false` なら上書き。
    pub append: bool,
}

pub type Clock = Box<dyn Fn() -> String + Send>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FilterState {
    Normal,
    Esc,
    /// ESC の後に続く中間バイト（`ESC ( B` など）。
    EscIntermediate,
    Csi,
    /// OSC / DCS などの文字列。BEL または ST (`ESC \`) で終わる。
    Str,
    StrEsc,
}

/// 端末の制御シーケンスを取り除き、表示テキストだけを残す。チャンク境界をまたぐ。
///
/// バックスペースやカーソル移動による上書きは再現せず、単純に捨てる。
#[derive(Debug)]
struct TextFilter {
    state: FilterState,
}

impl TextFilter {
    fn new() -> Self {
        Self {
            state: FilterState::Normal,
        }
    }

    fn feed(&mut self, text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        for ch in text.chars() {
            self.step(ch, &mut out);
        }
        out
    }

    fn step(&mut self, ch: char, out: &mut String) {
        use FilterState::*;
        match self.state {
            Normal => match ch {
                '\x1b' => self.state = Esc,
                '\n' | '\t' => out.push(ch),
                c if c.is_control() => {}
                c => out.push(c),
            },
            Esc => {
                self.state = match ch {
                    '[' => Csi,
                    ']' | 'P' | 'X' | '^' | '_' => Str,
                    '\u{20}'..='\u{2f}' => EscIntermediate,
                    _ => Normal,
                };
            }
            EscIntermediate => {
                if !matches!(ch, '\u{20}'..='\u{2f}') {
                    self.state = Normal;
                }
            }
            Csi => match ch {
                '\u{40}'..='\u{7e}' => self.state = Normal,
                '\x1b' => self.state = Esc,
                _ => {}
            },
            Str => match ch {
                '\u{07}' => self.state = Normal,
                '\x1b' => self.state = StrEsc,
                _ => {}
            },
            StrEsc => {
                if ch == '\\' {
                    self.state = Normal;
                } else {
                    // ST 以外の ESC は新しいシーケンスの開始とみなす。
                    self.state = Esc;
                    self.step(ch, out);
                }
            }
        }
    }
}

pub struct SessionLogger {
    writer: Box<dyn Write + Send>,
    mode: LogMode,
    timestamps: bool,
    clock: Clock,
    filter: TextFilter,
    at_line_start: bool,
    /// 上書きモードで未実行の切り詰め。登録が確定するまで既存の内容を残すため遅延させる。
    pending_truncate: Option<File>,
    path_display: String,
}

fn io_error(context: impl Into<String>, source: std::io::Error) -> LogError {
    LogError::Io {
        context: context.into(),
        source,
    }
}

impl SessionLogger {
    /// 所有者のみ読み書き可能（0600）で開く。既存ファイルの権限も0600に変更する。
    pub fn open(config: &LogConfig) -> Result<Self, LogError> {
        let display = config.path.display().to_string();
        if config.path.as_os_str().is_empty() {
            return Err(io_error(
                "パスが空です",
                std::io::Error::from(std::io::ErrorKind::InvalidInput),
            ));
        }
        let mut options = OpenOptions::new();
        options.create(true).write(true).mode(0o600);
        if config.append {
            options.append(true);
        }
        let file = options
            .open(&config.path)
            .map_err(|e| io_error(format!("{display} を開く"), e))?;
        // `mode()` は新規作成時にしか効かないため、既存ファイルの権限も絞る。
        file.set_permissions(Permissions::from_mode(0o600))
            .map_err(|e| io_error(format!("{display} の権限設定"), e))?;
        // 上書きの場合も、ここでは切り詰めない。`activate` か最初の `record` で実行する。
        let pending_truncate = if config.append {
            None
        } else {
            Some(
                file.try_clone()
                    .map_err(|e| io_error(format!("{display} の複製"), e))?,
            )
        };
        let mut logger = Self::with_writer(
            Box::new(file),
            config.mode,
            config.timestamps,
            Box::new(|| chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()),
        );
        logger.pending_truncate = pending_truncate;
        logger.path_display = display;
        Ok(logger)
    }

    pub fn with_writer(
        writer: Box<dyn Write + Send>,
        mode: LogMode,
        timestamps: bool,
        clock: Clock,
    ) -> Self {
        Self {
            writer,
            mode,
            timestamps,
            clock,
            filter: TextFilter::new(),
            at_line_start: true,
            pending_truncate: None,
            path_display: String::new(),
        }
    }

    /// 上書きモードの切り詰めを実行する。登録が確定した時点で呼ぶ（呼ばなくても最初の `record` で実行される）。
    pub fn activate(&mut self) -> Result<(), LogError> {
        if let Some(file) = self.pending_truncate.take() {
            file.set_len(0)
                .map_err(|e| io_error(format!("{} の切り詰め", self.path_display), e))?;
        }
        Ok(())
    }

    /// `raw` は文字コード変換前の受信バイト列、`text` は変換後のUTF-8。
    pub fn record(&mut self, raw: &[u8], text: &str) -> Result<(), LogError> {
        self.activate()?;
        match self.mode {
            LogMode::Raw => self.write(raw),
            LogMode::Text => {
                let plain = self.filter.feed(text);
                if plain.is_empty() {
                    return Ok(());
                }
                let rendered = self.render(&plain);
                self.write(rendered.as_bytes())
            }
        }
    }

    fn render(&mut self, plain: &str) -> String {
        if !self.timestamps {
            return plain.to_owned();
        }
        let mut out = String::with_capacity(plain.len() + 24);
        for ch in plain.chars() {
            if self.at_line_start {
                out.push_str(&format!("[{}] ", (self.clock)()));
            }
            out.push(ch);
            self.at_line_start = ch == '\n';
        }
        out
    }

    fn write(&mut self, data: &[u8]) -> Result<(), LogError> {
        self.writer
            .write_all(data)
            .and_then(|()| self.writer.flush())
            .map_err(|e| io_error("書き込み", e))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[derive(Clone, Default)]
    struct Buf(Arc<Mutex<Vec<u8>>>);

    impl Write for Buf {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(data);
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Buf {
        fn text(&self) -> String {
            String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
        }
    }

    fn clock() -> Clock {
        Box::new(|| "T".to_string())
    }

    fn logger(mode: LogMode, timestamps: bool) -> (SessionLogger, Buf) {
        let buf = Buf::default();
        (
            SessionLogger::with_writer(Box::new(buf.clone()), mode, timestamps, clock()),
            buf,
        )
    }

    /// 文字列を1チャンクとして記録する（rawは使わないモード用）。
    fn text(l: &mut SessionLogger, s: &str) {
        l.record(s.as_bytes(), s).unwrap();
    }

    #[test]
    fn raw_mode_writes_exact_bytes_before_decoding() {
        let (mut l, buf) = logger(LogMode::Raw, false);
        l.record(&[0x1b, b'[', b'0', b'm', 0xff, 0x93, 0xfa], "ignored")
            .unwrap();
        assert_eq!(
            *buf.0.lock().unwrap(),
            vec![0x1b, b'[', b'0', b'm', 0xff, 0x93, 0xfa]
        );
    }

    #[test]
    fn raw_mode_ignores_timestamps() {
        let (mut l, buf) = logger(LogMode::Raw, true);
        l.record(b"a\nb", "a\nb").unwrap();
        assert_eq!(buf.text(), "a\nb");
    }

    #[test]
    fn text_mode_strips_csi_sequences() {
        let (mut l, buf) = logger(LogMode::Text, false);
        text(&mut l, "\x1b[1;32mgreen\x1b[0m plain\x1b[2K\x1b[10;5H!");
        assert_eq!(buf.text(), "green plain!");
    }

    #[test]
    fn text_mode_strips_osc_and_other_escapes() {
        let (mut l, buf) = logger(LogMode::Text, false);
        text(
            &mut l,
            "a\x1b]0;window title\x07b\x1b]2;t\x1b\\c\x1b(Bd\x1b=e",
        );
        assert_eq!(buf.text(), "abcde");
    }

    #[test]
    fn text_mode_handles_sequences_split_across_chunks() {
        let (mut l, buf) = logger(LogMode::Text, false);
        text(&mut l, "x\x1b[3");
        text(&mut l, "1my\x1b]0;ti");
        text(&mut l, "tle\x07z");
        assert_eq!(buf.text(), "xyz");
    }

    #[test]
    fn text_mode_normalizes_newlines_and_drops_control_chars() {
        let (mut l, buf) = logger(LogMode::Text, false);
        text(&mut l, "a\r\nb\rc\x07\x08\td\n");
        assert_eq!(buf.text(), "a\nbc\td\n");
    }

    #[test]
    fn crlf_split_across_chunks_is_a_single_newline() {
        let (mut l, buf) = logger(LogMode::Text, false);
        text(&mut l, "a\r");
        text(&mut l, "\nb");
        assert_eq!(buf.text(), "a\nb");
    }

    #[test]
    fn text_mode_keeps_non_ascii() {
        let (mut l, buf) = logger(LogMode::Text, false);
        text(&mut l, "日本語\n");
        assert_eq!(buf.text(), "日本語\n");
    }

    #[test]
    fn timestamps_prefix_each_line_but_not_a_trailing_empty_one() {
        let (mut l, buf) = logger(LogMode::Text, true);
        text(&mut l, "one\ntw");
        text(&mut l, "o\n");
        assert_eq!(buf.text(), "[T] one\n[T] two\n");
        text(&mut l, "three");
        assert_eq!(buf.text(), "[T] one\n[T] two\n[T] three");
    }

    #[test]
    fn write_errors_are_reported_with_context() {
        struct Failing;
        impl Write for Failing {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("disk full"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut l = SessionLogger::with_writer(Box::new(Failing), LogMode::Text, false, clock());
        let err = l.record(b"x", "x").unwrap_err();
        assert!(err.to_string().contains("disk full"));
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("linkterm-log-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn config(path: PathBuf, append: bool) -> LogConfig {
        LogConfig {
            path,
            mode: LogMode::Text,
            timestamps: false,
            append,
        }
    }

    #[test]
    fn open_creates_private_file_and_writes() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("open");
        let path = dir.join("s.log");
        let mut l = SessionLogger::open(&config(path.clone(), false)).unwrap();
        text(&mut l, "hello\n");
        drop(l);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello\n");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn existing_file_permissions_are_tightened_to_0600() {
        use std::os::unix::fs::PermissionsExt;
        for append in [true, false] {
            let dir = temp_dir(&format!("perm-{append}"));
            let path = dir.join("s.log");
            std::fs::write(&path, "old\n").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            let l = SessionLogger::open(&config(path.clone(), append)).unwrap();
            drop(l);
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "append={append}");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn append_keeps_existing_content_and_overwrite_truncates() {
        let dir = temp_dir("append");
        let path = dir.join("s.log");
        std::fs::write(&path, "old\n").unwrap();
        let mut l = SessionLogger::open(&config(path.clone(), true)).unwrap();
        text(&mut l, "new\n");
        drop(l);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "old\nnew\n");
        let mut l = SessionLogger::open(&config(path.clone(), false)).unwrap();
        text(&mut l, "x");
        drop(l);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "x");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn overwrite_is_deferred_until_activation() {
        let dir = temp_dir("deferred");
        let path = dir.join("s.log");
        std::fs::write(&path, "old\n").unwrap();
        // 開いただけで登録されずに破棄された場合、既存ファイルは失われない。
        let l = SessionLogger::open(&config(path.clone(), false)).unwrap();
        drop(l);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "old\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn activation_truncates_and_writes_start_at_the_beginning() {
        let dir = temp_dir("activate");
        let path = dir.join("s.log");
        std::fs::write(&path, "old content that is long\n").unwrap();
        let mut l = SessionLogger::open(&config(path.clone(), false)).unwrap();
        l.activate().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
        text(&mut l, "new");
        drop(l);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn first_record_truncates_even_without_explicit_activation() {
        let dir = temp_dir("lazy");
        let path = dir.join("s.log");
        std::fs::write(&path, "old content that is long\n").unwrap();
        let mut l = SessionLogger::open(&config(path.clone(), false)).unwrap();
        text(&mut l, "x");
        text(&mut l, "y");
        drop(l);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "xy");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn activation_is_a_noop_for_append_mode() {
        let dir = temp_dir("activate-append");
        let path = dir.join("s.log");
        std::fs::write(&path, "old\n").unwrap();
        let mut l = SessionLogger::open(&config(path.clone(), true)).unwrap();
        l.activate().unwrap();
        text(&mut l, "new\n");
        drop(l);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "old\nnew\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn open_fails_with_path_in_message() {
        let err = SessionLogger::open(&config("/nonexistent-dir/x.log".into(), false))
            .err()
            .unwrap();
        assert!(err.to_string().contains("/nonexistent-dir/x.log"));
    }

    #[test]
    fn open_rejects_empty_path_and_directories() {
        assert!(SessionLogger::open(&config(PathBuf::new(), false)).is_err());
        let dir = temp_dir("isdir");
        assert!(SessionLogger::open(&config(dir.clone(), false)).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_serializes_in_camel_case() {
        let c = LogConfig {
            path: "/tmp/a.log".into(),
            mode: LogMode::Raw,
            timestamps: true,
            append: false,
        };
        let json = serde_json::to_value(&c).unwrap();
        assert_eq!(json["timestamps"], true);
        assert_eq!(json["mode"], "Raw");
        let back: LogConfig = serde_json::from_value(json).unwrap();
        assert_eq!(back, c);
    }
}

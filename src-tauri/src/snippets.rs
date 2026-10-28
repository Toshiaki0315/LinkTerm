//! スニペット（よく使うコマンド・定型の入力列）の保存。
//!
//! アプリのデータフォルダへ平文の JSON として保存する（所有者のみ読み書き可）。
//! パスワードなどの秘密情報は入れないこと（画面側でも注意を表示する）。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const MAX_SNIPPETS: usize = 100;
pub const MAX_NAME_CHARS: usize = 60;
pub const MAX_TEXT_CHARS: usize = 10_000;
pub const MAX_ID_CHARS: usize = 100;
/// 行と行の間の待ち時間の上限（ミリ秒）。
pub const MAX_LINE_DELAY_MS: u32 = 10_000;

#[derive(Debug, Error)]
pub enum SnippetError {
    #[error("スニペットが不正です: {0}")]
    Invalid(String),
    #[error("スニペットの保存ファイルを操作できません ({context}): {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
    #[error("スニペットの保存ファイル {path} を解析できません: {source}")]
    Parse {
        path: String,
        #[source]
        source: serde_json::Error,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    /// 送る内容。1行ずつ送り、行ごとに Enter を付ける。
    pub text: String,
    /// 行と行の間の待ち時間（ミリ秒）。
    #[serde(default)]
    pub line_delay_ms: u32,
    /// 最後の行にも Enter を付けるか。オフなら入力欄に置くだけで実行しない。
    #[serde(default = "default_true")]
    pub send_enter: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug)]
pub struct SnippetStore {
    path: PathBuf,
    lock: Mutex<()>,
    counter: AtomicU64,
}

impl SnippetStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            lock: Mutex::new(()),
            counter: AtomicU64::new(0),
        }
    }

    // ロックの毒化は保護対象のデータを持たないため無視してよい。
    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 保存済みの一覧。ファイルがなければ空。壊れていればエラー。
    pub fn load(&self) -> Result<Vec<Snippet>, SnippetError> {
        let _guard = self.guard();
        match std::fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text).map_err(|source| SnippetError::Parse {
                path: self.path.display().to_string(),
                source,
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(SnippetError::Io {
                context: format!("{} の読み込み", self.path.display()),
                source: e,
            }),
        }
    }

    /// 検証して保存し、保存した内容（名前の前後の空白を除いたもの）を返す。
    pub fn save(&self, snippets: Vec<Snippet>) -> Result<Vec<Snippet>, SnippetError> {
        let snippets = validate(snippets)?;
        let text = serde_json::to_string_pretty(&snippets).map_err(|e| SnippetError::Io {
            context: "シリアライズ".into(),
            source: std::io::Error::other(e),
        })?;
        let _guard = self.guard();
        let unique = self.counter.fetch_add(1, Ordering::Relaxed);
        crate::atomic_file::write_private(&self.path, text.as_bytes(), unique).map_err(|e| {
            SnippetError::Io {
                context: format!("{} の書き込み", self.path.display()),
                source: e,
            }
        })?;
        Ok(snippets)
    }
}

fn validate(mut snippets: Vec<Snippet>) -> Result<Vec<Snippet>, SnippetError> {
    if snippets.len() > MAX_SNIPPETS {
        return Err(SnippetError::Invalid(format!(
            "スニペットは{MAX_SNIPPETS}個までです"
        )));
    }
    let mut ids = HashSet::new();
    for s in &mut snippets {
        let id = s.id.trim();
        if id.is_empty() || id.chars().count() > MAX_ID_CHARS {
            return Err(SnippetError::Invalid("IDが不正です".into()));
        }
        if !ids.insert(id.to_owned()) {
            return Err(SnippetError::Invalid(format!("IDが重複しています: {id}")));
        }
        s.id = id.to_owned();
        s.name = s.name.trim().to_owned();
        if s.name.is_empty() || s.name.chars().count() > MAX_NAME_CHARS {
            return Err(SnippetError::Invalid(format!(
                "名前は1〜{MAX_NAME_CHARS}文字で入力してください"
            )));
        }
        if s.text.is_empty() || s.text.chars().count() > MAX_TEXT_CHARS {
            return Err(SnippetError::Invalid(format!(
                "内容は1〜{MAX_TEXT_CHARS}文字で入力してください"
            )));
        }
        if s.text.contains('\0') {
            return Err(SnippetError::Invalid(
                "内容に使えない文字（NUL）が含まれています".into(),
            ));
        }
        if s.line_delay_ms > MAX_LINE_DELAY_MS {
            return Err(SnippetError::Invalid(format!(
                "行間の待ち時間は{MAX_LINE_DELAY_MS}ミリ秒以内で指定してください"
            )));
        }
    }
    Ok(snippets)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn store(name: &str) -> (SnippetStore, PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("linkterm-sn-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("sub").join("snippets.json");
        (SnippetStore::new(&path), path, dir)
    }

    fn snippet(id: &str) -> Snippet {
        Snippet {
            id: id.into(),
            name: format!("name-{id}"),
            text: "show version\nshow ip route".into(),
            line_delay_ms: 200,
            send_enter: true,
        }
    }

    #[test]
    fn missing_file_loads_an_empty_list() {
        let (s, _, dir) = store("missing");
        assert!(s.load().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn save_then_load_roundtrips_with_private_permissions() {
        let (s, path, dir) = store("roundtrip");
        let list = vec![snippet("a"), snippet("b")];
        assert_eq!(s.save(list.clone()).unwrap(), list);
        assert_eq!(SnippetStore::new(&path).load().unwrap(), list);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn names_are_trimmed() {
        let (s, _, dir) = store("trim");
        let mut sn = snippet("a");
        sn.name = "  ping  ".into();
        assert_eq!(s.save(vec![sn]).unwrap()[0].name, "ping");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_optional_fields_use_defaults() {
        let sn: Snippet = serde_json::from_str(r#"{"id":"a","name":"n","text":"ls"}"#).unwrap();
        assert_eq!(sn.line_delay_ms, 0);
        assert!(sn.send_enter);
    }

    #[test]
    fn invalid_snippets_are_rejected_and_nothing_is_written() {
        let (s, path, dir) = store("invalid");
        let mut cases: Vec<Vec<Snippet>> = Vec::new();
        let mut c = snippet("a");
        c.name = "   ".into();
        cases.push(vec![c]);
        let mut c = snippet("a");
        c.name = "あ".repeat(MAX_NAME_CHARS + 1);
        cases.push(vec![c]);
        let mut c = snippet("a");
        c.text = String::new();
        cases.push(vec![c]);
        let mut c = snippet("a");
        c.text = "x".repeat(MAX_TEXT_CHARS + 1);
        cases.push(vec![c]);
        let mut c = snippet("a");
        c.text = "a\0b".into();
        cases.push(vec![c]);
        let mut c = snippet("a");
        c.line_delay_ms = MAX_LINE_DELAY_MS + 1;
        cases.push(vec![c]);
        let mut c = snippet("a");
        c.id = " ".into();
        cases.push(vec![c]);
        cases.push(vec![snippet("a"), snippet("a")]);
        cases.push(
            (0..=MAX_SNIPPETS)
                .map(|i| snippet(&i.to_string()))
                .collect(),
        );
        for case in cases {
            assert!(matches!(s.save(case), Err(SnippetError::Invalid(_))));
        }
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_file_is_an_error_not_silently_reset() {
        let (s, path, dir) = store("corrupt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{not json").unwrap();
        assert!(matches!(s.load(), Err(SnippetError::Parse { .. })));
        let _ = std::fs::remove_dir_all(dir);
    }
}

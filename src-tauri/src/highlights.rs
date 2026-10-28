//! キーワードのハイライト規則の保存。
//!
//! 規則（見つけたい文字列・色・通知するか）をアプリのデータフォルダへ JSON で保存する。
//! 正規表現の評価は画面側（JavaScript）で行うため、ここでは長さと色などの形だけを検証する。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const MAX_RULES: usize = 50;
pub const MAX_PATTERN_CHARS: usize = 200;
pub const MAX_ID_CHARS: usize = 100;
/// 使える色（タブの色と同じ）。
pub const COLORS: &[&str] = &[
    "red", "orange", "yellow", "green", "blue", "purple", "pink", "gray",
];

#[derive(Debug, Error)]
pub enum HighlightError {
    #[error("ハイライト規則が不正です: {0}")]
    Invalid(String),
    #[error("ハイライト規則の保存ファイルを操作できません ({context}): {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
    #[error("ハイライト規則の保存ファイル {path} を解析できません: {source}")]
    Parse {
        path: String,
        #[source]
        source: serde_json::Error,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HighlightRule {
    pub id: String,
    /// 見つけたい文字列（`regex` が真なら正規表現）。
    pub pattern: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    pub color: String,
    /// 見つかったとき、通知する。
    #[serde(default)]
    pub notify: bool,
}

#[derive(Debug)]
pub struct HighlightStore {
    path: PathBuf,
    lock: Mutex<()>,
    counter: AtomicU64,
}

impl HighlightStore {
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

    /// 保存済みの規則。ファイルがなければ空。壊れていればエラー。
    pub fn load(&self) -> Result<Vec<HighlightRule>, HighlightError> {
        let _guard = self.guard();
        match std::fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text).map_err(|source| HighlightError::Parse {
                path: self.path.display().to_string(),
                source,
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(HighlightError::Io {
                context: format!("{} の読み込み", self.path.display()),
                source: e,
            }),
        }
    }

    /// 検証して保存し、保存した内容を返す。
    pub fn save(&self, rules: Vec<HighlightRule>) -> Result<Vec<HighlightRule>, HighlightError> {
        let rules = validate(rules)?;
        let text = serde_json::to_string_pretty(&rules).map_err(|e| HighlightError::Io {
            context: "シリアライズ".into(),
            source: std::io::Error::other(e),
        })?;
        let _guard = self.guard();
        let unique = self.counter.fetch_add(1, Ordering::Relaxed);
        crate::atomic_file::write_private(&self.path, text.as_bytes(), unique).map_err(|e| {
            HighlightError::Io {
                context: format!("{} の書き込み", self.path.display()),
                source: e,
            }
        })?;
        Ok(rules)
    }
}

fn validate(mut rules: Vec<HighlightRule>) -> Result<Vec<HighlightRule>, HighlightError> {
    if rules.len() > MAX_RULES {
        return Err(HighlightError::Invalid(format!(
            "規則は{MAX_RULES}個までです"
        )));
    }
    let mut ids = HashSet::new();
    for r in &mut rules {
        let id = r.id.trim();
        if id.is_empty() || id.chars().count() > MAX_ID_CHARS {
            return Err(HighlightError::Invalid("IDが不正です".into()));
        }
        if !ids.insert(id.to_owned()) {
            return Err(HighlightError::Invalid(format!("IDが重複しています: {id}")));
        }
        r.id = id.to_owned();
        if r.pattern.is_empty() || r.pattern.chars().count() > MAX_PATTERN_CHARS {
            return Err(HighlightError::Invalid(format!(
                "文字列は1〜{MAX_PATTERN_CHARS}文字で入力してください"
            )));
        }
        if r.pattern
            .chars()
            .any(|c| c == '\0' || c == '\n' || c == '\r')
        {
            return Err(HighlightError::Invalid(
                "文字列に改行や NUL は使えません".into(),
            ));
        }
        if !COLORS.contains(&r.color.as_str()) {
            return Err(HighlightError::Invalid(format!(
                "未対応の色です: {}",
                r.color
            )));
        }
    }
    Ok(rules)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn store(name: &str) -> (HighlightStore, PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("linkterm-hl-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("sub").join("highlights.json");
        (HighlightStore::new(&path), path, dir)
    }

    fn rule(id: &str) -> HighlightRule {
        HighlightRule {
            id: id.into(),
            pattern: "ERROR".into(),
            regex: false,
            case_sensitive: true,
            color: "red".into(),
            notify: true,
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
        let list = vec![rule("a"), rule("b")];
        assert_eq!(s.save(list.clone()).unwrap(), list);
        assert_eq!(HighlightStore::new(&path).load().unwrap(), list);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_optional_fields_use_defaults() {
        let r: HighlightRule =
            serde_json::from_str(r#"{"id":"a","pattern":"x","color":"blue"}"#).unwrap();
        assert!(!r.regex && !r.case_sensitive && !r.notify);
    }

    #[test]
    fn invalid_rules_are_rejected_and_nothing_is_written() {
        let (s, path, dir) = store("invalid");
        let mut cases: Vec<Vec<HighlightRule>> = Vec::new();
        for pattern in [
            String::new(),
            "x".repeat(MAX_PATTERN_CHARS + 1),
            "a\nb".into(),
            "a\0b".into(),
        ] {
            let mut r = rule("a");
            r.pattern = pattern;
            cases.push(vec![r]);
        }
        let mut r = rule("a");
        r.color = "magenta".into();
        cases.push(vec![r]);
        let mut r = rule("a");
        r.id = " ".into();
        cases.push(vec![r]);
        cases.push(vec![rule("a"), rule("a")]);
        cases.push((0..=MAX_RULES).map(|i| rule(&i.to_string())).collect());
        for case in cases {
            assert!(matches!(s.save(case), Err(HighlightError::Invalid(_))));
        }
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_file_is_an_error_not_silently_reset() {
        let (s, path, dir) = store("corrupt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{not json").unwrap();
        assert!(matches!(s.load(), Err(HighlightError::Parse { .. })));
        let _ = std::fs::remove_dir_all(dir);
    }
}

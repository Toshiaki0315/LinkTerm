//! ショートカットキーの割り当て（初期値から変えたものだけ）の保存。
//!
//! どの操作に何のキーを割り当てられるか・競合しないかは画面側で検証する。
//! ここでは、保存する値の形（長さ・文字・件数・重複）だけを確かめる。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const MAX_BINDINGS: usize = 50;
pub const MAX_ID_CHARS: usize = 40;
pub const MAX_BINDING_CHARS: usize = 40;

#[derive(Debug, Error)]
pub enum KeybindingError {
    #[error("ショートカットが不正です: {0}")]
    Invalid(String),
    #[error("ショートカットの保存ファイルを操作できません ({context}): {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
    #[error("ショートカットの保存ファイル {path} を解析できません: {source}")]
    Parse {
        path: String,
        #[source]
        source: serde_json::Error,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyBinding {
    /// 操作の ID（例: `split-right`）。
    pub id: String,
    /// キーの組み合わせ（例: `Cmd+Shift+P`）。
    pub binding: String,
}

#[derive(Debug)]
pub struct KeybindingStore {
    path: PathBuf,
    lock: Mutex<()>,
    counter: AtomicU64,
}

impl KeybindingStore {
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

    /// 保存済みの割り当て。ファイルがなければ空。壊れていればエラー。
    pub fn load(&self) -> Result<Vec<KeyBinding>, KeybindingError> {
        let _guard = self.guard();
        match std::fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text).map_err(|source| KeybindingError::Parse {
                path: self.path.display().to_string(),
                source,
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(KeybindingError::Io {
                context: format!("{} の読み込み", self.path.display()),
                source: e,
            }),
        }
    }

    /// 検証して保存し、保存した内容を返す。
    pub fn save(&self, bindings: Vec<KeyBinding>) -> Result<Vec<KeyBinding>, KeybindingError> {
        validate(&bindings)?;
        let text = serde_json::to_string_pretty(&bindings).map_err(|e| KeybindingError::Io {
            context: "シリアライズ".into(),
            source: std::io::Error::other(e),
        })?;
        let _guard = self.guard();
        let unique = self.counter.fetch_add(1, Ordering::Relaxed);
        crate::atomic_file::write_private(&self.path, text.as_bytes(), unique).map_err(|e| {
            KeybindingError::Io {
                context: format!("{} の書き込み", self.path.display()),
                source: e,
            }
        })?;
        Ok(bindings)
    }
}

fn validate(bindings: &[KeyBinding]) -> Result<(), KeybindingError> {
    if bindings.len() > MAX_BINDINGS {
        return Err(KeybindingError::Invalid(format!(
            "割り当ては{MAX_BINDINGS}個までです"
        )));
    }
    let mut ids = HashSet::new();
    let mut keys = HashSet::new();
    for b in bindings {
        let id_ok = !b.id.is_empty()
            && b.id.chars().count() <= MAX_ID_CHARS
            && b.id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !id_ok {
            return Err(KeybindingError::Invalid(format!("IDが不正です: {}", b.id)));
        }
        if !ids.insert(b.id.as_str()) {
            return Err(KeybindingError::Invalid(format!(
                "IDが重複しています: {}",
                b.id
            )));
        }
        let binding_ok = !b.binding.is_empty()
            && b.binding.chars().count() <= MAX_BINDING_CHARS
            && !b.binding.chars().any(char::is_control)
            && b.binding.starts_with("Cmd+")
            && !b.binding.ends_with("++");
        if !binding_ok {
            return Err(KeybindingError::Invalid(format!(
                "キーの組み合わせが不正です: {}（⌘を含めてください）",
                b.binding
            )));
        }
        if !keys.insert(b.binding.as_str()) {
            return Err(KeybindingError::Invalid(format!(
                "同じキーが複数の操作に割り当てられています: {}",
                b.binding
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn store(name: &str) -> (KeybindingStore, PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("linkterm-kb-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("sub").join("keybindings.json");
        (KeybindingStore::new(&path), path, dir)
    }

    fn kb(id: &str, binding: &str) -> KeyBinding {
        KeyBinding {
            id: id.into(),
            binding: binding.into(),
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
        let list = vec![kb("split-right", "Cmd+Shift+D"), kb("palette", "Cmd+K")];
        assert_eq!(s.save(list.clone()).unwrap(), list);
        assert_eq!(KeybindingStore::new(&path).load().unwrap(), list);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn saving_an_empty_list_resets_everything() {
        let (s, _, dir) = store("reset");
        s.save(vec![kb("palette", "Cmd+K")]).unwrap();
        s.save(vec![]).unwrap();
        assert!(s.load().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn invalid_bindings_are_rejected_and_nothing_is_written() {
        let (s, path, dir) = store("invalid");
        let mut cases: Vec<Vec<KeyBinding>> = vec![
            vec![kb("", "Cmd+K")],
            vec![kb("Bad_Id", "Cmd+K")],
            vec![kb(&"a".repeat(MAX_ID_CHARS + 1), "Cmd+K")],
            vec![kb("a", "")],
            vec![kb("a", "K")],
            vec![kb("a", "Ctrl+K")],
            vec![kb("a", "Cmd+\n")],
            vec![kb("a", &format!("Cmd+{}", "x".repeat(MAX_BINDING_CHARS)))],
            vec![kb("a", "Cmd++")],
            vec![kb("a", "Cmd+K"), kb("a", "Cmd+L")],
            vec![kb("a", "Cmd+K"), kb("b", "Cmd+K")],
        ];
        cases.push(
            (0..=MAX_BINDINGS)
                .map(|i| kb(&format!("id-{i}"), &format!("Cmd+F{i}")))
                .collect(),
        );
        for case in cases {
            assert!(
                matches!(s.save(case.clone()), Err(KeybindingError::Invalid(_))),
                "{case:?}"
            );
        }
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_file_is_an_error_not_silently_reset() {
        let (s, path, dir) = store("corrupt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{not json").unwrap();
        assert!(matches!(s.load(), Err(KeybindingError::Parse { .. })));
        let _ = std::fs::remove_dir_all(dir);
    }
}

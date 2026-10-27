//! 終了時のタブ構成（接続先のみ）の保存。次回の起動時に復元するために使う。
//!
//! 保存するのは接続先の設定とタブ名だけで、パスワード・パスフレーズは決して保存しない。

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const MAX_TABS: usize = 100;
pub const MAX_TITLE_CHARS: usize = 60;

#[derive(Debug, Error)]
pub enum SessionStateError {
    #[error("タブ構成が不正です: {0}")]
    Invalid(String),
    #[error("タブ構成の保存ファイルを操作できません ({context}): {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
    #[error("タブ構成の保存ファイル {path} を解析できません: {source}")]
    Parse {
        path: String,
        #[source]
        source: serde_json::Error,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedTab {
    pub title: String,
    /// 接続フォームの値（パスワード類は含まれない）。
    pub values: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionState {
    pub tabs: Vec<SavedTab>,
    /// アクティブだったタブの位置。
    pub active: Option<usize>,
}

#[derive(Debug)]
pub struct SessionStateStore {
    path: PathBuf,
    lock: Mutex<()>,
    counter: AtomicU64,
}

impl SessionStateStore {
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

    /// 保存済みのタブ構成。ファイルがなければ空。壊れていればエラー。
    pub fn load(&self) -> Result<SessionState, SessionStateError> {
        let _guard = self.guard();
        match std::fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text).map_err(|source| SessionStateError::Parse {
                path: self.path.display().to_string(),
                source,
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SessionState::default()),
            Err(e) => Err(SessionStateError::Io {
                context: format!("{} の読み込み", self.path.display()),
                source: e,
            }),
        }
    }

    /// 検証して保存し、保存した（秘密情報を除いた）内容を返す。
    pub fn save(&self, state: SessionState) -> Result<SessionState, SessionStateError> {
        let state = sanitize(state)?;
        let text = serde_json::to_string_pretty(&state).map_err(|e| SessionStateError::Io {
            context: "シリアライズ".into(),
            source: std::io::Error::other(e),
        })?;
        let _guard = self.guard();
        let unique = self.counter.fetch_add(1, Ordering::Relaxed);
        crate::atomic_file::write_private(&self.path, text.as_bytes(), unique).map_err(|e| {
            SessionStateError::Io {
                context: format!("{} の書き込み", self.path.display()),
                source: e,
            }
        })?;
        Ok(state)
    }
}

/// 検証し、秘密情報を除き、タブ名を整える。
fn sanitize(mut state: SessionState) -> Result<SessionState, SessionStateError> {
    if state.tabs.len() > MAX_TABS {
        return Err(SessionStateError::Invalid(format!(
            "タブは{MAX_TABS}個までです"
        )));
    }
    for tab in &mut state.tabs {
        let title: String = tab.title.trim().chars().take(MAX_TITLE_CHARS).collect();
        let title = title.trim().to_owned();
        if title.is_empty() {
            return Err(SessionStateError::Invalid("タブ名が空です".into()));
        }
        if !tab.values.is_object() {
            return Err(SessionStateError::Invalid(
                "接続設定はオブジェクトで指定してください".into(),
            ));
        }
        tab.title = title;
        crate::profiles::strip_secrets(&mut tab.values);
    }
    // 範囲外の位置は捨てる（復元時にどのタブもアクティブにしない）。
    state.active = state.active.filter(|&i| i < state.tabs.len());
    Ok(state)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use serde_json::json;

    use super::*;

    fn store(name: &str) -> (SessionStateStore, PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("linkterm-ss-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("sub").join("session_state.json");
        (SessionStateStore::new(&path), path, dir)
    }

    fn tab(title: &str, host: &str) -> SavedTab {
        SavedTab {
            title: title.into(),
            values: json!({"type": "ssh", "host": host, "port": 22, "username": "alice", "authKind": "agent"}),
        }
    }

    #[test]
    fn missing_file_loads_an_empty_state() {
        let (s, _, dir) = store("missing");
        assert_eq!(s.load().unwrap(), SessionState::default());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn save_then_load_roundtrips_with_private_permissions() {
        let (s, path, dir) = store("roundtrip");
        let state = SessionState {
            tabs: vec![tab("本番", "a"), tab("検証", "b")],
            active: Some(1),
        };
        assert_eq!(s.save(state.clone()).unwrap(), state);
        assert_eq!(SessionStateStore::new(&path).load().unwrap(), state);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn secrets_are_never_stored() {
        let (s, path, dir) = store("secrets");
        let mut t = tab("x", "h");
        t.values["password"] = json!("hunter2");
        t.values["passphrase"] = json!("pp");
        t.values["Password"] = json!("case-variant");
        let saved = s
            .save(SessionState {
                tabs: vec![t],
                active: Some(0),
            })
            .unwrap();
        for key in ["password", "passphrase", "Password"] {
            assert!(saved.tabs[0].values.get(key).is_none(), "{key}");
        }
        let raw = std::fs::read_to_string(path).unwrap();
        assert!(
            !raw.contains("hunter2") && !raw.contains("case-variant") && !raw.contains("\"pp\"")
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn saving_an_empty_layout_clears_the_previous_one() {
        let (s, _, dir) = store("clear");
        s.save(SessionState {
            tabs: vec![tab("a", "h")],
            active: Some(0),
        })
        .unwrap();
        s.save(SessionState::default()).unwrap();
        assert_eq!(s.load().unwrap(), SessionState::default());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn invalid_states_are_rejected() {
        let (s, _, dir) = store("invalid");
        // 値がオブジェクトでない
        let bad_values = SessionState {
            tabs: vec![SavedTab {
                title: "x".into(),
                values: json!("str"),
            }],
            active: None,
        };
        assert!(matches!(
            s.save(bad_values),
            Err(SessionStateError::Invalid(_))
        ));
        // 空のタブ名
        assert!(matches!(
            s.save(SessionState {
                tabs: vec![tab("  ", "h")],
                active: None
            }),
            Err(SessionStateError::Invalid(_))
        ));
        // タブ数が多すぎる
        let many = SessionState {
            tabs: (0..=MAX_TABS).map(|i| tab("t", &format!("h{i}"))).collect(),
            active: None,
        };
        assert!(matches!(s.save(many), Err(SessionStateError::Invalid(_))));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn long_titles_are_truncated_and_titles_trimmed() {
        let (s, _, dir) = store("title");
        let saved = s
            .save(SessionState {
                tabs: vec![tab(&format!("  {}  ", "あ".repeat(100)), "h")],
                active: None,
            })
            .unwrap();
        assert_eq!(saved.tabs[0].title.chars().count(), MAX_TITLE_CHARS);
        assert!(!saved.tabs[0].title.starts_with(' '));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn out_of_range_active_index_is_dropped() {
        let (s, _, dir) = store("active");
        let saved = s
            .save(SessionState {
                tabs: vec![tab("a", "h")],
                active: Some(5),
            })
            .unwrap();
        assert_eq!(saved.active, None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_file_is_an_error_and_is_not_overwritten_by_load() {
        let (s, path, dir) = store("corrupt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ nope").unwrap();
        assert!(matches!(s.load(), Err(SessionStateError::Parse { .. })));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ nope");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn json_shape_matches_the_frontend_contract() {
        let v = serde_json::to_value(SessionState {
            tabs: vec![tab("a", "h")],
            active: Some(0),
        })
        .unwrap();
        assert_eq!(v["active"], 0);
        assert_eq!(v["tabs"][0]["title"], "a");
        assert_eq!(v["tabs"][0]["values"]["host"], "h");
    }

    #[test]
    fn concurrent_saves_leave_a_valid_file_and_no_temp_files() {
        let (s, path, dir) = store("concurrent");
        let s = std::sync::Arc::new(s);
        let handles: Vec<_> = (0..16)
            .map(|i| {
                let s = s.clone();
                std::thread::spawn(move || {
                    s.save(SessionState {
                        tabs: vec![tab("t", &format!("h{i}"))],
                        active: Some(0),
                    })
                    .unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(s.load().unwrap().tabs.len(), 1);
        let names: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["session_state.json".to_string()]);
        let _ = std::fs::remove_dir_all(dir);
    }
}

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
/// 1つのタブに保存するペイン数の上限。
pub const MAX_PANES: usize = 16;
pub const MAX_PANE_ID_CHARS: usize = 20;
/// 配置（分割の木）を JSON にしたときの大きさの上限。
pub const MAX_LAYOUT_BYTES: usize = 20_000;

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
#[serde(rename_all = "camelCase")]
pub struct SavedTab {
    pub title: String,
    /// 接続フォームの値（パスワード類は含まれない）。分割しているときは、先頭のペインの値。
    pub values: serde_json::Value,
    /// 分割しているときの、すべてのペイン（先頭を含む）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub panes: Vec<SavedPane>,
    /// 分割の配置（木）。形の検証は画面側が行う。`panes` があるときだけ持つ。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<serde_json::Value>,
    /// 操作中だったペインの ID。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_pane: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedPane {
    /// 配置から参照する ID（保存のたびに付け直すもの）。
    pub id: String,
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

/// 分割の情報を検証し、ペインの値からも秘密情報を除く。
fn sanitize_panes(tab: &mut SavedTab) -> Result<(), SessionStateError> {
    if tab.panes.is_empty() {
        // 分割していなければ、配置と操作中のペインは意味がない。
        tab.layout = None;
        tab.active_pane = None;
        return Ok(());
    }
    if tab.panes.len() > MAX_PANES {
        return Err(SessionStateError::Invalid(format!(
            "1つのタブのペインは{MAX_PANES}個までです"
        )));
    }
    let mut ids = std::collections::HashSet::new();
    for pane in &mut tab.panes {
        if pane.id.is_empty() || pane.id.chars().count() > MAX_PANE_ID_CHARS {
            return Err(SessionStateError::Invalid("ペインのIDが不正です".into()));
        }
        if !ids.insert(pane.id.clone()) {
            return Err(SessionStateError::Invalid(format!(
                "ペインのIDが重複しています: {}",
                pane.id
            )));
        }
        if !pane.values.is_object() {
            return Err(SessionStateError::Invalid(
                "接続設定はオブジェクトで指定してください".into(),
            ));
        }
        crate::profiles::strip_secrets(&mut pane.values);
    }
    match &tab.layout {
        Some(layout) if layout.is_object() => {
            let size = serde_json::to_string(layout)
                .map(|s| s.len())
                .unwrap_or(usize::MAX);
            if size > MAX_LAYOUT_BYTES {
                return Err(SessionStateError::Invalid(
                    "分割の配置が大きすぎます".into(),
                ));
            }
        }
        _ => {
            return Err(SessionStateError::Invalid("分割の配置が必要です".into()));
        }
    }
    // 存在しないペインを指していたら、操作中のペインは捨てる。
    tab.active_pane = tab.active_pane.take().filter(|id| ids.contains(id));
    Ok(())
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
        sanitize_panes(tab)?;
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
            panes: vec![],
            layout: None,
            active_pane: None,
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
                panes: vec![],
                layout: None,
                active_pane: None,
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

    fn split_tab() -> SavedTab {
        let mut t = tab("分割", "a");
        t.panes = vec![
            SavedPane {
                id: "p0".into(),
                values: json!({"type": "local", "encoding": "UTF-8"}),
            },
            SavedPane {
                id: "p1".into(),
                values: json!({"type": "telnet", "host": "r", "port": 23}),
            },
        ];
        t.layout = Some(json!({
            "kind": "split", "id": "s", "dir": "row", "ratio": 0.5,
            "a": {"kind": "pane", "id": "p0"}, "b": {"kind": "pane", "id": "p1"}
        }));
        t.active_pane = Some("p1".into());
        t
    }

    #[test]
    fn split_tabs_roundtrip_and_omit_empty_fields_for_plain_tabs() {
        let (s, path, dir) = store("split");
        let state = SessionState {
            tabs: vec![split_tab(), tab("通常", "b")],
            active: Some(0),
        };
        assert_eq!(s.save(state.clone()).unwrap(), state);
        assert_eq!(SessionStateStore::new(&path).load().unwrap(), state);
        let v = serde_json::to_value(&state).unwrap();
        assert_eq!(v["tabs"][0]["panes"][1]["id"], "p1");
        assert_eq!(v["tabs"][0]["activePane"], "p1");
        assert!(v["tabs"][1].get("panes").is_none());
        assert!(v["tabs"][1].get("layout").is_none());
        // 古い形式（分割の項目がない）も読める。
        let old: SessionState = serde_json::from_str(
            r#"{"tabs":[{"title":"a","values":{"type":"local"}}],"active":0}"#,
        )
        .unwrap();
        assert!(old.tabs[0].panes.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn secrets_in_split_panes_are_never_stored() {
        let (s, path, dir) = store("split-secrets");
        let mut t = split_tab();
        t.panes[1].values["password"] = json!("hunter2");
        t.panes[1].values["loginPassword"] = json!("tn-secret");
        let saved = s
            .save(SessionState {
                tabs: vec![t],
                active: Some(0),
            })
            .unwrap();
        assert!(saved.tabs[0].panes[1].values.get("password").is_none());
        assert!(saved.tabs[0].panes[1].values.get("loginPassword").is_none());
        let raw = std::fs::read_to_string(path).unwrap();
        assert!(!raw.contains("hunter2") && !raw.contains("tn-secret"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn invalid_split_info_is_rejected() {
        let (s, _, dir) = store("split-invalid");
        let state = |t: SavedTab| SessionState {
            tabs: vec![t],
            active: None,
        };
        let mut dup = split_tab();
        dup.panes[1].id = "p0".into();
        let mut empty_id = split_tab();
        empty_id.panes[0].id = String::new();
        let mut long_id = split_tab();
        long_id.panes[0].id = "x".repeat(MAX_PANE_ID_CHARS + 1);
        let mut no_layout = split_tab();
        no_layout.layout = None;
        let mut bad_values = split_tab();
        bad_values.panes[0].values = json!("str");
        let mut many = split_tab();
        many.panes = (0..=MAX_PANES)
            .map(|i| SavedPane {
                id: format!("p{i}"),
                values: json!({"type": "local"}),
            })
            .collect();
        let mut huge = split_tab();
        huge.layout = Some(json!({"pad": "x".repeat(MAX_LAYOUT_BYTES)}));
        for bad in [dup, empty_id, long_id, no_layout, bad_values, many, huge] {
            assert!(matches!(
                s.save(state(bad)),
                Err(SessionStateError::Invalid(_))
            ));
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unknown_active_pane_is_dropped_and_plain_tabs_lose_stray_split_fields() {
        let (s, _, dir) = store("split-active");
        let mut t = split_tab();
        t.active_pane = Some("zzz".into());
        let saved = s
            .save(SessionState {
                tabs: vec![t],
                active: None,
            })
            .unwrap();
        assert_eq!(saved.tabs[0].active_pane, None);
        let mut plain = tab("通常", "h");
        plain.layout = Some(json!({"kind": "pane", "id": "x"}));
        plain.active_pane = Some("x".into());
        let saved = s
            .save(SessionState {
                tabs: vec![plain],
                active: None,
            })
            .unwrap();
        assert_eq!(saved.tabs[0].layout, None);
        assert_eq!(saved.tabs[0].active_pane, None);
        let _ = std::fs::remove_dir_all(dir);
    }
}

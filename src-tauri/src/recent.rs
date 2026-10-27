//! 最近使った接続先の保存。新しい順に並べた一覧を、アプリのデータフォルダへ保存する。
//!
//! 保存するのは接続先の設定だけで、パスワード・パスフレーズは決して保存しない。
//! 同じ接続先をまとめる（重複を除く）処理は、接続先の同一性を知っているフロントエンドが行う。

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 保存する件数の上限。
pub const MAX_RECENT: usize = 20;

#[derive(Debug, Error)]
pub enum RecentError {
    #[error("最近使った接続が不正です: {0}")]
    Invalid(String),
    #[error("最近使った接続の保存ファイルを操作できません ({context}): {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
    #[error("最近使った接続の保存ファイル {path} を解析できません: {source}")]
    Parse {
        path: String,
        #[source]
        source: serde_json::Error,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentConnection {
    /// 接続フォームの値（パスワード類は含まれない）。
    pub values: serde_json::Value,
    /// 最後に使った時刻（UNIX時間のミリ秒）。
    pub used_at: u64,
}

#[derive(Debug)]
pub struct RecentStore {
    path: PathBuf,
    lock: Mutex<()>,
    counter: AtomicU64,
}

impl RecentStore {
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

    /// 保存済みの一覧（新しい順）。ファイルがなければ空。壊れていればエラー。
    pub fn load(&self) -> Result<Vec<RecentConnection>, RecentError> {
        let _guard = self.guard();
        match std::fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text).map_err(|source| RecentError::Parse {
                path: self.path.display().to_string(),
                source,
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(RecentError::Io {
                context: format!("{} の読み込み", self.path.display()),
                source: e,
            }),
        }
    }

    /// 検証して保存し、保存した（秘密情報を除いた）内容を返す。
    pub fn save(
        &self,
        entries: Vec<RecentConnection>,
    ) -> Result<Vec<RecentConnection>, RecentError> {
        let entries = sanitize(entries)?;
        let text = serde_json::to_string_pretty(&entries).map_err(|e| RecentError::Io {
            context: "シリアライズ".into(),
            source: std::io::Error::other(e),
        })?;
        let _guard = self.guard();
        let unique = self.counter.fetch_add(1, Ordering::Relaxed);
        crate::atomic_file::write_private(&self.path, text.as_bytes(), unique).map_err(|e| {
            RecentError::Io {
                context: format!("{} の書き込み", self.path.display()),
                source: e,
            }
        })?;
        Ok(entries)
    }
}

/// 検証し、秘密情報を除き、件数を上限に収める（先頭＝新しいものを残す）。
fn sanitize(mut entries: Vec<RecentConnection>) -> Result<Vec<RecentConnection>, RecentError> {
    entries.truncate(MAX_RECENT);
    for entry in &mut entries {
        if !entry.values.is_object() {
            return Err(RecentError::Invalid(
                "接続設定はオブジェクトで指定してください".into(),
            ));
        }
        crate::profiles::strip_secrets(&mut entry.values);
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use serde_json::json;

    use super::*;

    fn store(name: &str) -> (RecentStore, PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("linkterm-rc-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("sub").join("recent.json");
        (RecentStore::new(&path), path, dir)
    }

    fn entry(host: &str, used_at: u64) -> RecentConnection {
        RecentConnection {
            values: json!({"type": "ssh", "host": host, "port": 22, "username": "alice", "authKind": "agent"}),
            used_at,
        }
    }

    #[test]
    fn missing_file_loads_an_empty_list() {
        let (s, _, dir) = store("missing");
        assert!(s.load().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn save_then_load_roundtrips_in_order_with_private_permissions() {
        let (s, path, dir) = store("roundtrip");
        let list = vec![entry("b", 20), entry("a", 10)];
        assert_eq!(s.save(list.clone()).unwrap(), list);
        assert_eq!(RecentStore::new(&path).load().unwrap(), list);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn secrets_are_never_stored() {
        let (s, path, dir) = store("secrets");
        let mut e = entry("h", 1);
        e.values["password"] = json!("hunter2");
        e.values["passphrase"] = json!("pp");
        let saved = s.save(vec![e]).unwrap();
        assert!(saved[0].values.get("password").is_none());
        assert!(saved[0].values.get("passphrase").is_none());
        let raw = std::fs::read_to_string(path).unwrap();
        assert!(!raw.contains("hunter2") && !raw.contains("\"pp\""));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn list_is_capped_keeping_the_newest_first_entries() {
        let (s, _, dir) = store("cap");
        let list: Vec<_> = (0..(MAX_RECENT as u64 + 5))
            .map(|i| entry(&format!("h{i}"), 1000 - i))
            .collect();
        let saved = s.save(list).unwrap();
        assert_eq!(saved.len(), MAX_RECENT);
        assert_eq!(saved[0].values["host"], "h0");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn non_object_values_are_rejected_and_nothing_is_written() {
        let (s, path, dir) = store("invalid");
        let bad = RecentConnection {
            values: json!("oops"),
            used_at: 1,
        };
        assert!(matches!(s.save(vec![bad]), Err(RecentError::Invalid(_))));
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_file_is_an_error_not_silently_reset() {
        let (s, path, dir) = store("corrupt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{not json").unwrap();
        assert!(matches!(s.load(), Err(RecentError::Parse { .. })));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn saving_an_empty_list_clears_the_history() {
        let (s, _, dir) = store("clear");
        s.save(vec![entry("a", 1)]).unwrap();
        s.save(vec![]).unwrap();
        assert!(s.load().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}

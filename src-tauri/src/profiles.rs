//! 接続プロファイル（保存済みの接続先）。
//!
//! 保存するのはホスト名やポートなどの設定だけで、パスワード・パスフレーズは決して保存しない
//! （パスワードは Keychain 連携で別管理）。値の形はフロントエンドの接続フォームと同じ JSON で、
//! ここでは中身を解釈せずに秘密情報のキーだけを取り除く。

use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const MAX_NAME_CHARS: usize = 100;
/// 保存してはならないキー。
pub const SECRET_KEYS: &[&str] = &["password", "passphrase"];

#[derive(Debug, Error)]
pub enum ProfileError {
    #[error("プロファイルが不正です: {0}")]
    Invalid(String),
    #[error("プロファイルの保存ファイルを操作できません ({context}): {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
    #[error("プロファイルの保存ファイル {path} を解析できません: {source}")]
    Parse {
        path: String,
        #[source]
        source: serde_json::Error,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub values: serde_json::Value,
}

#[derive(Debug)]
pub struct ProfileStore {
    path: PathBuf,
    /// 読み込み→更新→書き込みを直列化する（同一プロセス内）。
    lock: Mutex<()>,
    counter: AtomicU64,
}

fn io_error(context: impl Into<String>, source: std::io::Error) -> ProfileError {
    ProfileError::Io {
        context: context.into(),
        source,
    }
}

/// 秘密情報のキーを取り除く（キー名の大文字小文字は区別しない）。
fn strip_secrets(values: &mut serde_json::Value) {
    if let Some(map) = values.as_object_mut() {
        map.retain(|key, _| !SECRET_KEYS.iter().any(|s| key.eq_ignore_ascii_case(s)));
    }
}

fn validate(name: &str, values: &serde_json::Value) -> Result<String, ProfileError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ProfileError::Invalid("名前を入力してください".into()));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(ProfileError::Invalid(format!(
            "名前は{MAX_NAME_CHARS}文字以内にしてください"
        )));
    }
    if !values.is_object() {
        return Err(ProfileError::Invalid(
            "接続設定はオブジェクトで指定してください".into(),
        ));
    }
    Ok(name.to_owned())
}

impl ProfileStore {
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

    fn read(&self) -> Result<Vec<Profile>, ProfileError> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text).map_err(|source| ProfileError::Parse {
                path: self.path.display().to_string(),
                source,
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(io_error(format!("{} の読み込み", self.path.display()), e)),
        }
    }

    /// 一時ファイル（0600）へ書いてから置き換える。途中で失敗しても元のファイルは壊れない。
    fn write(&self, profiles: &[Profile]) -> Result<(), ProfileError> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| io_error(format!("{} の作成", dir.display()), e))?;
        }
        let text = serde_json::to_string_pretty(profiles)
            .map_err(|e| io_error("シリアライズ", std::io::Error::other(e)))?;
        let tmp = self.path.with_extension(format!(
            "tmp-{}-{}",
            std::process::id(),
            self.counter.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| -> std::io::Result<()> {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&tmp)?;
            file.write_all(text.as_bytes())?;
            file.sync_all()?;
            std::fs::rename(&tmp, &self.path)
        })()
        .map_err(|e| io_error(format!("{} の書き込み", self.path.display()), e));
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        result
    }

    fn new_id(&self) -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!(
            "profile-{nanos:x}-{}",
            self.counter.fetch_add(1, Ordering::Relaxed)
        )
    }

    pub fn list(&self) -> Result<Vec<Profile>, ProfileError> {
        let _guard = self.guard();
        self.read()
    }

    /// `id` があれば更新（なければ新規）、`None` なら新規作成する。保存した内容を返す。
    pub fn save(
        &self,
        id: Option<&str>,
        name: &str,
        mut values: serde_json::Value,
    ) -> Result<Profile, ProfileError> {
        let name = validate(name, &values)?;
        strip_secrets(&mut values);
        let _guard = self.guard();
        let mut all = self.read()?;
        let existing = id.and_then(|id| all.iter().position(|p| p.id == id));
        let profile = match existing {
            Some(index) => {
                all[index].name = name;
                all[index].values = values;
                all[index].clone()
            }
            None => {
                let profile = Profile {
                    id: self.new_id(),
                    name,
                    values,
                };
                all.push(profile.clone());
                profile
            }
        };
        self.write(&all)?;
        Ok(profile)
    }

    /// 削除する。存在しなければ `false`。
    pub fn delete(&self, id: &str) -> Result<bool, ProfileError> {
        let _guard = self.guard();
        let mut all = self.read()?;
        let before = all.len();
        all.retain(|p| p.id != id);
        if all.len() == before {
            return Ok(false);
        }
        self.write(&all)?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;

    use serde_json::json;

    use super::*;

    fn store(name: &str) -> (ProfileStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("linkterm-prof-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("nested").join("profiles.json");
        (ProfileStore::new(&path), dir)
    }

    fn ssh(host: &str) -> serde_json::Value {
        json!({"type": "ssh", "host": host, "port": 22, "username": "alice", "authKind": "keychain"})
    }

    #[test]
    fn empty_when_no_file() {
        let (s, dir) = store("empty");
        assert!(s.list().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn saved_profiles_are_listed_in_creation_order_with_unique_ids() {
        let (s, dir) = store("order");
        let a = s.save(None, "本番サーバー", ssh("a")).unwrap();
        let b = s.save(None, "検証サーバー", ssh("b")).unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(s.list().unwrap(), vec![a, b]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn secrets_are_never_stored() {
        let (s, dir) = store("secrets");
        let mut v = ssh("h");
        v["password"] = json!("hunter2");
        v["passphrase"] = json!("pp");
        let saved = s.save(None, "x", v).unwrap();
        assert!(saved.values.get("password").is_none());
        assert!(saved.values.get("passphrase").is_none());
        assert_eq!(saved.values["host"], "h");
        let raw = std::fs::read_to_string(dir.join("nested").join("profiles.json")).unwrap();
        assert!(!raw.contains("hunter2") && !raw.contains("\"pp\""), "{raw}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn save_with_existing_id_updates_in_place() {
        let (s, dir) = store("upsert");
        let a = s.save(None, "a", ssh("a")).unwrap();
        let b = s.save(None, "b", ssh("b")).unwrap();
        let a2 = s.save(Some(&a.id), "a-renamed", ssh("a2")).unwrap();
        assert_eq!(a2.id, a.id);
        let all = s.list().unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].name, "a-renamed");
        assert_eq!(all[0].values["host"], "a2");
        assert_eq!(all[1], b);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn save_with_unknown_id_creates_a_new_profile() {
        let (s, dir) = store("unknown-id");
        let p = s.save(Some("does-not-exist"), "n", ssh("h")).unwrap();
        assert_eq!(s.list().unwrap(), vec![p]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn delete_removes_and_reports_whether_it_existed() {
        let (s, dir) = store("delete");
        let a = s.save(None, "a", ssh("a")).unwrap();
        let b = s.save(None, "b", ssh("b")).unwrap();
        assert!(s.delete(&a.id).unwrap());
        assert!(!s.delete(&a.id).unwrap());
        assert_eq!(s.list().unwrap(), vec![b]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn invalid_input_is_rejected() {
        let (s, dir) = store("invalid");
        assert!(matches!(
            s.save(None, "", ssh("h")),
            Err(ProfileError::Invalid(_))
        ));
        assert!(matches!(
            s.save(None, "   ", ssh("h")),
            Err(ProfileError::Invalid(_))
        ));
        let long = "あ".repeat(MAX_NAME_CHARS + 1);
        assert!(matches!(
            s.save(None, &long, ssh("h")),
            Err(ProfileError::Invalid(_))
        ));
        assert!(s.save(None, &"あ".repeat(MAX_NAME_CHARS), ssh("h")).is_ok());
        for bad in [json!("str"), json!(1), json!([1]), json!(null)] {
            assert!(matches!(
                s.save(None, "n", bad),
                Err(ProfileError::Invalid(_))
            ));
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn name_is_trimmed() {
        let (s, dir) = store("trim");
        assert_eq!(
            s.save(None, "  my host  ", ssh("h")).unwrap().name,
            "my host"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn persists_across_instances_with_private_permissions() {
        let (s, dir) = store("persist");
        let p = s.save(None, "n", ssh("h")).unwrap();
        let path = dir.join("nested").join("profiles.json");
        assert_eq!(ProfileStore::new(&path).list().unwrap(), vec![p]);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_file_is_an_error_and_is_not_overwritten() {
        let (s, dir) = store("corrupt");
        let path = dir.join("nested").join("profiles.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();
        assert!(matches!(s.list(), Err(ProfileError::Parse { .. })));
        assert!(s.save(None, "n", ssh("h")).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn concurrent_saves_keep_every_profile_and_leave_no_temp_files() {
        let (s, dir) = store("concurrent");
        let s = Arc::new(s);
        let n = 24;
        let barrier = Arc::new(std::sync::Barrier::new(n));
        let handles: Vec<_> = (0..n)
            .map(|i| {
                let (s, b) = (s.clone(), barrier.clone());
                std::thread::spawn(move || {
                    b.wait();
                    s.save(None, &format!("p{i}"), ssh(&format!("h{i}")))
                        .unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(s.list().unwrap().len(), n);
        let files: Vec<_> = std::fs::read_dir(dir.join("nested"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(files, vec!["profiles.json".to_string()]);
        let _ = std::fs::remove_dir_all(dir);
    }
}

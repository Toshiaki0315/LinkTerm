//! SSHホスト鍵の検証。公開鍵のフィンガープリントのみを保存する（秘密情報ではない）。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use async_trait::async_trait;

use super::TerminalError;

/// 保存済みフィンガープリントと提示されたものの照合結果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyStatus {
    Trusted,
    /// 初回接続。ユーザーの承認が必要。
    Unknown,
    /// 保存済みと異なる。中間者攻撃の可能性があるため常に拒否する。
    Mismatch {
        expected: String,
    },
}

pub trait KnownHostsStore: Send + Sync {
    fn lookup(&self, host: &str, port: u16) -> Result<Option<String>, TerminalError>;
    fn save(&self, host: &str, port: u16, fingerprint: &str) -> Result<(), TerminalError>;
}

/// 未知のホスト鍵をユーザーに承認させる（UIのダイアログが実装する）。
#[async_trait]
pub trait HostKeyApprover: Send + Sync {
    async fn approve_unknown(&self, host: &str, port: u16, fingerprint: &str) -> bool;
}

pub fn check_host_key(
    store: &dyn KnownHostsStore,
    host: &str,
    port: u16,
    fingerprint: &str,
) -> Result<HostKeyStatus, TerminalError> {
    Ok(match store.lookup(host, port)? {
        None => HostKeyStatus::Unknown,
        Some(saved) if saved == fingerprint => HostKeyStatus::Trusted,
        Some(expected) => HostKeyStatus::Mismatch { expected },
    })
}

/// 照合し、未知の場合のみ承認を求めて保存する。受け入れ可なら `Ok(())`。
pub async fn verify_host_key(
    store: &dyn KnownHostsStore,
    approver: &dyn HostKeyApprover,
    host: &str,
    port: u16,
    fingerprint: &str,
) -> Result<(), TerminalError> {
    match check_host_key(store, host, port, fingerprint)? {
        HostKeyStatus::Trusted => Ok(()),
        HostKeyStatus::Unknown => {
            if approver.approve_unknown(host, port, fingerprint).await {
                store.save(host, port, fingerprint)
            } else {
                Err(TerminalError::HostKeyRejected(format!(
                    "{host}:{port} のホスト鍵が承認されませんでした"
                )))
            }
        }
        HostKeyStatus::Mismatch { expected } => Err(TerminalError::HostKeyRejected(format!(
            "{host}:{port} のホスト鍵が変更されています（保存済み: {expected}, 提示: {fingerprint}）"
        ))),
    }
}

fn key(host: &str, port: u16) -> String {
    format!("{host}:{port}")
}

#[derive(Debug, Default)]
pub struct InMemoryKnownHosts {
    items: Mutex<HashMap<String, String>>,
}

impl KnownHostsStore for InMemoryKnownHosts {
    fn lookup(&self, host: &str, port: u16) -> Result<Option<String>, TerminalError> {
        let items = self.items.lock().expect("known_hostsのロックが破損");
        Ok(items.get(&key(host, port)).cloned())
    }

    fn save(&self, host: &str, port: u16, fingerprint: &str) -> Result<(), TerminalError> {
        let mut items = self.items.lock().expect("known_hostsのロックが破損");
        items.insert(key(host, port), fingerprint.into());
        Ok(())
    }
}

/// JSONファイルに保存するストア。
#[derive(Debug)]
pub struct FileKnownHosts {
    path: PathBuf,
}

impl FileKnownHosts {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    fn read(&self) -> Result<HashMap<String, String>, TerminalError> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text).map_err(|e| {
                TerminalError::io(
                    format!("{} の解析", self.path.display()),
                    std::io::Error::new(std::io::ErrorKind::InvalidData, e),
                )
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
            Err(e) => Err(TerminalError::io(
                format!("{} の読み込み", self.path.display()),
                e,
            )),
        }
    }
}

impl KnownHostsStore for FileKnownHosts {
    fn lookup(&self, host: &str, port: u16) -> Result<Option<String>, TerminalError> {
        Ok(self.read()?.get(&key(host, port)).cloned())
    }

    fn save(&self, host: &str, port: u16, fingerprint: &str) -> Result<(), TerminalError> {
        let mut all = self.read()?;
        all.insert(key(host, port), fingerprint.into());
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| TerminalError::io(format!("{} の作成", dir.display()), e))?;
        }
        let text = serde_json::to_string_pretty(&all).map_err(|e| {
            TerminalError::io("known_hostsのシリアライズ", std::io::Error::other(e))
        })?;
        std::fs::write(&self.path, text)
            .map_err(|e| TerminalError::io(format!("{} の書き込み", self.path.display()), e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FixedApprover {
        answer: bool,
        asked: AtomicUsize,
    }

    impl FixedApprover {
        fn new(answer: bool) -> Self {
            Self {
                answer,
                asked: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl HostKeyApprover for FixedApprover {
        async fn approve_unknown(&self, _: &str, _: u16, _: &str) -> bool {
            self.asked.fetch_add(1, Ordering::SeqCst);
            self.answer
        }
    }

    #[test]
    fn unknown_then_trusted_then_mismatch() {
        let store = InMemoryKnownHosts::default();
        assert_eq!(
            check_host_key(&store, "h", 22, "SHA256:a").unwrap(),
            HostKeyStatus::Unknown
        );
        store.save("h", 22, "SHA256:a").unwrap();
        assert_eq!(
            check_host_key(&store, "h", 22, "SHA256:a").unwrap(),
            HostKeyStatus::Trusted
        );
        assert_eq!(
            check_host_key(&store, "h", 22, "SHA256:b").unwrap(),
            HostKeyStatus::Mismatch {
                expected: "SHA256:a".into()
            }
        );
        // ポートが違えば別ホスト扱い
        assert_eq!(
            check_host_key(&store, "h", 2222, "SHA256:a").unwrap(),
            HostKeyStatus::Unknown
        );
    }

    #[tokio::test]
    async fn unknown_host_is_saved_only_when_approved() {
        let store = InMemoryKnownHosts::default();
        let no = FixedApprover::new(false);
        let r = verify_host_key(&store, &no, "h", 22, "SHA256:a").await;
        assert!(matches!(r, Err(TerminalError::HostKeyRejected(_))));
        assert!(store.lookup("h", 22).unwrap().is_none());

        let yes = FixedApprover::new(true);
        verify_host_key(&store, &yes, "h", 22, "SHA256:a")
            .await
            .unwrap();
        assert_eq!(store.lookup("h", 22).unwrap().as_deref(), Some("SHA256:a"));

        // 2回目は承認を求めない
        verify_host_key(&store, &yes, "h", 22, "SHA256:a")
            .await
            .unwrap();
        assert_eq!(yes.asked.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn mismatch_is_rejected_without_asking() {
        let store = InMemoryKnownHosts::default();
        store.save("h", 22, "SHA256:a").unwrap();
        let yes = FixedApprover::new(true);
        let r = verify_host_key(&store, &yes, "h", 22, "SHA256:evil").await;
        assert!(matches!(r, Err(TerminalError::HostKeyRejected(_))));
        assert_eq!(yes.asked.load(Ordering::SeqCst), 0);
        assert_eq!(store.lookup("h", 22).unwrap().as_deref(), Some("SHA256:a"));
    }

    #[test]
    fn file_store_persists_across_instances() {
        let dir = std::env::temp_dir().join(format!("linkterm-kh-{}", std::process::id()));
        let path = dir.join("nested").join("known_hosts.json");
        let _ = std::fs::remove_dir_all(&dir);

        let a = FileKnownHosts::new(&path);
        assert!(a.lookup("h", 22).unwrap().is_none());
        a.save("h", 22, "SHA256:a").unwrap();

        let b = FileKnownHosts::new(&path);
        assert_eq!(b.lookup("h", 22).unwrap().as_deref(), Some("SHA256:a"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_is_an_error_not_silently_reset() {
        let dir = std::env::temp_dir().join(format!("linkterm-kh-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("known_hosts.json");
        std::fs::write(&path, "not json").unwrap();
        assert!(FileKnownHosts::new(&path).lookup("h", 22).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

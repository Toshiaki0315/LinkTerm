//! 認証情報の保管。永続化は macOS Keychain に限定し、平文ファイルには保存しない。

use std::collections::HashMap;
use std::sync::Mutex;

use thiserror::Error;
use zeroize::Zeroizing;

#[derive(Debug, Error)]
pub enum CredentialError {
    #[error("Keychainの操作に失敗しました ({context}): {source}")]
    Keychain {
        context: String,
        #[source]
        source: keyring::Error,
    },
    #[error("認証情報ストアのロックが破損しています")]
    Poisoned,
}

/// 秘密情報はドロップ時にメモリ上で消去される `Zeroizing` で返す。
pub trait CredentialStore: Send + Sync {
    fn save(&self, account: &str, secret: &str) -> Result<(), CredentialError>;
    fn load(&self, account: &str) -> Result<Option<Zeroizing<String>>, CredentialError>;
    /// 存在しない場合もエラーにしない。
    fn delete(&self, account: &str) -> Result<(), CredentialError>;
}

/// macOS Keychain（`keyring`）を使うストア。
#[derive(Debug, Clone)]
pub struct KeychainStore {
    service: String,
}

impl KeychainStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self, account: &str, context: &str) -> Result<keyring::Entry, CredentialError> {
        keyring::Entry::new(&self.service, account).map_err(|source| CredentialError::Keychain {
            context: context.into(),
            source,
        })
    }
}

impl CredentialStore for KeychainStore {
    fn save(&self, account: &str, secret: &str) -> Result<(), CredentialError> {
        self.entry(account, "エントリ作成")?
            .set_password(secret)
            .map_err(|source| CredentialError::Keychain {
                context: "保存".into(),
                source,
            })
    }

    fn load(&self, account: &str) -> Result<Option<Zeroizing<String>>, CredentialError> {
        match self.entry(account, "エントリ作成")?.get_password() {
            Ok(s) => Ok(Some(Zeroizing::new(s))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(source) => Err(CredentialError::Keychain {
                context: "読み出し".into(),
                source,
            }),
        }
    }

    fn delete(&self, account: &str) -> Result<(), CredentialError> {
        match self.entry(account, "エントリ作成")?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(source) => Err(CredentialError::Keychain {
                context: "削除".into(),
                source,
            }),
        }
    }
}

/// テストおよびKeychain非対応環境向けのメモリ上ストア（永続化しない）。
#[derive(Debug, Default)]
pub struct InMemoryStore {
    items: Mutex<HashMap<String, Zeroizing<String>>>,
}

impl CredentialStore for InMemoryStore {
    fn save(&self, account: &str, secret: &str) -> Result<(), CredentialError> {
        let mut items = self.items.lock().map_err(|_| CredentialError::Poisoned)?;
        items.insert(account.into(), Zeroizing::new(secret.into()));
        Ok(())
    }

    fn load(&self, account: &str) -> Result<Option<Zeroizing<String>>, CredentialError> {
        let items = self.items.lock().map_err(|_| CredentialError::Poisoned)?;
        Ok(items.get(account).map(|s| Zeroizing::new(s.to_string())))
    }

    fn delete(&self, account: &str) -> Result<(), CredentialError> {
        let mut items = self.items.lock().map_err(|_| CredentialError::Poisoned)?;
        items.remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exercise(store: &dyn CredentialStore, account: &str) {
        assert!(store.load(account).unwrap().is_none());
        store.save(account, "s3cret").unwrap();
        assert_eq!(store.load(account).unwrap().unwrap().as_str(), "s3cret");
        store.save(account, "changed").unwrap();
        assert_eq!(store.load(account).unwrap().unwrap().as_str(), "changed");
        store.delete(account).unwrap();
        store.delete(account).unwrap(); // 冪等
        assert!(store.load(account).unwrap().is_none());
    }

    #[test]
    fn in_memory_store_roundtrip() {
        exercise(&InMemoryStore::default(), "user@host:22");
    }

    /// 実Keychainを使う。ロック解除が必要なため通常は実行しない:
    /// `cargo test -- --ignored keychain`
    #[test]
    #[ignore]
    fn keychain_store_roundtrip() {
        let store = KeychainStore::new("com.linkterm.app.test");
        exercise(&store, "linkterm-test@localhost:22");
    }
}

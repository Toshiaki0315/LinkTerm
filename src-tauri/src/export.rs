//! 画面の内容（テキスト）をファイルへ保存する。保存先は、ユーザーが保存ダイアログで選んだ場所。
//!
//! 画面には秘密情報が出ていることがあるため、保存したファイルは所有者のみ読み書きできる（0600）。

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use thiserror::Error;

/// 保存できる大きさの上限。
pub const MAX_EXPORT_BYTES: usize = 64 * 1024 * 1024;

static COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Error)]
pub enum ExportError {
    #[error("保存先が不正です: {0}")]
    Invalid(String),
    #[error("ファイルへ書き込めません ({path}): {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
}

/// `content` を `path` へ保存する。既存のファイルは置き換える（上書きの確認は、保存ダイアログが行う）。
pub fn save_text(path: &Path, content: &str) -> Result<(), ExportError> {
    if !path.is_absolute() || path.to_string_lossy().contains('\0') {
        return Err(ExportError::Invalid("絶対パスで指定してください".into()));
    }
    if path.file_name().is_none() {
        return Err(ExportError::Invalid("ファイル名がありません".into()));
    }
    if path.is_dir() {
        return Err(ExportError::Invalid("フォルダーには保存できません".into()));
    }
    let parent = path.parent().filter(|p| p.is_dir());
    if parent.is_none() {
        return Err(ExportError::Invalid(
            "保存先のフォルダーがありません".into(),
        ));
    }
    if content.len() > MAX_EXPORT_BYTES {
        return Err(ExportError::Invalid(format!(
            "内容が大きすぎます（{}MB まで）",
            MAX_EXPORT_BYTES / 1024 / 1024
        )));
    }
    let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
    crate::atomic_file::write_private(path, content.as_bytes(), unique).map_err(|source| {
        ExportError::Io {
            path: path.display().to_string(),
            source,
        }
    })
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("linkterm-export-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn saves_the_text_with_private_permissions_and_replaces_an_existing_file() {
        let d = dir("ok");
        let path = d.join("out.txt");
        std::fs::write(&path, "old").unwrap();
        save_text(&path, "新しい内容\nline2\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "新しい内容\nline2\n"
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn rejects_relative_paths_directories_and_missing_parents() {
        let d = dir("bad");
        assert!(matches!(
            save_text(Path::new("relative.txt"), "x"),
            Err(ExportError::Invalid(_))
        ));
        assert!(matches!(save_text(&d, "x"), Err(ExportError::Invalid(_))));
        assert!(matches!(
            save_text(&d.join("no-such-dir").join("a.txt"), "x"),
            Err(ExportError::Invalid(_))
        ));
        assert!(matches!(
            save_text(Path::new("/"), "x"),
            Err(ExportError::Invalid(_))
        ));
        // 保存先を作っていない（親を勝手に作らない）。
        assert!(!d.join("no-such-dir").exists());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn rejects_too_large_content_without_writing() {
        let d = dir("big");
        let path = d.join("big.txt");
        let content = "a".repeat(MAX_EXPORT_BYTES + 1);
        assert!(matches!(
            save_text(&path, &content),
            Err(ExportError::Invalid(_))
        ));
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(d);
    }
}

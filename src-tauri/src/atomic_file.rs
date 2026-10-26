//! 所有者のみ読み書きできるファイルの、原子的な書き込み。

use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

/// `path` を `data` で置き換える。一時ファイル（0600）に書いてから `rename` するため、
/// 途中で失敗しても元のファイルは壊れない。`unique` は同時書き込みの一時ファイル名を分けるための値。
pub fn write_private(path: &Path, data: &[u8], unique: u64) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("tmp-{}-{unique}", std::process::id()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&tmp)?;
        file.write_all(data)?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("linkterm-atomic-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn creates_parent_dirs_and_writes_with_0600() {
        let d = dir("create");
        let path = d.join("a").join("b.json");
        write_private(&path, b"hello", 0).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"hello");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn replaces_existing_content_and_leaves_no_temp_file() {
        let d = dir("replace");
        let path = d.join("f.json");
        write_private(&path, b"old old old", 0).unwrap();
        write_private(&path, b"new", 1).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        let names: Vec<_> = std::fs::read_dir(&d)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["f.json".to_string()]);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn failure_keeps_the_original_file() {
        let d = dir("fail");
        let path = d.join("f.json");
        write_private(&path, b"keep", 0).unwrap();
        // 同名の一時ファイルが既にあると create_new が失敗する。
        let tmp = path.with_extension(format!("tmp-{}-7", std::process::id()));
        std::fs::write(&tmp, "x").unwrap();
        assert!(write_private(&path, b"lost", 7).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"keep");
        let _ = std::fs::remove_dir_all(d);
    }
}

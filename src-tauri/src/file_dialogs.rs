//! ファイルを選ぶ・保存先を選ぶ操作の、バックエンド側の処理。
//!
//! 読み書きするファイルのパスは、バックエンド自身が開くファイルダイアログで利用者が選んだものだけにする。
//! 画面（WebView）はパスを渡せない。画面が乗っ取られても、任意のファイルの読み書きに
//! これらのコマンドを使えないようにするため。ダイアログを開く部分は `pick` として外から渡し、
//! ここには、選ばれたパスの扱い（読み込み・検証・保存）だけを置く（ダイアログなしで試験できる）。

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::commands::CommandResult;
use crate::profiles::{ImportReport, ProfileStore};

/// 読み込んだマクロ（名前はファイル名から拡張子を除いたもの）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PickedMacro {
    pub name: String,
    pub text: String,
}

/// 書き出した接続の保存先と件数。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExportDone {
    pub path: String,
    pub count: usize,
}

/// 保存ダイアログの初期のファイル名として使える形にする（フォルダーの指定や制御文字は取り除く）。
pub fn safe_default_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base.chars().filter(|c| !c.is_control()).take(100).collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_owned();
    if cleaned.is_empty() {
        "linkterm.txt".into()
    } else {
        cleaned
    }
}

/// 選んだ `.ttl` ファイルを読む。選ばなかった（キャンセル）なら `None`。
pub fn read_macro(pick: impl FnOnce() -> Option<PathBuf>) -> CommandResult<Option<PickedMacro>> {
    let Some(path) = pick() else {
        return Ok(None);
    };
    let text = crate::macros::read_script_file(&path)?;
    let name = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(Some(PickedMacro { name, text }))
}

/// 画面のテキストを、選んだ場所へ保存する。保存したパスを返す（キャンセルなら `None`）。
pub fn save_text(
    content: &str,
    pick: impl FnOnce() -> Option<PathBuf>,
) -> CommandResult<Option<String>> {
    let Some(path) = pick() else {
        return Ok(None);
    };
    crate::export::save_text(&path, content)?;
    Ok(Some(path.display().to_string()))
}

/// 保存済みの接続を、選んだ場所へ書き出す（パスワード類は含めない）。
pub fn export_profiles(
    store: &ProfileStore,
    pick: impl FnOnce() -> Option<PathBuf>,
) -> CommandResult<Option<ExportDone>> {
    let Some(path) = pick() else {
        return Ok(None);
    };
    let profiles = store.list()?;
    let text = crate::profiles::export_text(&profiles)?;
    crate::export::save_text(&path, &text)?;
    Ok(Some(ExportDone {
        path: path.display().to_string(),
        count: profiles.len(),
    }))
}

/// 選んだファイルから、保存済みの接続を取り込む。
pub fn import_profiles(
    store: &ProfileStore,
    pick: impl FnOnce() -> Option<PathBuf>,
) -> CommandResult<Option<ImportReport>> {
    let Some(path) = pick() else {
        return Ok(None);
    };
    Ok(Some(store.import_file(Path::new(&path))?))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("linkterm-fd-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn store(d: &Path) -> ProfileStore {
        ProfileStore::new(d.join("profiles.json"))
    }

    #[test]
    fn cancelling_does_nothing_for_every_operation() {
        let d = dir("cancel");
        let s = store(&d);
        assert_eq!(read_macro(|| None).unwrap(), None);
        assert_eq!(save_text("x", || None).unwrap(), None);
        assert_eq!(export_profiles(&s, || None).unwrap(), None);
        assert_eq!(import_profiles(&s, || None).unwrap(), None);
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 0, "何も作らない");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn read_macro_returns_text_and_name_without_extension() {
        let d = dir("macro");
        let file = d.join("login.v2.ttl");
        std::fs::write(&file, "sendln 'あ'\n").unwrap();
        let got = read_macro(|| Some(file.clone())).unwrap().unwrap();
        assert_eq!(
            got,
            PickedMacro {
                name: "login.v2".into(),
                text: "sendln 'あ'\n".into()
            }
        );
        // 読めないファイルはエラー（空の成功にしない）。
        assert!(read_macro(|| Some(d.join("none.ttl"))).is_err());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn save_text_writes_the_chosen_file_and_reports_the_path() {
        let d = dir("save");
        let file = d.join("out.txt");
        let path = save_text("hello\n", || Some(file.clone()))
            .unwrap()
            .unwrap();
        assert_eq!(path, file.display().to_string());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "hello\n");
        // 保存先のフォルダーがない場合はエラー。
        assert!(save_text("x", || Some(d.join("no-such-dir").join("a.txt"))).is_err());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn export_then_import_round_trips_through_the_chosen_files() {
        let d = dir("profiles");
        let a = store(&d);
        a.save(None, "本番", json!({"type": "local"})).unwrap();
        let file = d.join("out.json");
        let done = export_profiles(&a, || Some(file.clone())).unwrap().unwrap();
        assert_eq!(done.count, 1);
        assert_eq!(done.path, file.display().to_string());

        let other = ProfileStore::new(d.join("other.json"));
        let report = import_profiles(&other, || Some(file.clone()))
            .unwrap()
            .unwrap();
        assert_eq!(
            report,
            ImportReport {
                added: 1,
                skipped: 0
            }
        );
        assert_eq!(other.list().unwrap()[0].name, "本番");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn safe_default_name_drops_folders_dots_and_control_characters() {
        assert_eq!(
            safe_default_name("terminal-20260101-000000.txt"),
            "terminal-20260101-000000.txt"
        );
        assert_eq!(safe_default_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_default_name("C:\\a\\b.txt"), "b.txt");
        assert_eq!(safe_default_name(".bashrc"), "bashrc");
        assert_eq!(safe_default_name("a\nb\0.txt"), "ab.txt");
        assert_eq!(safe_default_name(""), "linkterm.txt");
        assert_eq!(safe_default_name("/"), "linkterm.txt");
        assert_eq!(safe_default_name(&"x".repeat(500)).chars().count(), 100);
    }
}

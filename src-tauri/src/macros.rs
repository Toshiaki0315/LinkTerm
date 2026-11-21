//! マクロ（Tera Term の TTL 互換のスクリプト）の保存と、`.ttl` ファイルの読み込み。
//!
//! アプリのデータフォルダへ平文の JSON として保存する（所有者のみ読み書き可）。
//! スクリプトにパスワードなどの秘密情報を書かないこと（画面側でも注意を表示する。
//! パスワードは `passwordbox` で実行時に入力する）。

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const MAX_MACROS: usize = 100;
pub const MAX_NAME_CHARS: usize = 60;
/// スクリプト本文の上限（文字数）。画面側の上限（`MAX_SOURCE_CHARS`）と揃える。
pub const MAX_TEXT_CHARS: usize = 100_000;
pub const MAX_ID_CHARS: usize = 100;
/// 読み込む `.ttl` ファイルの大きさの上限（バイト）。Shift_JIS は 1 文字 2 バイトなので、余裕を持たせる。
pub const MAX_FILE_BYTES: u64 = 400_000;

#[derive(Debug, Error)]
pub enum MacroError {
    #[error("マクロが不正です: {0}")]
    Invalid(String),
    #[error("マクロの保存ファイルを操作できません ({context}): {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
    #[error("マクロの保存ファイル {path} を解析できません: {source}")]
    Parse {
        path: String,
        #[source]
        source: serde_json::Error,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Macro {
    pub id: String,
    pub name: String,
    /// スクリプト本文（TTL）。
    pub text: String,
}

#[derive(Debug)]
pub struct MacroStore {
    path: PathBuf,
    lock: Mutex<()>,
    counter: AtomicU64,
}

impl MacroStore {
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

    /// 保存済みの一覧。ファイルがなければ空。壊れていればエラー。
    pub fn load(&self) -> Result<Vec<Macro>, MacroError> {
        let _guard = self.guard();
        match std::fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text).map_err(|source| MacroError::Parse {
                path: self.path.display().to_string(),
                source,
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(MacroError::Io {
                context: format!("{} の読み込み", self.path.display()),
                source: e,
            }),
        }
    }

    /// 検証して保存し、保存した内容（名前の前後の空白を除いたもの）を返す。
    pub fn save(&self, macros: Vec<Macro>) -> Result<Vec<Macro>, MacroError> {
        let macros = validate(macros)?;
        let text = serde_json::to_string_pretty(&macros).map_err(|e| MacroError::Io {
            context: "シリアライズ".into(),
            source: std::io::Error::other(e),
        })?;
        let _guard = self.guard();
        let unique = self.counter.fetch_add(1, Ordering::Relaxed);
        crate::atomic_file::write_private(&self.path, text.as_bytes(), unique).map_err(|e| {
            MacroError::Io {
                context: format!("{} の書き込み", self.path.display()),
                source: e,
            }
        })?;
        Ok(macros)
    }
}

fn validate(mut macros: Vec<Macro>) -> Result<Vec<Macro>, MacroError> {
    if macros.len() > MAX_MACROS {
        return Err(MacroError::Invalid(format!(
            "マクロは{MAX_MACROS}個までです"
        )));
    }
    let mut ids = HashSet::new();
    for m in &mut macros {
        let id = m.id.trim();
        if id.is_empty() || id.chars().count() > MAX_ID_CHARS {
            return Err(MacroError::Invalid("IDが不正です".into()));
        }
        if !ids.insert(id.to_owned()) {
            return Err(MacroError::Invalid(format!("IDが重複しています: {id}")));
        }
        m.id = id.to_owned();
        m.name = m.name.trim().to_owned();
        if m.name.is_empty() || m.name.chars().count() > MAX_NAME_CHARS {
            return Err(MacroError::Invalid(format!(
                "名前は1〜{MAX_NAME_CHARS}文字で入力してください"
            )));
        }
        if m.text.trim().is_empty() || m.text.chars().count() > MAX_TEXT_CHARS {
            return Err(MacroError::Invalid(format!(
                "スクリプトは1〜{MAX_TEXT_CHARS}文字で入力してください"
            )));
        }
        if m.text.contains('\0') {
            return Err(MacroError::Invalid(
                "スクリプトに使えない文字（NUL）が含まれています".into(),
            ));
        }
    }
    Ok(macros)
}

/// `.ttl` ファイルを読む。UTF-8 でなければ Shift_JIS（Tera Term の既定）として読む。
/// 通常のファイルで、大きさが上限以下のものだけを受け付ける。
pub fn read_script_file(path: &Path) -> Result<String, MacroError> {
    let io = |context: String| move |source| MacroError::Io { context, source };
    let meta = std::fs::metadata(path).map_err(io(format!("{} の確認", path.display())))?;
    if !meta.is_file() {
        return Err(MacroError::Invalid("通常のファイルを選んでください".into()));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(MacroError::Invalid(format!(
            "ファイルが大きすぎます（{}バイトまで）",
            MAX_FILE_BYTES
        )));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(io(format!("{} を開く", path.display())))?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io(format!("{} の読み込み", path.display())))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(MacroError::Invalid(format!(
            "ファイルが大きすぎます（{}バイトまで）",
            MAX_FILE_BYTES
        )));
    }
    if bytes.contains(&0) {
        return Err(MacroError::Invalid(
            "テキストファイルではありません（NUL を含んでいます）".into(),
        ));
    }
    // UTF-8 の BOM は取り除く。
    let body = bytes
        .strip_prefix(&[0xEF, 0xBB, 0xBF][..])
        .unwrap_or(&bytes);
    match std::str::from_utf8(body) {
        Ok(text) => Ok(text.to_owned()),
        Err(_) => {
            let (text, _, had_errors) = encoding_rs::SHIFT_JIS.decode(body);
            if had_errors {
                return Err(MacroError::Invalid(
                    "文字コードを判定できません（UTF-8 または Shift_JIS のファイルを選んでください）"
                        .into(),
                ));
            }
            Ok(text.into_owned())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn store(name: &str) -> (MacroStore, PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("linkterm-mc-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("sub").join("macros.json");
        (MacroStore::new(&path), path, dir)
    }

    fn mac(id: &str) -> Macro {
        Macro {
            id: id.into(),
            name: format!("name-{id}"),
            text: "wait 'login:'\nsendln 'admin'".into(),
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
        let list = vec![mac("a"), mac("b")];
        assert_eq!(s.save(list.clone()).unwrap(), list);
        assert_eq!(MacroStore::new(&path).load().unwrap(), list);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn names_are_trimmed_and_japanese_text_survives() {
        let (s, _, dir) = store("trim");
        let mut m = mac("a");
        m.name = "  ログイン  ".into();
        m.text = "messagebox 'こんにちは' 'あ'".into();
        let saved = s.save(vec![m]).unwrap();
        assert_eq!(saved[0].name, "ログイン");
        assert_eq!(s.load().unwrap()[0].text, "messagebox 'こんにちは' 'あ'");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn invalid_macros_are_rejected_and_nothing_is_written() {
        let (s, path, dir) = store("invalid");
        let mut cases: Vec<Vec<Macro>> = Vec::new();
        let mut c = mac("a");
        c.name = "  ".into();
        cases.push(vec![c]);
        let mut c = mac("a");
        c.name = "あ".repeat(MAX_NAME_CHARS + 1);
        cases.push(vec![c]);
        let mut c = mac("a");
        c.text = "  \n ".into();
        cases.push(vec![c]);
        let mut c = mac("a");
        c.text = "x".repeat(MAX_TEXT_CHARS + 1);
        cases.push(vec![c]);
        let mut c = mac("a");
        c.text = "a\0b".into();
        cases.push(vec![c]);
        let mut c = mac("a");
        c.id = " ".into();
        cases.push(vec![c]);
        cases.push(vec![mac("a"), mac("a")]);
        cases.push((0..=MAX_MACROS).map(|i| mac(&i.to_string())).collect());
        for case in cases {
            assert!(matches!(s.save(case), Err(MacroError::Invalid(_))));
        }
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_size_limit_matches_the_frontend() {
        let (s, _, dir) = store("limit");
        let mut m = mac("a");
        m.text = "a".repeat(MAX_TEXT_CHARS);
        assert!(s.save(vec![m]).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_file_is_an_error_not_silently_reset() {
        let (s, path, dir) = store("corrupt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{not json").unwrap();
        assert!(matches!(s.load(), Err(MacroError::Parse { .. })));
        let _ = std::fs::remove_dir_all(dir);
    }

    fn file(name: &str, bytes: &[u8]) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("linkterm-ttl-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.ttl");
        std::fs::write(&path, bytes).unwrap();
        (path, dir)
    }

    #[test]
    fn reads_utf8_and_strips_the_bom() {
        let (path, dir) = file("utf8", "\u{feff}sendln 'あ'\n".as_bytes());
        assert_eq!(read_script_file(&path).unwrap(), "sendln 'あ'\n");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn reads_shift_jis_when_it_is_not_utf8() {
        let (bytes, _, _) = encoding_rs::SHIFT_JIS.encode("messagebox 'こんにちは' 'タイトル'\r\n");
        let (path, dir) = file("sjis", &bytes);
        assert_eq!(
            read_script_file(&path).unwrap(),
            "messagebox 'こんにちは' 'タイトル'\r\n"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_binary_huge_and_non_regular_files() {
        let (path, dir) = file("bin", b"abc\0def");
        assert!(matches!(
            read_script_file(&path),
            Err(MacroError::Invalid(_))
        ));
        let _ = std::fs::remove_dir_all(dir);

        let big = vec![b'a'; (MAX_FILE_BYTES + 1) as usize];
        let (path, dir) = file("big", &big);
        let err = read_script_file(&path).unwrap_err();
        assert!(err.to_string().contains("大きすぎます"), "{err}");
        let _ = std::fs::remove_dir_all(dir);

        let (path, dir) = file("dir", b"x");
        assert!(matches!(
            read_script_file(path.parent().unwrap()),
            Err(MacroError::Invalid(_))
        ));
        let _ = std::fs::remove_dir_all(dir);

        assert!(matches!(
            read_script_file(Path::new("/nonexistent/linkterm.ttl")),
            Err(MacroError::Io { .. })
        ));
    }

    #[test]
    fn undecodable_bytes_are_an_error_with_a_hint() {
        // UTF-8 でも Shift_JIS でも読めない並び。
        let (path, dir) = file("bad", &[0x81, 0x20, 0xFF, 0xFE]);
        let err = read_script_file(&path).unwrap_err();
        assert!(err.to_string().contains("文字コード"), "{err}");
        let _ = std::fs::remove_dir_all(dir);
    }
}

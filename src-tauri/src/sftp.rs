//! SFTP によるファイルの一覧・ダウンロード・アップロード。
//!
//! 転送の手順は `RemoteFs`（リモートのファイルシステム）の上に書き、`russh-sftp` への接続は
//! `SftpFs` に閉じ込める。ダウンロード先は固定のフォルダー（ダウンロード）に限り、
//! 既存のファイルは上書きしない。アップロードは、上書きを明示したときだけ上書きする。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use serde::Serialize;
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// 転送で一度に読み書きする大きさ。
const CHUNK: usize = 64 * 1024;
/// 1つのフォルダーで一覧する件数の上限（極端に多いフォルダーでの暴走防止）。
pub const MAX_LIST_ENTRIES: usize = 20_000;

#[derive(Debug, Error)]
pub enum SftpError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0} は既に存在します")]
    Exists(String),
    #[error("転送を中止しました")]
    Cancelled,
    #[error("SFTP の操作に失敗しました ({context}): {message}")]
    Remote { context: String, message: String },
    #[error("ローカルのファイル操作に失敗しました ({context}): {source}")]
    Local {
        context: String,
        #[source]
        source: std::io::Error,
    },
}

fn local(context: impl Into<String>) -> impl FnOnce(std::io::Error) -> SftpError {
    let context = context.into();
    move |source| SftpError::Local { context, source }
}

/// 一覧の1件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// 更新時刻（UNIX 秒）。
    pub modified: Option<u64>,
    /// パーミッション（下位9ビット）。
    pub permissions: Option<u32>,
}

/// 種類と大きさ。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemoteStat {
    pub is_dir: bool,
    pub size: u64,
}

pub type RemoteReader = Box<dyn AsyncRead + Send + Unpin>;
pub type RemoteWriter = Box<dyn AsyncWrite + Send + Unpin>;

/// リモートのファイルシステム。
#[async_trait]
pub trait RemoteFs: Send + Sync {
    /// 相対パス（`.` など）を絶対パスにする。
    async fn canonicalize(&self, path: &str) -> Result<String, SftpError>;
    async fn list(&self, path: &str) -> Result<Vec<RemoteEntry>, SftpError>;
    /// 存在しなければ `None`。
    async fn stat(&self, path: &str) -> Result<Option<RemoteStat>, SftpError>;
    async fn open_read(&self, path: &str) -> Result<RemoteReader, SftpError>;
    /// 作成（既存なら切り詰め）して書き込む。
    async fn open_write(&self, path: &str) -> Result<RemoteWriter, SftpError>;
    async fn mkdir(&self, path: &str) -> Result<(), SftpError>;
    async fn remove_file(&self, path: &str) -> Result<(), SftpError>;
    async fn remove_dir(&self, path: &str) -> Result<(), SftpError>;
}

/// リモートのパスを検証する（空・NUL を含むものは受け付けない）。
pub fn validate_remote_path(path: &str) -> Result<&str, SftpError> {
    if path.is_empty() || path.contains('\0') {
        return Err(SftpError::Invalid("リモートのパスが不正です".into()));
    }
    Ok(path)
}

/// ファイル名として使える名前か（区切り・上位参照・NUL を含まない）。
pub fn validate_file_name(name: &str) -> Result<&str, SftpError> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err(SftpError::Invalid(format!("ファイル名が不正です: {name}")));
    }
    Ok(name)
}

/// ディレクトリとファイル名を `/` でつなぐ。
pub fn join_remote(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// パスの最後の要素。
fn remote_base_name(path: &str) -> Result<&str, SftpError> {
    let trimmed = path.trim_end_matches('/');
    let name = trimmed.rsplit('/').next().unwrap_or("");
    validate_file_name(name)
}

/// 一覧を、フォルダー優先・名前順に並べる。
pub fn sort_entries(entries: &mut [RemoteEntry]) {
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
}

/// 一覧を取得する。
pub async fn list_dir(fs: &dyn RemoteFs, path: &str) -> Result<Vec<RemoteEntry>, SftpError> {
    let mut entries = fs.list(validate_remote_path(path)?).await?;
    if entries.len() > MAX_LIST_ENTRIES {
        return Err(SftpError::Invalid(format!(
            "ファイルが多すぎて表示できません（{MAX_LIST_ENTRIES}件まで）"
        )));
    }
    entries.retain(|e| e.name != "." && e.name != "..");
    sort_entries(&mut entries);
    Ok(entries)
}

/// 転送の中止の合図。
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// 既存と重ならない保存先を作る（`name`, `name (1)`, `name (2)` ...）。既存のファイルは触らない。
fn create_unique(dir: &Path, name: &str) -> Result<(PathBuf, std::fs::File), SftpError> {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 0..10_000u32 {
        let candidate = if n == 0 {
            name.to_owned()
        } else {
            format!("{stem} ({n}){ext}")
        };
        let path = dir.join(&candidate);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(local(format!("{} の作成", path.display()))(e)),
        }
    }
    Err(SftpError::Invalid(
        "保存先のファイル名を決められませんでした".into(),
    ))
}

/// コピーの片側（読み取り元・書き込み先）。エラーの文脈と、ローカルかどうか。
struct Side {
    context: String,
    is_local: bool,
}

impl Side {
    fn local(context: String) -> Self {
        Self {
            context,
            is_local: true,
        }
    }
    fn remote(context: String) -> Self {
        Self {
            context,
            is_local: false,
        }
    }
    fn error(&self, e: std::io::Error) -> SftpError {
        if self.is_local {
            SftpError::Local {
                context: self.context.clone(),
                source: e,
            }
        } else {
            SftpError::Remote {
                context: self.context.clone(),
                message: e.to_string(),
            }
        }
    }
}

/// 読み取り側から書き込み側へ、進捗を通知しながらコピーする。
async fn copy_with_progress(
    reader: &mut (dyn AsyncRead + Send + Unpin),
    writer: &mut (dyn AsyncWrite + Send + Unpin),
    total: u64,
    cancel: &CancelToken,
    on_progress: &mut (dyn FnMut(u64, u64) + Send),
    (src, dst): (&Side, &Side),
) -> Result<u64, SftpError> {
    let mut buf = vec![0u8; CHUNK];
    let mut done = 0u64;
    on_progress(0, total);
    loop {
        if cancel.is_cancelled() {
            return Err(SftpError::Cancelled);
        }
        let n = reader.read(&mut buf).await.map_err(|e| src.error(e))?;
        if n == 0 {
            break;
        }
        writer
            .write_all(&buf[..n])
            .await
            .map_err(|e| dst.error(e))?;
        done += n as u64;
        on_progress(done, total.max(done));
    }
    writer.flush().await.map_err(|e| dst.error(e))?;
    writer.shutdown().await.map_err(|e| dst.error(e))?;
    Ok(done)
}

/// リモートのファイルを `dest_dir` へダウンロードする。保存したパスを返す。
/// 同じ名前のファイルがあれば `名前 (1).拡張子` のように別名にし、上書きしない。
pub async fn download(
    fs: &dyn RemoteFs,
    remote_path: &str,
    dest_dir: &Path,
    cancel: &CancelToken,
    on_progress: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<PathBuf, SftpError> {
    let remote_path = validate_remote_path(remote_path)?;
    let name = remote_base_name(remote_path)?;
    let stat = fs
        .stat(remote_path)
        .await?
        .ok_or_else(|| SftpError::Invalid(format!("{remote_path} が見つかりません")))?;
    if stat.is_dir {
        return Err(SftpError::Invalid(
            "フォルダーのダウンロードには対応していません".into(),
        ));
    }
    let mut reader = fs.open_read(remote_path).await?;
    let (path, file) = create_unique(dest_dir, name)?;
    let mut writer = tokio::fs::File::from_std(file);
    let result = copy_with_progress(
        &mut reader,
        &mut writer,
        stat.size,
        cancel,
        on_progress,
        (
            &Side::remote(format!("{remote_path} の読み込み")),
            &Side::local(format!("{} の書き込み", path.display())),
        ),
    )
    .await;
    drop(writer);
    match result {
        Ok(_) => Ok(path),
        Err(e) => {
            // 中途半端なファイルを残さない。
            let _ = std::fs::remove_file(&path);
            Err(e)
        }
    }
}

/// ローカルのファイルを `remote_dir` へアップロードする。保存したリモートのパスを返す。
/// 同名のファイルがあるときは、`overwrite` が `true` でなければ `Exists` エラー。
pub async fn upload(
    fs: &dyn RemoteFs,
    local_path: &Path,
    remote_dir: &str,
    overwrite: bool,
    cancel: &CancelToken,
    on_progress: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<String, SftpError> {
    let remote_dir = validate_remote_path(remote_dir)?;
    let meta =
        std::fs::metadata(local_path).map_err(local(format!("{} の確認", local_path.display())))?;
    if meta.is_dir() {
        return Err(SftpError::Invalid(
            "フォルダーのアップロードには対応していません".into(),
        ));
    }
    if !meta.is_file() {
        return Err(SftpError::Invalid(
            "通常のファイルだけアップロードできます".into(),
        ));
    }
    let name = local_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| SftpError::Invalid("ファイル名を読み取れません".into()))?;
    let name = validate_file_name(name)?;
    let remote_path = join_remote(remote_dir, name);
    match fs.stat(&remote_path).await? {
        Some(s) if s.is_dir => {
            return Err(SftpError::Invalid(format!(
                "{remote_path} はフォルダーのため上書きできません"
            )));
        }
        Some(_) if !overwrite => return Err(SftpError::Exists(remote_path)),
        _ => {}
    }
    let mut reader = tokio::fs::File::open(local_path)
        .await
        .map_err(local(format!("{} の読み込み", local_path.display())))?;
    let mut writer = fs.open_write(&remote_path).await?;
    let result = copy_with_progress(
        &mut reader,
        &mut writer,
        meta.len(),
        cancel,
        on_progress,
        (
            &Side::local(format!("{} の読み込み", local_path.display())),
            &Side::remote(format!("{remote_path} の書き込み")),
        ),
    )
    .await;
    drop(writer);
    match result {
        Ok(_) => Ok(remote_path),
        Err(e) => {
            // 失敗・中止したら、書きかけのファイルを消す（できなくてもエラーは元のものを返す）。
            let _ = fs.remove_file(&remote_path).await;
            Err(e)
        }
    }
}

/// フォルダー転送で扱う、ファイル・フォルダーの数の上限。
pub const MAX_TREE_ENTRIES: usize = 20_000;
/// フォルダー転送で辿る深さの上限（シンボリックリンクは辿らないが、念のため）。
pub const MAX_TREE_DEPTH: usize = 32;

/// フォルダー転送の結果。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeSummary {
    /// 保存した先（ダウンロードならローカル、アップロードならリモートのパス）。
    pub path: String,
    /// 転送したファイルの数。
    pub files: u64,
    /// 転送しなかったもの（シンボリックリンク・使えない名前・通常でないファイル）の数。
    pub skipped: u64,
}

/// 木の1件（起点からの相対パス）。
struct TreeItem {
    /// 起点からの、名前の並び。
    rel: Vec<String>,
    is_dir: bool,
    size: u64,
}

/// リモートのフォルダーの中身を、浅い順に集める。シンボリックリンクと使えない名前は飛ばす。
async fn scan_remote(fs: &dyn RemoteFs, root: &str) -> Result<(Vec<TreeItem>, u64), SftpError> {
    let mut items = Vec::new();
    let mut skipped = 0u64;
    let mut queue = std::collections::VecDeque::from([(root.to_owned(), Vec::<String>::new())]);
    while let Some((dir, rel)) = queue.pop_front() {
        if rel.len() >= MAX_TREE_DEPTH {
            return Err(SftpError::Invalid(format!(
                "フォルダーが深すぎます（{MAX_TREE_DEPTH}階層まで）"
            )));
        }
        for entry in list_dir(fs, &dir).await? {
            if entry.is_symlink || validate_file_name(&entry.name).is_err() {
                skipped += 1;
                continue;
            }
            let mut child = rel.clone();
            child.push(entry.name.clone());
            if entry.is_dir {
                queue.push_back((join_remote(&dir, &entry.name), child.clone()));
            }
            items.push(TreeItem {
                rel: child,
                is_dir: entry.is_dir,
                size: entry.size,
            });
            if items.len() > MAX_TREE_ENTRIES {
                return Err(SftpError::Invalid(format!(
                    "ファイルが多すぎます（{MAX_TREE_ENTRIES}件まで）"
                )));
            }
        }
    }
    Ok((items, skipped))
}

/// ローカルのフォルダーの中身を、浅い順に集める。シンボリックリンクと通常でないファイルは飛ばす。
fn scan_local(root: &Path) -> Result<(Vec<TreeItem>, u64), SftpError> {
    let mut items = Vec::new();
    let mut skipped = 0u64;
    let mut queue = std::collections::VecDeque::from([(root.to_path_buf(), Vec::<String>::new())]);
    while let Some((dir, rel)) = queue.pop_front() {
        if rel.len() >= MAX_TREE_DEPTH {
            return Err(SftpError::Invalid(format!(
                "フォルダーが深すぎます（{MAX_TREE_DEPTH}階層まで）"
            )));
        }
        let read = std::fs::read_dir(&dir).map_err(local(format!("{} の一覧", dir.display())))?;
        let mut entries: Vec<_> = read
            .collect::<Result<_, _>>()
            .map_err(local(format!("{} の一覧", dir.display())))?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            let kind = entry
                .file_type()
                .map_err(local(format!("{} の確認", entry.path().display())))?;
            if kind.is_symlink()
                || !(kind.is_dir() || kind.is_file())
                || validate_file_name(&name).is_err()
            {
                skipped += 1;
                continue;
            }
            let mut child = rel.clone();
            child.push(name);
            if kind.is_dir() {
                queue.push_back((entry.path(), child.clone()));
            }
            let size = if kind.is_file() {
                entry
                    .metadata()
                    .map_err(local(format!("{} の確認", entry.path().display())))?
                    .len()
            } else {
                0
            };
            items.push(TreeItem {
                rel: child,
                is_dir: kind.is_dir(),
                size,
            });
            if items.len() > MAX_TREE_ENTRIES {
                return Err(SftpError::Invalid(format!(
                    "ファイルが多すぎます（{MAX_TREE_ENTRIES}件まで）"
                )));
            }
        }
    }
    Ok((items, skipped))
}

/// 既存と重ならない名前で、フォルダーを作る（`名前`, `名前 (1)`, ...）。
fn create_unique_dir(parent: &Path, name: &str) -> Result<PathBuf, SftpError> {
    for n in 0..10_000u32 {
        let candidate = if n == 0 {
            name.to_owned()
        } else {
            format!("{name} ({n})")
        };
        let path = parent.join(&candidate);
        match std::fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(local(format!("{} の作成", path.display()))(e)),
        }
    }
    Err(SftpError::Invalid(
        "保存先のフォルダー名を決められませんでした".into(),
    ))
}

fn join_rel(base: &str, rel: &[String]) -> String {
    rel.iter()
        .fold(base.to_owned(), |acc, n| join_remote(&acc, n))
}

/// リモートのフォルダーを、`dest_dir` の中へ、中身ごとダウンロードする。
/// 同名のフォルダーがあれば `名前 (1)` のように別名にし、統合しない。途中で失敗・中止したら、作った分は消す。
pub async fn download_dir(
    fs: &dyn RemoteFs,
    remote_dir: &str,
    dest_dir: &Path,
    cancel: &CancelToken,
    on_progress: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<TreeSummary, SftpError> {
    let remote_dir = validate_remote_path(remote_dir)?;
    let name = remote_base_name(remote_dir)?;
    match fs.stat(remote_dir).await? {
        Some(s) if s.is_dir => {}
        Some(_) => {
            return Err(SftpError::Invalid(format!(
                "{remote_dir} はフォルダーではありません"
            )));
        }
        None => {
            return Err(SftpError::Invalid(format!("{remote_dir} が見つかりません")));
        }
    }
    let (items, skipped) = scan_remote(fs, remote_dir).await?;
    let total: u64 = items.iter().filter(|i| !i.is_dir).map(|i| i.size).sum();
    let top = create_unique_dir(dest_dir, name)?;
    let result = async {
        let mut done = 0u64;
        let mut files = 0u64;
        on_progress(0, total);
        for item in &items {
            if cancel.is_cancelled() {
                return Err(SftpError::Cancelled);
            }
            let local_path = item.rel.iter().fold(top.clone(), |p, n| p.join(n));
            if item.is_dir {
                std::fs::create_dir(&local_path)
                    .map_err(local(format!("{} の作成", local_path.display())))?;
                continue;
            }
            let remote_path = join_rel(remote_dir, &item.rel);
            let file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&local_path)
                .map_err(local(format!("{} の作成", local_path.display())))?;
            let mut reader = fs.open_read(&remote_path).await?;
            let mut writer = tokio::fs::File::from_std(file);
            let base = done;
            copy_with_progress(
                &mut reader,
                &mut writer,
                item.size,
                cancel,
                &mut |d, _| on_progress(base + d, total.max(base + d)),
                (
                    &Side::remote(format!("{remote_path} の読み込み")),
                    &Side::local(format!("{} の書き込み", local_path.display())),
                ),
            )
            .await
            .map(|n| {
                done += n;
                files += 1;
            })?;
        }
        Ok((files, done))
    }
    .await;
    match result {
        Ok((files, done)) => {
            on_progress(done, total.max(done));
            Ok(TreeSummary {
                path: top.display().to_string(),
                files,
                skipped,
            })
        }
        Err(e) => {
            // 作った分は残さない。
            let _ = std::fs::remove_dir_all(&top);
            Err(e)
        }
    }
}

/// ローカルのフォルダーを、リモートの `remote_parent` の中へ、中身ごとアップロードする。
/// 同名のリモートのフォルダーがあるときは、`overwrite` が `true` でなければ `Exists`
/// （`true` なら、中身を統合し、同名のファイルは上書きする）。失敗・中止したら、新しく作った分は消す。
pub async fn upload_dir(
    fs: &dyn RemoteFs,
    local_dir: &Path,
    remote_parent: &str,
    overwrite: bool,
    cancel: &CancelToken,
    on_progress: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<TreeSummary, SftpError> {
    let remote_parent = validate_remote_path(remote_parent)?;
    let meta =
        std::fs::metadata(local_dir).map_err(local(format!("{} の確認", local_dir.display())))?;
    if !meta.is_dir() {
        return Err(SftpError::Invalid("フォルダーを指定してください".into()));
    }
    let name = local_dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| SftpError::Invalid("フォルダー名を読み取れません".into()))?;
    let name = validate_file_name(name)?;
    let remote_root = join_remote(remote_parent, name);
    let (items, skipped) = scan_local(local_dir)?;
    let total: u64 = items.iter().filter(|i| !i.is_dir).map(|i| i.size).sum();

    let root_existed = match fs.stat(&remote_root).await? {
        Some(s) if !s.is_dir => {
            return Err(SftpError::Invalid(format!(
                "{remote_root} はファイルのため、フォルダーを作れません"
            )));
        }
        Some(_) if !overwrite => return Err(SftpError::Exists(remote_root)),
        Some(_) => true,
        None => false,
    };

    // 新しく作ったもの（失敗したときに消す）。
    let mut created_files: Vec<String> = Vec::new();
    let mut created_dirs: Vec<String> = Vec::new();
    let result = async {
        if !root_existed {
            fs.mkdir(&remote_root).await?;
            created_dirs.push(remote_root.clone());
        }
        let mut done = 0u64;
        let mut files = 0u64;
        on_progress(0, total);
        for item in &items {
            if cancel.is_cancelled() {
                return Err(SftpError::Cancelled);
            }
            let remote_path = join_rel(&remote_root, &item.rel);
            if item.is_dir {
                if fs.stat(&remote_path).await?.is_none() {
                    fs.mkdir(&remote_path).await?;
                    created_dirs.push(remote_path);
                }
                continue;
            }
            let local_path = item
                .rel
                .iter()
                .fold(local_dir.to_path_buf(), |p, n| p.join(n));
            match fs.stat(&remote_path).await? {
                Some(s) if s.is_dir => {
                    return Err(SftpError::Invalid(format!(
                        "{remote_path} はフォルダーのため上書きできません"
                    )));
                }
                Some(_) => {}
                None => created_files.push(remote_path.clone()),
            }
            let mut reader = tokio::fs::File::open(&local_path)
                .await
                .map_err(local(format!("{} の読み込み", local_path.display())))?;
            let mut writer = fs.open_write(&remote_path).await?;
            let base = done;
            let n = copy_with_progress(
                &mut reader,
                &mut writer,
                item.size,
                cancel,
                &mut |d, _| on_progress(base + d, total.max(base + d)),
                (
                    &Side::local(format!("{} の読み込み", local_path.display())),
                    &Side::remote(format!("{remote_path} の書き込み")),
                ),
            )
            .await?;
            drop(writer);
            done += n;
            files += 1;
        }
        Ok((files, done))
    }
    .await;
    match result {
        Ok((files, done)) => {
            on_progress(done, total.max(done));
            Ok(TreeSummary {
                path: remote_root,
                files,
                skipped,
            })
        }
        Err(e) => {
            // 新しく作った分だけを消す（もとからあったファイルは触らない）。できなくても、元のエラーを返す。
            for f in created_files.iter().rev() {
                let _ = fs.remove_file(f).await;
            }
            for d in created_dirs.iter().rev() {
                let _ = fs.remove_dir(d).await;
            }
            Err(e)
        }
    }
}

/// フォルダーを作る。
pub async fn make_dir(fs: &dyn RemoteFs, dir: &str, name: &str) -> Result<String, SftpError> {
    let dir = validate_remote_path(dir)?;
    let path = join_remote(dir, validate_file_name(name)?);
    if fs.stat(&path).await?.is_some() {
        return Err(SftpError::Exists(path));
    }
    fs.mkdir(&path).await?;
    Ok(path)
}

/// ファイルまたは空のフォルダーを削除する。
pub async fn remove(fs: &dyn RemoteFs, path: &str, is_dir: bool) -> Result<(), SftpError> {
    let path = validate_remote_path(path)?;
    if path.trim_end_matches('/').is_empty() {
        return Err(SftpError::Invalid("ルートは削除できません".into()));
    }
    if is_dir {
        fs.remove_dir(path).await
    } else {
        fs.remove_file(path).await
    }
}

/// ダウンロード先のフォルダー（ホームの「Downloads」）。
pub fn default_download_dir(home: Option<PathBuf>) -> Result<PathBuf, SftpError> {
    let home = home.ok_or_else(|| SftpError::Invalid("ホームフォルダーが分かりません".into()))?;
    let dir = home.join("Downloads");
    if !dir.is_dir() {
        std::fs::create_dir_all(&dir).map_err(local(format!("{} の作成", dir.display())))?;
    }
    Ok(dir)
}

mod adapter {
    use russh_sftp::client::SftpSession;
    use russh_sftp::protocol::OpenFlags;

    use super::*;

    /// `russh-sftp` のセッションを `RemoteFs` として使う。
    pub struct SftpFs(pub SftpSession);

    fn remote(context: &str, e: impl std::fmt::Display) -> SftpError {
        SftpError::Remote {
            context: context.to_owned(),
            message: e.to_string(),
        }
    }

    #[async_trait]
    impl RemoteFs for SftpFs {
        async fn canonicalize(&self, path: &str) -> Result<String, SftpError> {
            self.0
                .canonicalize(path)
                .await
                .map_err(|e| remote(&format!("{path} の解決"), e))
        }

        async fn list(&self, path: &str) -> Result<Vec<RemoteEntry>, SftpError> {
            let dir = self
                .0
                .read_dir(path)
                .await
                .map_err(|e| remote(&format!("{path} の一覧"), e))?;
            Ok(dir
                .map(|e| {
                    let meta = e.metadata();
                    let kind = e.file_type();
                    RemoteEntry {
                        name: e.file_name(),
                        is_dir: kind.is_dir(),
                        is_symlink: kind.is_symlink(),
                        size: meta.size.unwrap_or(0),
                        modified: meta.mtime.map(u64::from),
                        permissions: meta.permissions.map(|p| p & 0o777),
                    }
                })
                .collect())
        }

        async fn stat(&self, path: &str) -> Result<Option<RemoteStat>, SftpError> {
            // リンクの先を見る（リンク先のフォルダーをフォルダーとして扱うため）。
            match self.0.metadata(path).await {
                Ok(meta) => Ok(Some(RemoteStat {
                    is_dir: meta.file_type().is_dir(),
                    size: meta.size.unwrap_or(0),
                })),
                Err(russh_sftp::client::error::Error::Status(s))
                    if s.status_code == russh_sftp::protocol::StatusCode::NoSuchFile =>
                {
                    Ok(None)
                }
                Err(e) => Err(remote(&format!("{path} の確認"), e)),
            }
        }

        async fn open_read(&self, path: &str) -> Result<RemoteReader, SftpError> {
            let file = self
                .0
                .open(path)
                .await
                .map_err(|e| remote(&format!("{path} を開く"), e))?;
            Ok(Box::new(file))
        }

        async fn open_write(&self, path: &str) -> Result<RemoteWriter, SftpError> {
            let file = self
                .0
                .open_with_flags(
                    path,
                    OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
                )
                .await
                .map_err(|e| remote(&format!("{path} を作成"), e))?;
            Ok(Box::new(file))
        }

        async fn mkdir(&self, path: &str) -> Result<(), SftpError> {
            self.0
                .create_dir(path)
                .await
                .map_err(|e| remote(&format!("{path} の作成"), e))
        }

        async fn remove_file(&self, path: &str) -> Result<(), SftpError> {
            self.0
                .remove_file(path)
                .await
                .map_err(|e| remote(&format!("{path} の削除"), e))
        }

        async fn remove_dir(&self, path: &str) -> Result<(), SftpError> {
            self.0
                .remove_dir(path)
                .await
                .map_err(|e| remote(&format!("{path} の削除"), e))
        }
    }
}

pub use adapter::SftpFs;

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};
    use std::io::Cursor;
    use std::pin::Pin;
    use std::sync::Mutex;
    use std::task::{Context, Poll};

    use super::*;

    /// メモリ上のリモートファイルシステム。
    #[derive(Default)]
    struct MemFs {
        files: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
        dirs: Arc<Mutex<BTreeSet<String>>>,
        /// この文字数を書いたところで書き込みを失敗させる。
        fail_write_after: Option<usize>,
        /// 一覧にシンボリックリンクとして出すパス。
        symlinks: Vec<String>,
        /// 一覧に（実体のない）ファイルとして出すパス。不正な名前の試験用。
        extra_names: Vec<String>,
    }

    impl MemFs {
        fn with_file(self, path: &str, data: &[u8]) -> Self {
            self.files
                .lock()
                .unwrap()
                .insert(path.to_owned(), data.to_vec());
            self
        }
        fn with_dir(self, path: &str) -> Self {
            self.dirs.lock().unwrap().insert(path.to_owned());
            self
        }
        fn file(&self, path: &str) -> Option<Vec<u8>> {
            self.files.lock().unwrap().get(path).cloned()
        }
    }

    struct MemWriter {
        files: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
        path: String,
        written: usize,
        fail_after: Option<usize>,
    }

    impl AsyncWrite for MemWriter {
        fn poll_write(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            if let Some(limit) = self.fail_after
                && self.written >= limit
            {
                return Poll::Ready(Err(std::io::Error::other("disk full")));
            }
            let path = self.path.clone();
            self.files
                .lock()
                .unwrap()
                .get_mut(&path)
                .unwrap()
                .extend_from_slice(buf);
            self.written += buf.len();
            Poll::Ready(Ok(buf.len()))
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    fn entry(name: &str, is_dir: bool, size: u64) -> RemoteEntry {
        RemoteEntry {
            name: name.into(),
            is_dir,
            is_symlink: false,
            size,
            modified: None,
            permissions: None,
        }
    }

    #[async_trait]
    impl RemoteFs for MemFs {
        async fn canonicalize(&self, path: &str) -> Result<String, SftpError> {
            Ok(if path == "." {
                "/home/u".into()
            } else {
                path.into()
            })
        }
        async fn list(&self, path: &str) -> Result<Vec<RemoteEntry>, SftpError> {
            let prefix = join_remote(path, "");
            let mut out = vec![entry(".", true, 0)];
            for (p, data) in self.files.lock().unwrap().iter() {
                if let Some(rest) = p.strip_prefix(&prefix)
                    && !rest.contains('/')
                {
                    out.push(entry(rest, false, data.len() as u64));
                }
            }
            for d in self.dirs.lock().unwrap().iter() {
                if let Some(rest) = d.strip_prefix(&prefix)
                    && !rest.contains('/')
                {
                    out.push(entry(rest, true, 0));
                }
            }
            for l in &self.symlinks {
                if let Some(rest) = l.strip_prefix(&prefix)
                    && !rest.contains('/')
                {
                    let mut e = entry(rest, false, 0);
                    e.is_symlink = true;
                    out.push(e);
                }
            }
            for x in &self.extra_names {
                if let Some(rest) = x.strip_prefix(&prefix) {
                    out.push(entry(rest, false, 0));
                }
            }
            Ok(out)
        }
        async fn stat(&self, path: &str) -> Result<Option<RemoteStat>, SftpError> {
            if let Some(d) = self.files.lock().unwrap().get(path) {
                return Ok(Some(RemoteStat {
                    is_dir: false,
                    size: d.len() as u64,
                }));
            }
            if self.dirs.lock().unwrap().contains(path) {
                return Ok(Some(RemoteStat {
                    is_dir: true,
                    size: 0,
                }));
            }
            Ok(None)
        }
        async fn open_read(&self, path: &str) -> Result<RemoteReader, SftpError> {
            let data = self.file(path).ok_or_else(|| SftpError::Remote {
                context: path.into(),
                message: "no such file".into(),
            })?;
            Ok(Box::new(Cursor::new(data)))
        }
        async fn open_write(&self, path: &str) -> Result<RemoteWriter, SftpError> {
            self.files
                .lock()
                .unwrap()
                .insert(path.to_owned(), Vec::new());
            Ok(Box::new(MemWriter {
                files: self.files.clone(),
                path: path.to_owned(),
                written: 0,
                fail_after: self.fail_write_after,
            }))
        }
        async fn mkdir(&self, path: &str) -> Result<(), SftpError> {
            self.dirs.lock().unwrap().insert(path.to_owned());
            Ok(())
        }
        async fn remove_file(&self, path: &str) -> Result<(), SftpError> {
            self.files.lock().unwrap().remove(path);
            Ok(())
        }
        async fn remove_dir(&self, path: &str) -> Result<(), SftpError> {
            self.dirs.lock().unwrap().remove(path);
            Ok(())
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("linkterm-sftp-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn noop() -> impl FnMut(u64, u64) + Send {
        |_, _| {}
    }

    #[test]
    fn paths_and_names_are_validated() {
        assert!(validate_remote_path("/a/b").is_ok());
        assert!(validate_remote_path("").is_err());
        assert!(validate_remote_path("a\0b").is_err());
        for bad in ["", ".", "..", "a/b", "a\\b", "a\0"] {
            assert!(validate_file_name(bad).is_err(), "{bad:?}");
        }
        assert!(validate_file_name("日本語.txt").is_ok());
        assert_eq!(join_remote("/", "a"), "/a");
        assert_eq!(join_remote("/x", "a"), "/x/a");
        assert_eq!(join_remote("/x/", "a"), "/x/a");
        assert_eq!(remote_base_name("/x/y.txt").unwrap(), "y.txt");
        assert!(remote_base_name("/x/..").is_err());
        assert!(remote_base_name("/").is_err());
    }

    #[tokio::test]
    async fn list_sorts_dirs_first_then_by_name_and_hides_dot_entries() {
        let fs = MemFs::default()
            .with_file("/h/b.txt", b"1")
            .with_file("/h/A.txt", b"2")
            .with_dir("/h/zdir")
            .with_dir("/h/adir");
        let names: Vec<_> = list_dir(&fs, "/h")
            .await
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, ["adir", "zdir", "A.txt", "b.txt"]);
        assert!(list_dir(&fs, "").await.is_err());
    }

    #[tokio::test]
    async fn download_saves_the_file_and_reports_progress() {
        let data: Vec<u8> = (0..(CHUNK * 2 + 10)).map(|i| (i % 251) as u8).collect();
        let fs = MemFs::default().with_file("/h/data.bin", &data);
        let dir = temp_dir("dl");
        let mut progress = Vec::new();
        let path = download(
            &fs,
            "/h/data.bin",
            &dir,
            &CancelToken::default(),
            &mut |d, t| progress.push((d, t)),
        )
        .await
        .unwrap();
        assert_eq!(path, dir.join("data.bin"));
        assert_eq!(std::fs::read(&path).unwrap(), data);
        assert_eq!(progress.first(), Some(&(0, data.len() as u64)));
        assert_eq!(
            progress.last(),
            Some(&(data.len() as u64, data.len() as u64))
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn download_never_overwrites_an_existing_file() {
        let fs = MemFs::default().with_file("/h/a.txt", b"new");
        let dir = temp_dir("dl-unique");
        std::fs::write(dir.join("a.txt"), b"old").unwrap();
        std::fs::write(dir.join("a (1).txt"), b"old1").unwrap();
        let path = download(&fs, "/h/a.txt", &dir, &CancelToken::default(), &mut noop())
            .await
            .unwrap();
        assert_eq!(path, dir.join("a (2).txt"));
        assert_eq!(std::fs::read(dir.join("a.txt")).unwrap(), b"old");
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn download_rejects_directories_missing_files_and_bad_names() {
        let fs = MemFs::default().with_dir("/h/d");
        let dir = temp_dir("dl-bad");
        let c = CancelToken::default();
        for path in ["/h/d", "/h/none", "/h/.."] {
            assert!(
                matches!(
                    download(&fs, path, &dir, &c, &mut noop()).await,
                    Err(SftpError::Invalid(_))
                ),
                "{path}"
            );
        }
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn cancelled_download_leaves_no_partial_file() {
        let fs = MemFs::default().with_file("/h/big", &vec![1u8; CHUNK * 3]);
        let dir = temp_dir("dl-cancel");
        let cancel = CancelToken::default();
        let token = cancel.clone();
        let r = download(&fs, "/h/big", &dir, &cancel, &mut |done, _| {
            if done >= CHUNK as u64 {
                token.cancel();
            }
        })
        .await;
        assert!(matches!(r, Err(SftpError::Cancelled)));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn upload_writes_the_file_into_the_remote_dir() {
        let dir = temp_dir("ul");
        let local = dir.join("up.txt");
        std::fs::write(&local, b"hello").unwrap();
        let fs = MemFs::default().with_dir("/h");
        let mut last = (0, 0);
        let remote = upload(
            &fs,
            &local,
            "/h",
            false,
            &CancelToken::default(),
            &mut |d, t| last = (d, t),
        )
        .await
        .unwrap();
        assert_eq!(remote, "/h/up.txt");
        assert_eq!(fs.file("/h/up.txt").unwrap(), b"hello");
        assert_eq!(last, (5, 5));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn upload_refuses_to_overwrite_unless_asked() {
        let dir = temp_dir("ul-exists");
        let local = dir.join("up.txt");
        std::fs::write(&local, b"new").unwrap();
        let fs = MemFs::default()
            .with_dir("/h")
            .with_file("/h/up.txt", b"old");
        let c = CancelToken::default();
        assert!(matches!(
            upload(&fs, &local, "/h", false, &c, &mut noop()).await,
            Err(SftpError::Exists(p)) if p == "/h/up.txt"
        ));
        assert_eq!(fs.file("/h/up.txt").unwrap(), b"old");
        upload(&fs, &local, "/h", true, &c, &mut noop())
            .await
            .unwrap();
        assert_eq!(fs.file("/h/up.txt").unwrap(), b"new");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn upload_rejects_directories_missing_files_and_remote_dir_collisions() {
        let dir = temp_dir("ul-bad");
        let fs = MemFs::default().with_dir("/h").with_dir("/h/sub");
        let c = CancelToken::default();
        assert!(matches!(
            upload(&fs, &dir, "/h", false, &c, &mut noop()).await,
            Err(SftpError::Invalid(_))
        ));
        assert!(matches!(
            upload(&fs, &dir.join("none"), "/h", false, &c, &mut noop()).await,
            Err(SftpError::Local { .. })
        ));
        let clash = dir.join("sub");
        std::fs::write(&clash, b"x").unwrap();
        assert!(matches!(
            upload(&fs, &clash, "/h", true, &c, &mut noop()).await,
            Err(SftpError::Invalid(_))
        ));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn failed_or_cancelled_upload_removes_the_partial_remote_file() {
        let dir = temp_dir("ul-fail");
        let local = dir.join("big.bin");
        std::fs::write(&local, vec![7u8; CHUNK * 3]).unwrap();
        let failing = MemFs {
            fail_write_after: Some(CHUNK),
            ..MemFs::default()
        }
        .with_dir("/h");
        let r = upload(
            &failing,
            &local,
            "/h",
            false,
            &CancelToken::default(),
            &mut noop(),
        )
        .await;
        assert!(matches!(r, Err(SftpError::Remote { .. })));
        assert!(failing.file("/h/big.bin").is_none());

        let fs = MemFs::default().with_dir("/h");
        let cancel = CancelToken::default();
        let token = cancel.clone();
        let r = upload(&fs, &local, "/h", false, &cancel, &mut |d, _| {
            if d >= CHUNK as u64 {
                token.cancel();
            }
        })
        .await;
        assert!(matches!(r, Err(SftpError::Cancelled)));
        assert!(fs.file("/h/big.bin").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn make_dir_and_remove() {
        let fs = MemFs::default().with_dir("/h").with_file("/h/a", b"1");
        assert_eq!(make_dir(&fs, "/h", "new").await.unwrap(), "/h/new");
        assert!(matches!(
            make_dir(&fs, "/h", "new").await,
            Err(SftpError::Exists(_))
        ));
        assert!(make_dir(&fs, "/h", "a/b").await.is_err());
        remove(&fs, "/h/a", false).await.unwrap();
        assert!(fs.file("/h/a").is_none());
        remove(&fs, "/h/new", true).await.unwrap();
        assert!(remove(&fs, "/", true).await.is_err());
        assert!(remove(&fs, "///", true).await.is_err());
    }

    #[test]
    fn default_download_dir_is_home_downloads() {
        let home = temp_dir("home");
        let dir = default_download_dir(Some(home.clone())).unwrap();
        assert_eq!(dir, home.join("Downloads"));
        assert!(dir.is_dir());
        assert!(default_download_dir(None).is_err());
        let _ = std::fs::remove_dir_all(home);
    }

    /// リモートに `/h/proj` を作る: /h/proj/a.txt, /h/proj/sub/b.txt, /h/proj/sub/deep/c.txt, 空の /h/proj/empty。
    fn remote_tree() -> MemFs {
        MemFs::default()
            .with_dir("/h")
            .with_dir("/h/proj")
            .with_dir("/h/proj/sub")
            .with_dir("/h/proj/sub/deep")
            .with_dir("/h/proj/empty")
            .with_file("/h/proj/a.txt", b"AAA")
            .with_file("/h/proj/sub/b.txt", b"BBBB")
            .with_file("/h/proj/sub/deep/c.txt", b"C")
    }

    #[tokio::test]
    async fn download_dir_recreates_the_tree_and_reports_total_progress() {
        let fs = remote_tree();
        let dest = temp_dir("dd");
        let mut last = (0, 0);
        let summary = download_dir(
            &fs,
            "/h/proj",
            &dest,
            &CancelToken::default(),
            &mut |d, t| last = (d, t),
        )
        .await
        .unwrap();
        assert_eq!(summary.path, dest.join("proj"));
        assert_eq!(summary.files, 3);
        assert_eq!(std::fs::read(dest.join("proj/a.txt")).unwrap(), b"AAA");
        assert_eq!(std::fs::read(dest.join("proj/sub/b.txt")).unwrap(), b"BBBB");
        assert_eq!(
            std::fs::read(dest.join("proj/sub/deep/c.txt")).unwrap(),
            b"C"
        );
        assert!(dest.join("proj/empty").is_dir());
        assert_eq!(last, (8, 8));
        let _ = std::fs::remove_dir_all(dest);
    }

    #[tokio::test]
    async fn download_dir_never_merges_into_an_existing_folder() {
        let fs = remote_tree();
        let dest = temp_dir("dd-unique");
        std::fs::create_dir_all(dest.join("proj")).unwrap();
        std::fs::write(dest.join("proj/keep.txt"), b"mine").unwrap();
        let summary = download_dir(&fs, "/h/proj", &dest, &CancelToken::default(), &mut noop())
            .await
            .unwrap();
        assert_eq!(summary.path, dest.join("proj (1)"));
        assert_eq!(std::fs::read(dest.join("proj/keep.txt")).unwrap(), b"mine");
        assert!(dest.join("proj (1)/a.txt").is_file());
        let _ = std::fs::remove_dir_all(dest);
    }

    #[tokio::test]
    async fn download_dir_skips_symlinks_and_bad_names_and_counts_them() {
        let mut fs = remote_tree();
        fs.symlinks.push("/h/proj/link".into());
        fs.extra_names.push("/h/proj/bad\\name".into());
        let dest = temp_dir("dd-skip");
        let summary = download_dir(&fs, "/h/proj", &dest, &CancelToken::default(), &mut noop())
            .await
            .unwrap();
        assert_eq!(summary.skipped, 2);
        assert!(!dest.join("proj/link").exists());
        assert_eq!(summary.files, 3);
        let _ = std::fs::remove_dir_all(dest);
    }

    #[tokio::test]
    async fn download_dir_rejects_files_missing_paths_and_too_many_entries() {
        let fs = remote_tree();
        let dest = temp_dir("dd-bad");
        let c = CancelToken::default();
        for path in ["/h/proj/a.txt", "/h/none", ""] {
            assert!(
                matches!(
                    download_dir(&fs, path, &dest, &c, &mut noop()).await,
                    Err(SftpError::Invalid(_))
                ),
                "{path}"
            );
        }
        let mut big = MemFs::default().with_dir("/h").with_dir("/h/big");
        for i in 0..=MAX_TREE_ENTRIES {
            big = big.with_file(&format!("/h/big/f{i}"), b"");
        }
        assert!(matches!(
            download_dir(&big, "/h/big", &dest, &c, &mut noop()).await,
            Err(SftpError::Invalid(_))
        ));
        assert_eq!(std::fs::read_dir(&dest).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(dest);
    }

    #[tokio::test]
    async fn cancelled_download_dir_removes_what_it_created() {
        let fs = remote_tree();
        let dest = temp_dir("dd-cancel");
        let cancel = CancelToken::default();
        let token = cancel.clone();
        let r = download_dir(&fs, "/h/proj", &dest, &cancel, &mut |d, _| {
            if d >= 3 {
                token.cancel();
            }
        })
        .await;
        assert!(matches!(r, Err(SftpError::Cancelled)));
        assert_eq!(std::fs::read_dir(&dest).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(dest);
    }

    fn local_tree(name: &str) -> PathBuf {
        let root = temp_dir(name);
        let proj = root.join("proj");
        std::fs::create_dir_all(proj.join("sub/deep")).unwrap();
        std::fs::create_dir_all(proj.join("empty")).unwrap();
        std::fs::write(proj.join("a.txt"), b"AAA").unwrap();
        std::fs::write(proj.join("sub/b.txt"), b"BBBB").unwrap();
        std::fs::write(proj.join("sub/deep/c.txt"), b"C").unwrap();
        root
    }

    #[tokio::test]
    async fn upload_dir_recreates_the_tree_on_the_remote() {
        let root = local_tree("ud");
        let fs = MemFs::default().with_dir("/h");
        let mut last = (0, 0);
        let summary = upload_dir(
            &fs,
            &root.join("proj"),
            "/h",
            false,
            &CancelToken::default(),
            &mut |d, t| last = (d, t),
        )
        .await
        .unwrap();
        assert_eq!(summary.path, "/h/proj");
        assert_eq!(summary.files, 3);
        assert_eq!(fs.file("/h/proj/a.txt").unwrap(), b"AAA");
        assert_eq!(fs.file("/h/proj/sub/b.txt").unwrap(), b"BBBB");
        assert_eq!(fs.file("/h/proj/sub/deep/c.txt").unwrap(), b"C");
        assert!(fs.dirs.lock().unwrap().contains("/h/proj/empty"));
        assert_eq!(last, (8, 8));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn upload_dir_asks_before_merging_into_an_existing_remote_folder() {
        let root = local_tree("ud-exists");
        let fs = MemFs::default()
            .with_dir("/h")
            .with_dir("/h/proj")
            .with_file("/h/proj/a.txt", b"old")
            .with_file("/h/proj/other.txt", b"keep");
        let c = CancelToken::default();
        assert!(matches!(
            upload_dir(&fs, &root.join("proj"), "/h", false, &c, &mut noop()).await,
            Err(SftpError::Exists(p)) if p == "/h/proj"
        ));
        assert_eq!(fs.file("/h/proj/a.txt").unwrap(), b"old");
        upload_dir(&fs, &root.join("proj"), "/h", true, &c, &mut noop())
            .await
            .unwrap();
        assert_eq!(fs.file("/h/proj/a.txt").unwrap(), b"AAA");
        assert_eq!(fs.file("/h/proj/other.txt").unwrap(), b"keep");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn upload_dir_rejects_a_remote_file_with_the_same_name_and_non_directories() {
        let root = local_tree("ud-bad");
        let fs = MemFs::default().with_dir("/h").with_file("/h/proj", b"x");
        let c = CancelToken::default();
        assert!(matches!(
            upload_dir(&fs, &root.join("proj"), "/h", true, &c, &mut noop()).await,
            Err(SftpError::Invalid(_))
        ));
        assert!(matches!(
            upload_dir(&fs, &root.join("proj/a.txt"), "/h", true, &c, &mut noop()).await,
            Err(SftpError::Invalid(_))
        ));
        assert!(matches!(
            upload_dir(&fs, &root.join("none"), "/h", true, &c, &mut noop()).await,
            Err(SftpError::Local { .. })
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn upload_dir_skips_symlinks() {
        let root = local_tree("ud-link");
        std::os::unix::fs::symlink("/etc/hosts", root.join("proj/link")).unwrap();
        std::os::unix::fs::symlink(&root, root.join("proj/loop")).unwrap();
        let fs = MemFs::default().with_dir("/h");
        let summary = upload_dir(
            &fs,
            &root.join("proj"),
            "/h",
            false,
            &CancelToken::default(),
            &mut noop(),
        )
        .await
        .unwrap();
        assert_eq!(summary.skipped, 2);
        assert!(fs.file("/h/proj/link").is_none());
        assert_eq!(summary.files, 3);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn cancelled_or_failed_upload_dir_removes_what_it_created_but_keeps_existing_files() {
        let root = local_tree("ud-cancel");
        let fs = MemFs::default().with_dir("/h");
        let cancel = CancelToken::default();
        let token = cancel.clone();
        let r = upload_dir(
            &fs,
            &root.join("proj"),
            "/h",
            false,
            &cancel,
            &mut |d, _| {
                if d >= 3 {
                    token.cancel();
                }
            },
        )
        .await;
        assert!(matches!(r, Err(SftpError::Cancelled)));
        assert!(fs.files.lock().unwrap().is_empty());
        assert!(!fs.dirs.lock().unwrap().contains("/h/proj"));

        // 既存のフォルダーへ統合して失敗した場合、もとからあったファイルは消さない。
        let existing = MemFs::default()
            .with_dir("/h")
            .with_dir("/h/proj")
            .with_file("/h/proj/other.txt", b"keep");
        let cancel = CancelToken::default();
        let token = cancel.clone();
        let r = upload_dir(
            &existing,
            &root.join("proj"),
            "/h",
            true,
            &cancel,
            &mut |d, _| {
                if d >= 3 {
                    token.cancel();
                }
            },
        )
        .await;
        assert!(matches!(r, Err(SftpError::Cancelled)));
        assert_eq!(existing.file("/h/proj/other.txt").unwrap(), b"keep");
        assert!(existing.dirs.lock().unwrap().contains("/h/proj"));
        let _ = std::fs::remove_dir_all(root);
    }
}

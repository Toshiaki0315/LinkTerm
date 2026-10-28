//! `SftpFs`（russh-sftp のクライアント）を、本物の SFTP プロトコルで試す。
//!
//! 相手は `russh-sftp` のサーバー（一時フォルダーを根にする）。SSH の部分は
//! `session::ssh::tests` が実サーバーで試しているので、ここではメモリ上の
//! ストリームでつなぎ、プロトコルの往復と転送ロジックの結合を確かめる。

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{
    Data, File, FileAttributes, FileMode, Handle, Name, OpenFlags, Status, StatusCode, Version,
};

use crate::sftp::{
    CancelToken, RemoteFs, SftpError, SftpFs, download, download_dir, list_dir, make_dir, remove,
    upload, upload_dir,
};

/// 一時フォルダーを `/` として見せる SFTP サーバー。
pub(crate) struct DirServer {
    root: PathBuf,
    next: u32,
    files: HashMap<String, PathBuf>,
    dirs: HashMap<String, (PathBuf, bool)>,
}

impl DirServer {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self {
            root,
            next: 0,
            files: HashMap::new(),
            dirs: HashMap::new(),
        }
    }

    /// `/a/b` を `<root>/a/b` にする（`..` で根の外へは出さない）。
    fn real(&self, path: &str) -> PathBuf {
        let mut out = self.root.clone();
        for part in path.split('/') {
            match part {
                "" | "." | ".." => {}
                p => out.push(p),
            }
        }
        out
    }

    fn handle(&mut self, prefix: &str) -> String {
        self.next += 1;
        format!("{prefix}{}", self.next)
    }
}

fn status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "Ok".into(),
        language_tag: "en-US".into(),
    }
}

fn code(e: std::io::Error) -> StatusCode {
    match e.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NoSuchFile,
        std::io::ErrorKind::PermissionDenied => StatusCode::PermissionDenied,
        _ => StatusCode::Failure,
    }
}

fn attrs_of(meta: &std::fs::Metadata) -> FileAttributes {
    let mut a = FileAttributes::from(meta);
    a.set_type(if meta.is_dir() {
        FileMode::DIR
    } else {
        FileMode::REG
    });
    a
}

impl russh_sftp::server::Handler for DirServer {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(&mut self, _: u32, _: HashMap<String, String>) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let shown = if path == "." || path.is_empty() {
            "/".to_owned()
        } else {
            path
        };
        Ok(Name {
            id,
            files: vec![File::dummy(shown)],
        })
    }

    async fn stat(
        &mut self,
        id: u32,
        path: String,
    ) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
        let meta = std::fs::metadata(self.real(&path)).map_err(code)?;
        Ok(russh_sftp::protocol::Attrs {
            id,
            attrs: attrs_of(&meta),
        })
    }

    async fn lstat(
        &mut self,
        id: u32,
        path: String,
    ) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
        self.stat(id, path).await
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let real = self.real(&path);
        if !real.is_dir() {
            return Err(StatusCode::NoSuchFile);
        }
        let handle = self.handle("d");
        self.dirs.insert(handle.clone(), (real, false));
        Ok(Handle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        let (path, done) = self.dirs.get_mut(&handle).ok_or(StatusCode::Failure)?;
        if *done {
            return Err(StatusCode::Eof);
        }
        *done = true;
        let mut files = Vec::new();
        for entry in std::fs::read_dir(&*path).map_err(code)? {
            let entry = entry.map_err(code)?;
            let meta = entry.metadata().map_err(code)?;
            files.push(File::new(
                entry.file_name().to_string_lossy().into_owned(),
                attrs_of(&meta),
            ));
        }
        Ok(Name { id, files })
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        _: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let real = self.real(&filename);
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        if pflags.contains(OpenFlags::WRITE) {
            options.write(true);
        }
        if pflags.contains(OpenFlags::CREATE) {
            options.create(true);
        }
        if pflags.contains(OpenFlags::TRUNCATE) {
            options.truncate(true);
        }
        options.open(&real).map_err(code)?;
        let handle = self.handle("f");
        self.files.insert(handle.clone(), real);
        Ok(Handle { id, handle })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.files.remove(&handle);
        self.dirs.remove(&handle);
        Ok(status(id))
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let path = self.files.get(&handle).ok_or(StatusCode::Failure)?;
        let mut file = std::fs::File::open(path).map_err(code)?;
        file.seek(SeekFrom::Start(offset)).map_err(code)?;
        let mut data = vec![0u8; len as usize];
        let n = file.read(&mut data).map_err(code)?;
        if n == 0 {
            return Err(StatusCode::Eof);
        }
        data.truncate(n);
        Ok(Data { id, data })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        let path = self.files.get(&handle).ok_or(StatusCode::Failure)?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .map_err(code)?;
        file.seek(SeekFrom::Start(offset)).map_err(code)?;
        file.write_all(&data).map_err(code)?;
        Ok(status(id))
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        std::fs::remove_file(self.real(&filename)).map_err(code)?;
        Ok(status(id))
    }

    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _: FileAttributes,
    ) -> Result<Status, Self::Error> {
        std::fs::create_dir(self.real(&path)).map_err(code)?;
        Ok(status(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        std::fs::remove_dir(self.real(&path)).map_err(code)?;
        Ok(status(id))
    }
}

struct Fixture {
    /// リモートの `/` に当たる場所。
    remote: tempdir::Dir,
    /// ローカルの作業場所。
    local: tempdir::Dir,
    fs: SftpFs,
}

/// 依存を増やさないための、最小の一時フォルダー。
mod tempdir {
    use std::path::{Path, PathBuf};

    pub struct Dir(PathBuf);

    impl Dir {
        pub fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "linkterm-sftp-e2e-{tag}-{}-{}",
                std::process::id(),
                rand::random::<u64>()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

async fn fixture() -> Fixture {
    let remote = tempdir::Dir::new("remote");
    let local = tempdir::Dir::new("local");
    let (client, server) = tokio::io::duplex(64 * 1024);
    russh_sftp::server::run(server, DirServer::new(remote.path().to_owned())).await;
    let session = SftpSession::new(client).await.expect("SFTP の初期化");
    Fixture {
        remote,
        local,
        fs: SftpFs(session),
    }
}

fn no_progress() -> impl FnMut(u64, u64) + Send {
    |_, _| {}
}

fn write_file(path: &Path, bytes: &[u8]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}

/// 偏りのない、決まった内容（途中の欠けや順序違いに気付けるように）。
fn pattern(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i * 31 % 251) as u8).collect()
}

#[tokio::test]
async fn canonicalize_resolves_the_home_path() {
    let f = fixture().await;
    assert_eq!(f.fs.canonicalize(".").await.unwrap(), "/");
}

#[tokio::test]
async fn lists_files_and_folders_with_sizes_and_kinds() {
    let f = fixture().await;
    write_file(&f.remote.path().join("a.txt"), b"hello");
    std::fs::create_dir(f.remote.path().join("sub")).unwrap();

    let entries = list_dir(&f.fs, "/").await.unwrap();
    let names: Vec<_> = entries
        .iter()
        .map(|e| (e.name.as_str(), e.is_dir))
        .collect();
    assert_eq!(names, [("sub", true), ("a.txt", false)], "フォルダーが先");
    let file = entries.iter().find(|e| e.name == "a.txt").unwrap();
    assert_eq!(file.size, 5);
}

#[tokio::test]
async fn listing_a_missing_folder_is_a_clear_remote_error() {
    let f = fixture().await;
    let err = list_dir(&f.fs, "/missing").await.unwrap_err();
    assert!(matches!(err, SftpError::Remote { .. }), "{err}");
    assert!(err.to_string().contains("/missing"), "{err}");
}

#[tokio::test]
async fn stat_distinguishes_missing_file_and_folder() {
    let f = fixture().await;
    write_file(&f.remote.path().join("a.txt"), b"abc");
    std::fs::create_dir(f.remote.path().join("d")).unwrap();

    assert!(f.fs.stat("/nope").await.unwrap().is_none());
    let file = f.fs.stat("/a.txt").await.unwrap().unwrap();
    assert!(!file.is_dir);
    assert_eq!(file.size, 3);
    assert!(f.fs.stat("/d").await.unwrap().unwrap().is_dir);
}

#[tokio::test]
async fn downloads_a_large_file_intact_and_reports_progress() {
    let f = fixture().await;
    let data = pattern(3 * 1024 * 1024 + 123);
    write_file(&f.remote.path().join("big.bin"), &data);

    let mut last = (0, 0);
    let saved = download(
        &f.fs,
        "/big.bin",
        f.local.path(),
        &CancelToken::default(),
        &mut |done, total| last = (done, total),
    )
    .await
    .unwrap();

    assert_eq!(std::fs::read(&saved).unwrap(), data);
    assert_eq!(last, (data.len() as u64, data.len() as u64));
}

#[tokio::test]
async fn download_never_overwrites_and_picks_a_numbered_name() {
    let f = fixture().await;
    write_file(&f.remote.path().join("note.txt"), b"remote");
    write_file(&f.local.path().join("note.txt"), b"mine");

    let saved = download(
        &f.fs,
        "/note.txt",
        f.local.path(),
        &CancelToken::default(),
        &mut no_progress(),
    )
    .await
    .unwrap();

    assert_eq!(saved.file_name().unwrap(), "note (1).txt");
    assert_eq!(
        std::fs::read(f.local.path().join("note.txt")).unwrap(),
        b"mine"
    );
    assert_eq!(std::fs::read(saved).unwrap(), b"remote");
}

#[tokio::test]
async fn cancelling_a_download_leaves_no_partial_file() {
    let f = fixture().await;
    write_file(&f.remote.path().join("big.bin"), &pattern(2 * 1024 * 1024));
    let cancel = CancelToken::default();
    let c = cancel.clone();

    let err = download(
        &f.fs,
        "/big.bin",
        f.local.path(),
        &cancel,
        &mut move |done, _| {
            if done > 0 {
                c.cancel();
            }
        },
    )
    .await
    .unwrap_err();

    assert!(matches!(err, SftpError::Cancelled), "{err}");
    assert_eq!(std::fs::read_dir(f.local.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn uploads_a_file_and_refuses_to_overwrite_without_consent() {
    let f = fixture().await;
    let src = f.local.path().join("up.bin");
    let data = pattern(1_500_000);
    write_file(&src, &data);

    let remote_path = upload(
        &f.fs,
        &src,
        "/",
        false,
        &CancelToken::default(),
        &mut no_progress(),
    )
    .await
    .unwrap();
    assert_eq!(remote_path, "/up.bin");
    assert_eq!(std::fs::read(f.remote.path().join("up.bin")).unwrap(), data);

    let err = upload(
        &f.fs,
        &src,
        "/",
        false,
        &CancelToken::default(),
        &mut no_progress(),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, SftpError::Exists(_)), "{err}");

    write_file(&src, b"new");
    upload(
        &f.fs,
        &src,
        "/",
        true,
        &CancelToken::default(),
        &mut no_progress(),
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read(f.remote.path().join("up.bin")).unwrap(),
        b"new"
    );
}

#[tokio::test]
async fn overwriting_with_a_shorter_file_truncates_the_old_content() {
    let f = fixture().await;
    write_file(&f.remote.path().join("t.txt"), b"0123456789");
    let src = f.local.path().join("t.txt");
    write_file(&src, b"ab");

    upload(
        &f.fs,
        &src,
        "/",
        true,
        &CancelToken::default(),
        &mut no_progress(),
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(f.remote.path().join("t.txt")).unwrap(), b"ab");
}

#[tokio::test]
async fn cancelling_an_upload_removes_the_partial_remote_file() {
    let f = fixture().await;
    let src = f.local.path().join("big.bin");
    write_file(&src, &pattern(4 * 1024 * 1024));
    let cancel = CancelToken::default();
    let c = cancel.clone();

    let err = upload(&f.fs, &src, "/", false, &cancel, &mut move |done, _| {
        if done > 0 {
            c.cancel();
        }
    })
    .await
    .unwrap_err();

    assert!(matches!(err, SftpError::Cancelled), "{err}");
    assert!(!f.remote.path().join("big.bin").exists());
}

#[tokio::test]
async fn downloads_a_folder_tree_with_nested_and_empty_folders() {
    let f = fixture().await;
    write_file(&f.remote.path().join("proj/a.txt"), b"A");
    write_file(
        &f.remote.path().join("proj/deep/er/b.bin"),
        &pattern(200_000),
    );
    std::fs::create_dir_all(f.remote.path().join("proj/empty")).unwrap();

    let summary = download_dir(
        &f.fs,
        "/proj",
        f.local.path(),
        &CancelToken::default(),
        &mut no_progress(),
    )
    .await
    .unwrap();

    let base = f.local.path().join("proj");
    assert_eq!(std::fs::read(base.join("a.txt")).unwrap(), b"A");
    assert_eq!(
        std::fs::read(base.join("deep/er/b.bin")).unwrap(),
        pattern(200_000)
    );
    assert!(base.join("empty").is_dir());
    assert_eq!(summary.files, 2);
}

#[tokio::test]
async fn folder_download_into_an_existing_name_does_not_merge() {
    let f = fixture().await;
    write_file(&f.remote.path().join("proj/a.txt"), b"remote");
    write_file(&f.local.path().join("proj/mine.txt"), b"mine");

    download_dir(
        &f.fs,
        "/proj",
        f.local.path(),
        &CancelToken::default(),
        &mut no_progress(),
    )
    .await
    .unwrap();

    assert!(f.local.path().join("proj/mine.txt").exists());
    assert!(!f.local.path().join("proj/a.txt").exists());
    assert_eq!(
        std::fs::read(f.local.path().join("proj (1)/a.txt")).unwrap(),
        b"remote"
    );
}

#[tokio::test]
async fn cancelling_a_folder_download_removes_what_was_created() {
    let f = fixture().await;
    for i in 0..5 {
        write_file(
            &f.remote.path().join(format!("proj/f{i}.bin")),
            &pattern(300_000),
        );
    }
    let cancel = CancelToken::default();
    let c = cancel.clone();

    let err = download_dir(
        &f.fs,
        "/proj",
        f.local.path(),
        &cancel,
        &mut move |done, _| {
            if done > 0 {
                c.cancel();
            }
        },
    )
    .await
    .unwrap_err();

    assert!(matches!(err, SftpError::Cancelled), "{err}");
    assert_eq!(std::fs::read_dir(f.local.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn uploads_a_folder_tree_then_asks_before_merging() {
    let f = fixture().await;
    write_file(&f.local.path().join("proj/a.txt"), b"A");
    write_file(&f.local.path().join("proj/x/y/b.bin"), &pattern(100_000));
    std::fs::create_dir_all(f.local.path().join("proj/empty")).unwrap();
    let dir = f.local.path().join("proj");

    let summary = upload_dir(
        &f.fs,
        &dir,
        "/",
        false,
        &CancelToken::default(),
        &mut no_progress(),
    )
    .await
    .unwrap();
    let remote = f.remote.path().join("proj");
    assert_eq!(std::fs::read(remote.join("a.txt")).unwrap(), b"A");
    assert_eq!(
        std::fs::read(remote.join("x/y/b.bin")).unwrap(),
        pattern(100_000)
    );
    assert!(remote.join("empty").is_dir());
    assert_eq!(summary.files, 2);

    // 同名のフォルダーがあれば、確認なしには統合しない。
    let err = upload_dir(
        &f.fs,
        &dir,
        "/",
        false,
        &CancelToken::default(),
        &mut no_progress(),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, SftpError::Exists(_)), "{err}");

    // 統合（上書き）では、相手にしかないファイルは残る。
    write_file(&remote.join("only-remote.txt"), b"keep");
    write_file(&dir.join("a.txt"), b"A2");
    upload_dir(
        &f.fs,
        &dir,
        "/",
        true,
        &CancelToken::default(),
        &mut no_progress(),
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(remote.join("a.txt")).unwrap(), b"A2");
    assert_eq!(
        std::fs::read(remote.join("only-remote.txt")).unwrap(),
        b"keep"
    );
}

#[tokio::test]
async fn cancelling_a_folder_upload_removes_the_new_remote_folder() {
    let f = fixture().await;
    for i in 0..5 {
        write_file(
            &f.local.path().join(format!("proj/f{i}.bin")),
            &pattern(300_000),
        );
    }
    let cancel = CancelToken::default();
    let c = cancel.clone();

    let err = upload_dir(
        &f.fs,
        &f.local.path().join("proj"),
        "/",
        false,
        &cancel,
        &mut move |done, _| {
            if done > 0 {
                c.cancel();
            }
        },
    )
    .await
    .unwrap_err();

    assert!(matches!(err, SftpError::Cancelled), "{err}");
    assert!(!f.remote.path().join("proj").exists());
}

#[tokio::test]
async fn makes_and_removes_folders_and_files() {
    let f = fixture().await;
    let made = make_dir(&f.fs, "/", "新しい").await.unwrap();
    assert_eq!(made, "/新しい");
    assert!(f.remote.path().join("新しい").is_dir());

    write_file(&f.remote.path().join("新しい/x.txt"), b"x");
    remove(&f.fs, "/新しい/x.txt", false).await.unwrap();
    assert!(!f.remote.path().join("新しい/x.txt").exists());
    remove(&f.fs, "/新しい", true).await.unwrap();
    assert!(!f.remote.path().join("新しい").exists());
}

#[tokio::test]
async fn removing_a_non_empty_folder_is_reported_not_swallowed() {
    let f = fixture().await;
    write_file(&f.remote.path().join("d/x.txt"), b"x");
    let err = remove(&f.fs, "/d", true).await.unwrap_err();
    assert!(matches!(err, SftpError::Remote { .. }), "{err}");
    assert!(f.remote.path().join("d/x.txt").exists(), "中身は消えない");
}

#[tokio::test]
async fn reading_a_missing_remote_file_is_an_error_naming_it() {
    let f = fixture().await;
    let err = download(
        &f.fs,
        "/ghost.txt",
        f.local.path(),
        &CancelToken::default(),
        &mut no_progress(),
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("ghost.txt"), "{err}");
    assert_eq!(std::fs::read_dir(f.local.path()).unwrap().count(), 0);
}

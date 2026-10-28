//! SFTP のコマンド（ファイル一覧・ダウンロード・アップロード・フォルダー作成・削除）。
//!
//! SFTP は、開いている SSH セッションの上に最初に使うときだけ開く。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::commands::{AppState, CommandError, CommandResult};
use crate::sftp::{
    CancelToken, RemoteEntry, RemoteFs, SftpError, SftpFs, TreeSummary, default_download_dir,
    download, download_dir, list_dir, make_dir, remove, upload, upload_dir, validate_remote_path,
};

pub const EVENT_PROGRESS: &str = "sftp-progress";
/// 進捗イベントの最小間隔。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// 開いている SFTP の接続と、実行中の転送。
#[derive(Default)]
pub struct SftpState {
    sessions: Mutex<HashMap<String, Arc<SftpFs>>>,
    transfers: StdMutex<HashMap<String, CancelToken>>,
}

impl SftpState {
    fn register(&self, transfer_id: &str) -> CancelToken {
        let token = CancelToken::default();
        self.transfers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(transfer_id.to_owned(), token.clone());
        token
    }

    fn finish(&self, transfer_id: &str) {
        self.transfers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(transfer_id);
    }

    /// 転送を中止する。見つからなければ `false`。
    pub fn cancel(&self, transfer_id: &str) -> bool {
        match self
            .transfers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(transfer_id)
        {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    pub async fn forget(&self, session_id: &str) {
        self.sessions.lock().await.remove(session_id);
    }

    async fn fs_for(&self, app: &AppState, session_id: &str) -> CommandResult<Arc<SftpFs>> {
        let mut sessions = self.sessions.lock().await;
        if let Some(fs) = sessions.get(session_id) {
            return Ok(fs.clone());
        }
        let transport = app.manager.open_sftp(session_id).await?;
        let session = SftpSession::new(transport).await.map_err(|e| {
            CommandError::Sftp(SftpError::Remote {
                context: "SFTP の開始".into(),
                message: e.to_string(),
            })
        })?;
        let fs = Arc::new(SftpFs(session));
        sessions.insert(session_id.to_owned(), fs.clone());
        Ok(fs)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// 解決後の絶対パス。
    pub path: String,
    pub entries: Vec<RemoteEntry>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    transfer_id: String,
    transferred: u64,
    total: u64,
}

/// 進捗を一定間隔で通知する（最後の通知は必ず出す）。
fn progress_emitter<'a>(
    app: &'a AppHandle,
    transfer_id: &'a str,
) -> impl FnMut(u64, u64) + Send + 'a {
    let mut last: Option<Instant> = None;
    move |transferred, total| {
        let finished = transferred >= total;
        if !finished && last.is_some_and(|t| t.elapsed() < PROGRESS_INTERVAL) {
            return;
        }
        last = Some(Instant::now());
        let payload = ProgressPayload {
            transfer_id: transfer_id.to_owned(),
            transferred,
            total,
        };
        if let Err(e) = app.emit(EVENT_PROGRESS, payload) {
            eprintln!("イベント送信に失敗しました ({EVENT_PROGRESS}): {e}");
        }
    }
}

/// 一覧を取る。`path` が空なら、ホームフォルダー。
#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    sftp: State<'_, SftpState>,
    session_id: String,
    path: Option<String>,
) -> CommandResult<Listing> {
    let fs = sftp.fs_for(&state, &session_id).await?;
    let result = async {
        let requested: &str = match path.as_deref() {
            None | Some("") => ".",
            Some(p) => {
                validate_remote_path(p)?;
                p
            }
        };
        let resolved = fs.canonicalize(requested).await?;
        let entries = list_dir(fs.as_ref(), &resolved).await?;
        Ok::<_, SftpError>(Listing {
            path: resolved,
            entries,
        })
    }
    .await;
    if result.is_err() {
        // 接続が切れていた場合に備え、次の操作で開き直す。
        sftp.forget(&session_id).await;
    }
    Ok(result?)
}

/// 転送の結果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    /// 同名のものがあり、上書き・統合しなかった（アップロードのみ）。
    pub exists: bool,
    /// 保存した先（または、既存だったもののパス）。
    pub path: String,
    /// フォルダーの転送か。
    pub is_dir: bool,
    /// フォルダー転送で転送したファイルの数（ファイルなら 1）。
    pub files: u64,
    /// フォルダー転送で、転送しなかったものの数。
    pub skipped: u64,
}

impl TransferResult {
    fn file(path: String) -> Self {
        Self {
            exists: false,
            path,
            is_dir: false,
            files: 1,
            skipped: 0,
        }
    }

    fn tree(s: TreeSummary) -> Self {
        Self {
            exists: false,
            path: s.path,
            is_dir: true,
            files: s.files,
            skipped: s.skipped,
        }
    }

    fn exists(path: String, is_dir: bool) -> Self {
        Self {
            exists: true,
            path,
            is_dir,
            files: 0,
            skipped: 0,
        }
    }
}

/// ダウンロードフォルダーへ保存する（ファイルでもフォルダーでも）。
#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp: State<'_, SftpState>,
    session_id: String,
    remote_path: String,
    transfer_id: String,
) -> CommandResult<TransferResult> {
    let fs = sftp.fs_for(&state, &session_id).await?;
    let dir = default_download_dir(std::env::var_os("HOME").map(PathBuf::from))?;
    let token = sftp.register(&transfer_id);
    let mut on_progress = progress_emitter(&app, &transfer_id);
    let result = async {
        let is_dir = fs
            .stat(validate_remote_path(&remote_path)?)
            .await?
            .is_some_and(|s| s.is_dir);
        if is_dir {
            download_dir(fs.as_ref(), &remote_path, &dir, &token, &mut on_progress)
                .await
                .map(TransferResult::tree)
        } else {
            download(fs.as_ref(), &remote_path, &dir, &token, &mut on_progress)
                .await
                .map(|p| TransferResult::file(p.display().to_string()))
        }
    }
    .await;
    sftp.finish(&transfer_id);
    Ok(result?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadRequest {
    session_id: String,
    local_path: String,
    remote_dir: String,
    /// 同名のファイルがあれば上書きする。
    overwrite: bool,
    transfer_id: String,
}

/// ローカルのファイル・フォルダーを、リモートのフォルダーへアップロードする。
#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp: State<'_, SftpState>,
    req: UploadRequest,
) -> CommandResult<TransferResult> {
    let fs = sftp.fs_for(&state, &req.session_id).await?;
    let token = sftp.register(&req.transfer_id);
    let mut on_progress = progress_emitter(&app, &req.transfer_id);
    let local = std::path::Path::new(&req.local_path);
    let is_dir = local.is_dir();
    let result = if is_dir {
        upload_dir(
            fs.as_ref(),
            local,
            &req.remote_dir,
            req.overwrite,
            &token,
            &mut on_progress,
        )
        .await
        .map(TransferResult::tree)
    } else {
        upload(
            fs.as_ref(),
            local,
            &req.remote_dir,
            req.overwrite,
            &token,
            &mut on_progress,
        )
        .await
        .map(TransferResult::file)
    };
    sftp.finish(&req.transfer_id);
    match result {
        Err(SftpError::Exists(path)) => Ok(TransferResult::exists(path, is_dir)),
        other => Ok(other?),
    }
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    sftp: State<'_, SftpState>,
    session_id: String,
    dir: String,
    name: String,
) -> CommandResult<String> {
    let fs = sftp.fs_for(&state, &session_id).await?;
    Ok(make_dir(fs.as_ref(), &dir, &name).await?)
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    sftp: State<'_, SftpState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> CommandResult<()> {
    let fs = sftp.fs_for(&state, &session_id).await?;
    Ok(remove(fs.as_ref(), &path, is_dir).await?)
}

/// 転送を中止する。
#[tauri::command]
pub fn sftp_cancel(sftp: State<'_, SftpState>, transfer_id: String) -> bool {
    sftp.cancel(&transfer_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_reaches_only_registered_transfers() {
        let s = SftpState::default();
        assert!(!s.cancel("t1"));
        let token = s.register("t1");
        assert!(!token.is_cancelled());
        assert!(s.cancel("t1"));
        assert!(token.is_cancelled());
        s.finish("t1");
        assert!(!s.cancel("t1"));
    }
}

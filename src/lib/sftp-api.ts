import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";

/** SFTP の一覧の1件（Rust の `RemoteEntry`）。 */
export interface RemoteEntry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  /** 更新時刻（UNIX 秒）。 */
  modified: number | null;
  permissions: number | null;
}

export interface SftpListing {
  /** 解決後の絶対パス。 */
  path: string;
  entries: RemoteEntry[];
}

/** 転送の結果（ファイル・フォルダー共通）。 */
export interface TransferResult {
  /** 同名のものがあり、上書き・統合しなかった（アップロードのみ）。 */
  exists: boolean;
  /** 保存した先（または、既存だったもののパス）。 */
  path: string;
  /** フォルダーの転送か。 */
  isDir: boolean;
  /** 転送したファイルの数。 */
  files: number;
  /** フォルダー転送で、転送しなかったもの（シンボリックリンクなど）の数。 */
  skipped: number;
}

export interface TransferProgress {
  transferId: string;
  transferred: number;
  total: number;
}

export const sftpList = (sessionId: string, path?: string) =>
  invoke<SftpListing>("sftp_list", { sessionId, path: path ?? null });

/** ダウンロードフォルダーへ保存する（ファイルでもフォルダーでも）。 */
export const sftpDownload = (
  sessionId: string,
  remotePath: string,
  transferId: string,
) =>
  invoke<TransferResult>("sftp_download", {
    sessionId,
    remotePath,
    transferId,
  });

export const sftpUpload = (req: {
  sessionId: string;
  localPath: string;
  remoteDir: string;
  overwrite: boolean;
  transferId: string;
}) => invoke<TransferResult>("sftp_upload", { req });

export const sftpMkdir = (sessionId: string, dir: string, name: string) =>
  invoke<string>("sftp_mkdir", { sessionId, dir, name });

export const sftpRemove = (sessionId: string, path: string, isDir: boolean) =>
  invoke<void>("sftp_remove", { sessionId, path, isDir });

export const sftpCancel = (transferId: string) =>
  invoke<boolean>("sftp_cancel", { transferId });

export const onSftpProgress = (
  cb: (progress: TransferProgress) => void,
): Promise<UnlistenFn> =>
  listen<TransferProgress>("sftp-progress", (e) => cb(e.payload));

/** ウィンドウへのファイルのドロップを購読する（ローカルのパスが届く）。 */
export const onFilesDropped = (
  cb: (paths: string[]) => void,
): Promise<UnlistenFn> =>
  getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "drop") cb(event.payload.paths);
  });

/** アップロードするファイルを選ぶ。キャンセルなら空。 */
export async function pickUploadFiles(): Promise<string[]> {
  const picked = await open({ multiple: true, directory: false });
  if (picked === null) return [];
  return Array.isArray(picked) ? picked : [picked];
}

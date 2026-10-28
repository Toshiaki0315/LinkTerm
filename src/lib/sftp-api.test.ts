import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const listen = vi.fn();
const onDragDropEvent = vi.fn();
const open = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...a: unknown[]) => listen(...a),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (...a: unknown[]) => onDragDropEvent(...a),
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => open(...a),
}));

import {
  onFilesDropped,
  onSftpProgress,
  pickUploadFiles,
  sftpCancel,
  sftpDownload,
  sftpList,
  sftpMkdir,
  sftpRemove,
  sftpUpload,
} from "./sftp-api";

beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockResolvedValue(undefined);
});

describe("sftp-api", () => {
  it("各操作は対応するコマンドを呼ぶ", async () => {
    await sftpList("s1");
    expect(invoke).toHaveBeenLastCalledWith("sftp_list", {
      sessionId: "s1",
      path: null,
    });
    await sftpList("s1", "/home");
    expect(invoke).toHaveBeenLastCalledWith("sftp_list", {
      sessionId: "s1",
      path: "/home",
    });
    await sftpDownload("s1", "/a", "t1");
    expect(invoke).toHaveBeenLastCalledWith("sftp_download", {
      sessionId: "s1",
      remotePath: "/a",
      transferId: "t1",
    });
    const req = {
      sessionId: "s1",
      localPath: "/l",
      remoteDir: "/r",
      overwrite: false,
      transferId: "t2",
    };
    await sftpUpload(req);
    expect(invoke).toHaveBeenLastCalledWith("sftp_upload", { req });
    await sftpMkdir("s1", "/r", "d");
    expect(invoke).toHaveBeenLastCalledWith("sftp_mkdir", {
      sessionId: "s1",
      dir: "/r",
      name: "d",
    });
    await sftpRemove("s1", "/r/d", true);
    expect(invoke).toHaveBeenLastCalledWith("sftp_remove", {
      sessionId: "s1",
      path: "/r/d",
      isDir: true,
    });
    await sftpCancel("t1");
    expect(invoke).toHaveBeenLastCalledWith("sftp_cancel", {
      transferId: "t1",
    });
  });

  it("進捗イベントを購読する", async () => {
    listen.mockImplementation(async (_n: string, cb: (e: unknown) => void) => {
      cb({ payload: { transferId: "t", transferred: 1, total: 2 } });
      return () => {};
    });
    const cb = vi.fn();
    await onSftpProgress(cb);
    expect(listen.mock.calls[0][0]).toBe("sftp-progress");
    expect(cb).toHaveBeenCalledWith({
      transferId: "t",
      transferred: 1,
      total: 2,
    });
  });

  it("ドロップされたときだけパスを通知する（ホバー等は無視）", async () => {
    onDragDropEvent.mockImplementation(
      async (cb: (e: { payload: unknown }) => void) => {
        cb({ payload: { type: "over", position: { x: 0, y: 0 } } });
        cb({ payload: { type: "drop", paths: ["/a", "/b"], position: {} } });
        return () => {};
      },
    );
    const cb = vi.fn();
    await onFilesDropped(cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(["/a", "/b"]);
  });

  it("ファイル選択: キャンセルは空、1件・複数件を配列にそろえる", async () => {
    open.mockResolvedValueOnce(null);
    await expect(pickUploadFiles()).resolves.toEqual([]);
    open.mockResolvedValueOnce("/one");
    await expect(pickUploadFiles()).resolves.toEqual(["/one"]);
    open.mockResolvedValueOnce(["/a", "/b"]);
    await expect(pickUploadFiles()).resolves.toEqual(["/a", "/b"]);
    expect(open).toHaveBeenCalledWith({ multiple: true, directory: false });
  });
});

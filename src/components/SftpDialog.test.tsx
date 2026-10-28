import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteEntry, TransferProgress } from "../lib/sftp-api";

const api = vi.hoisted(() => ({
  sftpList: vi.fn(),
  sftpDownload: vi.fn(),
  sftpUpload: vi.fn(),
  sftpMkdir: vi.fn(),
  sftpRemove: vi.fn(),
  sftpCancel: vi.fn(),
  onSftpProgress: vi.fn(),
  onFilesDropped: vi.fn(),
  pickUploadFiles: vi.fn(),
}));
vi.mock("../lib/sftp-api", () => api);

import { SftpDialog } from "./SftpDialog";

const entry = (over: Partial<RemoteEntry>): RemoteEntry => ({
  name: "f",
  isDir: false,
  isSymlink: false,
  size: 100,
  modified: null,
  permissions: null,
  ...over,
});

let emitProgress: (p: TransferProgress) => void;
let emitDrop: (paths: string[]) => void;

const ok = (path: string, over: Record<string, unknown> = {}) => ({
  exists: false,
  path,
  isDir: false,
  files: 1,
  skipped: 0,
  ...over,
});

const home = {
  path: "/home/u",
  entries: [
    entry({ name: "docs", isDir: true, size: 0 }),
    entry({ name: "a.txt", size: 2048 }),
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.sftpList.mockImplementation(async (_s: string, p?: string) =>
    p === "/home/u/docs"
      ? { path: "/home/u/docs", entries: [entry({ name: "inner.md" })] }
      : home,
  );
  api.sftpDownload.mockResolvedValue({
    exists: false,
    path: "/Users/me/Downloads/a.txt",
    isDir: false,
    files: 1,
    skipped: 0,
  });
  api.sftpUpload.mockResolvedValue(ok("/home/u/up.txt"));
  api.sftpMkdir.mockResolvedValue("/home/u/new");
  api.sftpRemove.mockResolvedValue(undefined);
  api.sftpCancel.mockResolvedValue(true);
  api.pickUploadFiles.mockResolvedValue([]);
  api.onSftpProgress.mockImplementation(async (cb) => {
    emitProgress = cb;
    return () => {};
  });
  api.onFilesDropped.mockImplementation(async (cb) => {
    emitDrop = cb;
    return () => {};
  });
});

async function setup() {
  const user = userEvent.setup();
  render(
    <SftpDialog open onOpenChange={() => {}} sessionId="s1" title="alice@h" />,
  );
  await screen.findByText("a.txt");
  return { user };
}

describe("SftpDialog", () => {
  it("開くとホームフォルダーの一覧を、フォルダー・ファイルの順に表示する", async () => {
    await setup();
    expect(api.sftpList).toHaveBeenCalledWith("s1", undefined);
    expect(screen.getByLabelText("パス")).toHaveValue("/home/u");
    expect(screen.getByText("docs")).toBeInTheDocument();
    expect(screen.getByText("2 KB")).toBeInTheDocument();
  });

  it("フォルダーを開き、「上のフォルダーへ」で戻る", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "docs" }));
    await screen.findByText("inner.md");
    expect(api.sftpList).toHaveBeenLastCalledWith("s1", "/home/u/docs");
    await user.click(screen.getByRole("button", { name: "上のフォルダーへ" }));
    await waitFor(() =>
      expect(api.sftpList).toHaveBeenLastCalledWith("s1", "/home/u"),
    );
  });

  it("パス欄に入力して Enter で移動する", async () => {
    const { user } = await setup();
    const input = screen.getByLabelText("パス");
    await user.clear(input);
    await user.type(input, "/var/log{Enter}");
    expect(api.sftpList).toHaveBeenLastCalledWith("s1", "/var/log");
  });

  it("一覧の取得に失敗したら理由を表示する", async () => {
    api.sftpList.mockRejectedValueOnce(new Error("Permission denied"));
    render(
      <SftpDialog open onOpenChange={() => {}} sessionId="s1" title="t" />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Permission denied",
    );
  });

  it("ダウンロードすると保存先を表示する。進捗イベントで更新される", async () => {
    let resolve!: (r: ReturnType<typeof ok>) => void;
    api.sftpDownload.mockReturnValueOnce(
      new Promise<ReturnType<typeof ok>>((r) => (resolve = r)),
    );
    const { user } = await setup();
    await user.click(
      screen.getByRole("button", { name: "a.txt をダウンロード" }),
    );
    const id = api.sftpDownload.mock.calls[0][2] as string;
    expect(api.sftpDownload).toHaveBeenCalledWith(
      "s1",
      "/home/u/a.txt",
      expect.any(String),
    );
    act(() => emitProgress({ transferId: id, transferred: 1024, total: 2048 }));
    expect(screen.getByRole("progressbar", { name: "進捗" })).toHaveAttribute(
      "value",
      "50",
    );
    await act(async () => resolve(ok("/Users/me/Downloads/a.txt")));
    expect(
      await screen.findByText(/保存先: \/Users\/me\/Downloads\/a.txt/),
    ).toBeInTheDocument();
    expect(screen.getByText("完了")).toBeInTheDocument();
  });

  it("フォルダーもダウンロードできる。ファイル数と、転送しなかった数を表示する", async () => {
    api.sftpDownload.mockResolvedValueOnce(
      ok("/Users/me/Downloads/docs", { isDir: true, files: 12, skipped: 2 }),
    );
    const { user } = await setup();
    await user.click(
      screen.getByRole("button", { name: "docs をダウンロード" }),
    );
    expect(api.sftpDownload).toHaveBeenCalledWith(
      "s1",
      "/home/u/docs",
      expect.any(String),
    );
    expect(
      await screen.findByText(
        "保存先: /Users/me/Downloads/docs（12ファイル。2件はリンクなどのため転送せず）",
      ),
    ).toBeInTheDocument();
  });

  it("同名のフォルダーがあるアップロードは、統合してよいか確認する", async () => {
    api.sftpUpload
      .mockResolvedValueOnce(
        ok("/home/u/proj", { exists: true, isDir: true, files: 0 }),
      )
      .mockResolvedValueOnce(ok("/home/u/proj", { isDir: true, files: 5 }));
    const { user } = await setup();
    await act(async () => emitDrop(["/a/proj"]));
    const box = await screen.findByRole("alertdialog");
    expect(box).toHaveTextContent(
      "中身を統合し、同名のファイルは上書きしますか？",
    );
    await user.click(within(box).getByRole("button", { name: "上書き" }));
    await waitFor(() => expect(api.sftpUpload).toHaveBeenCalledTimes(2));
    expect(api.sftpUpload.mock.calls[1][0]).toMatchObject({ overwrite: true });
    expect(
      await screen.findByText("/home/u/proj（5ファイル）"),
    ).toBeInTheDocument();
  });

  it("実行中の転送は「中止」で止められる", async () => {
    api.sftpDownload.mockReturnValueOnce(new Promise(() => {}));
    const { user } = await setup();
    await user.click(
      screen.getByRole("button", { name: "a.txt をダウンロード" }),
    );
    const id = api.sftpDownload.mock.calls[0][2];
    await user.click(
      screen.getByRole("button", { name: /ダウンロード: a.txt を中止/ }),
    );
    expect(api.sftpCancel).toHaveBeenCalledWith(id);
  });

  it("ダウンロードの失敗を表示する", async () => {
    api.sftpDownload.mockRejectedValueOnce(new Error("読み取れません"));
    const { user } = await setup();
    await user.click(
      screen.getByRole("button", { name: "a.txt をダウンロード" }),
    );
    expect(await screen.findByText("失敗")).toBeInTheDocument();
    expect(screen.getByText("読み取れません")).toBeInTheDocument();
  });

  it("「アップロード」でファイルを選び、表示中のフォルダーへ送って一覧を更新する", async () => {
    api.pickUploadFiles.mockResolvedValueOnce(["/Users/me/up.txt"]);
    const { user } = await setup();
    api.sftpList.mockClear();
    await user.click(screen.getByRole("button", { name: /アップロード/ }));
    await waitFor(() => expect(api.sftpUpload).toHaveBeenCalled());
    expect(api.sftpUpload).toHaveBeenCalledWith({
      sessionId: "s1",
      localPath: "/Users/me/up.txt",
      remoteDir: "/home/u",
      overwrite: false,
      transferId: expect.any(String),
    });
    await waitFor(() => expect(api.sftpList).toHaveBeenCalled());
    expect(await screen.findByText("完了")).toBeInTheDocument();
  });

  it("ドロップしたファイルをアップロードする", async () => {
    await setup();
    await act(async () => emitDrop(["/a/one.txt", "/a/two.txt"]));
    await waitFor(() => expect(api.sftpUpload).toHaveBeenCalledTimes(2));
    expect(api.sftpUpload.mock.calls.map((c) => c[0].localPath)).toEqual([
      "/a/one.txt",
      "/a/two.txt",
    ]);
  });

  it("同名のファイルがあれば確認し、「上書き」で上書きしてアップロードする", async () => {
    api.sftpUpload
      .mockResolvedValueOnce(ok("/home/u/up.txt", { exists: true }))
      .mockResolvedValueOnce(ok("/home/u/up.txt"));
    const { user } = await setup();
    await act(async () => emitDrop(["/a/up.txt"]));
    const box = await screen.findByRole("alertdialog");
    expect(box).toHaveTextContent("up.txt");
    await user.click(within(box).getByRole("button", { name: "上書き" }));
    await waitFor(() => expect(api.sftpUpload).toHaveBeenCalledTimes(2));
    expect(api.sftpUpload.mock.calls[1][0]).toMatchObject({ overwrite: true });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("「スキップ」なら上書きしない", async () => {
    api.sftpUpload.mockResolvedValueOnce(
      ok("/home/u/up.txt", { exists: true }),
    );
    const { user } = await setup();
    await act(async () => emitDrop(["/a/up.txt"]));
    const box = await screen.findByRole("alertdialog");
    await user.click(within(box).getByRole("button", { name: "スキップ" }));
    expect(api.sftpUpload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("新しいフォルダーを作る", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "新しいフォルダー" }));
    await user.type(
      screen.getByLabelText("新しいフォルダーの名前"),
      "new{Enter}",
    );
    expect(api.sftpMkdir).toHaveBeenCalledWith("s1", "/home/u", "new");
  });

  it("削除は確認してから行う。やめれば何もしない", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "a.txt を削除" }));
    expect(api.sftpRemove).not.toHaveBeenCalled();
    let box = screen.getByRole("alertdialog");
    await user.click(within(box).getByRole("button", { name: "やめる" }));
    expect(api.sftpRemove).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "a.txt を削除" }));
    box = screen.getByRole("alertdialog");
    await user.click(within(box).getByRole("button", { name: "削除する" }));
    expect(api.sftpRemove).toHaveBeenCalledWith("s1", "/home/u/a.txt", false);
  });

  it("フォルダーの削除は isDir を渡す", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "docs を削除" }));
    const box = screen.getByRole("alertdialog");
    expect(box).toHaveTextContent("空のフォルダー");
    await user.click(within(box).getByRole("button", { name: "削除する" }));
    expect(api.sftpRemove).toHaveBeenCalledWith("s1", "/home/u/docs", true);
  });

  it("閉じているときは何も読み込まない", () => {
    render(
      <SftpDialog
        open={false}
        onOpenChange={() => {}}
        sessionId="s1"
        title="t"
      />,
    );
    expect(api.sftpList).not.toHaveBeenCalled();
    expect(api.onFilesDropped).not.toHaveBeenCalled();
  });
});

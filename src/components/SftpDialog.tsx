import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Download,
  Folder,
  FolderPlus,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
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
  type RemoteEntry,
} from "../lib/sftp-api";
import {
  baseName,
  formatModified,
  formatSize,
  joinPath,
  parentPath,
  progressPercent,
} from "../lib/sftp";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** SSH セッションの ID。 */
  sessionId: string | null;
  title: string;
}

interface Transfer {
  id: string;
  label: string;
  state: "running" | "done" | "error" | "cancelled";
  transferred: number;
  total: number;
  message?: string;
}

type Confirm =
  | { kind: "delete"; entry: RemoteEntry }
  | { kind: "overwrite"; localPath: string };

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** SSH 接続先のファイルの一覧・アップロード・ダウンロード（SFTP）。 */
export function SftpDialog({ open, onOpenChange, sessionId, title }: Props) {
  const [path, setPath] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  /** 同名のファイルがあり、確認待ちのアップロード。 */
  const overwriteQueue = useRef<string[]>([]);
  const pathRef = useRef<string | null>(null);

  const load = useCallback(
    async (target?: string) => {
      if (!sessionId) return;
      setLoading(true);
      setError(null);
      try {
        const listing = await sftpList(sessionId, target);
        pathRef.current = listing.path;
        setPath(listing.path);
        setPathInput(listing.path);
        setEntries(listing.entries);
      } catch (e) {
        setError(describe(e));
      } finally {
        setLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    if (open) void load(pathRef.current ?? undefined);
  }, [open, load]);

  const patchTransfer = useCallback(
    (id: string, patch: Partial<Transfer>) =>
      setTransfers((list) =>
        list.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      ),
    [],
  );

  const upload = useCallback(
    async (localPath: string, overwrite: boolean) => {
      const dir = pathRef.current;
      if (!sessionId || !dir) return;
      const id = crypto.randomUUID();
      setTransfers((l) => [
        ...l,
        {
          id,
          label: `アップロード: ${baseName(localPath)}`,
          state: "running",
          transferred: 0,
          total: 0,
        },
      ]);
      try {
        const result = await sftpUpload({
          sessionId,
          localPath,
          remoteDir: dir,
          overwrite,
          transferId: id,
        });
        if (result.exists) {
          // 上書きしてよいか確認する（まとめて落としたときは、順に聞く）。
          setTransfers((l) => l.filter((t) => t.id !== id));
          overwriteQueue.current.push(localPath);
          setConfirm((c) => c ?? { kind: "overwrite", localPath });
          return;
        }
        patchTransfer(id, { state: "done", message: result.path });
      } catch (e) {
        const message = describe(e);
        patchTransfer(id, {
          state: message.includes("中止") ? "cancelled" : "error",
          message,
        });
      }
    },
    [sessionId, patchTransfer],
  );

  const uploadAll = useCallback(
    async (paths: string[]) => {
      for (const p of paths) await upload(p, false);
      await load(pathRef.current ?? undefined);
    },
    [upload, load],
  );

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    const unlisten: Array<() => void> = [];
    const keep = (p: Promise<() => void>) =>
      p
        .then((un) => (disposed ? un() : unlisten.push(un)))
        .catch((e: unknown) => console.error("購読に失敗しました:", e));
    keep(
      onSftpProgress((p) =>
        patchTransfer(p.transferId, {
          transferred: p.transferred,
          total: p.total,
        }),
      ),
    );
    keep(onFilesDropped((paths) => void uploadAll(paths)));
    return () => {
      disposed = true;
      unlisten.forEach((un) => un());
    };
  }, [open, patchTransfer, uploadAll]);

  const download = async (entry: RemoteEntry) => {
    if (!sessionId || !path) return;
    const id = crypto.randomUUID();
    setTransfers((l) => [
      ...l,
      {
        id,
        label: `ダウンロード: ${entry.name}`,
        state: "running",
        transferred: 0,
        total: entry.size,
      },
    ]);
    try {
      const saved = await sftpDownload(
        sessionId,
        joinPath(path, entry.name),
        id,
      );
      patchTransfer(id, { state: "done", message: `保存先: ${saved}` });
    } catch (e) {
      const message = describe(e);
      patchTransfer(id, {
        state: message.includes("中止") ? "cancelled" : "error",
        message,
      });
    }
  };

  const answerOverwrite = async (yes: boolean) => {
    const current = confirm;
    if (current?.kind !== "overwrite") return;
    overwriteQueue.current.shift();
    const next = overwriteQueue.current[0];
    setConfirm(next ? { kind: "overwrite", localPath: next } : null);
    if (yes) await upload(current.localPath, true);
    if (!next) await load(pathRef.current ?? undefined);
  };

  const doDelete = async () => {
    if (confirm?.kind !== "delete" || !sessionId || !path) return;
    const entry = confirm.entry;
    setConfirm(null);
    try {
      await sftpRemove(sessionId, joinPath(path, entry.name), entry.isDir);
      await load(path);
    } catch (e) {
      setError(describe(e));
    }
  };

  const doMkdir = async () => {
    if (newFolder === null || !sessionId || !path) return;
    const name = newFolder.trim();
    if (name === "") return;
    try {
      await sftpMkdir(sessionId, path, name);
      setNewFolder(null);
      await load(path);
    } catch (e) {
      setError(describe(e));
    }
  };

  const pick = async () => {
    try {
      const paths = await pickUploadFiles();
      if (paths.length > 0) await uploadAll(paths);
    } catch (e) {
      setError(describe(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogTitle>ファイル（SFTP）— {title}</DialogTitle>
        <DialogDescription className="mt-1">
          ファイルをこの画面へドラッグ＆ドロップするか「アップロード」で、表示中のフォルダーへ送ります。ダウンロードは「ダウンロード」フォルダーへ保存します（フォルダー単位の転送には未対応です）。
        </DialogDescription>

        <div className="mt-3 flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label="上のフォルダーへ"
            disabled={!path || loading}
            onClick={() => path && void load(parentPath(path))}
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Input
            aria-label="パス"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void load(pathInput);
            }}
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label="更新"
            disabled={loading}
            onClick={() => void load(path ?? undefined)}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="新しいフォルダー"
            disabled={!path}
            onClick={() => setNewFolder("")}
          >
            <FolderPlus className="h-4 w-4" />
          </Button>
          <Button size="sm" disabled={!path} onClick={() => void pick()}>
            <Upload className="mr-1 h-4 w-4" />
            アップロード
          </Button>
        </div>

        {newFolder !== null && (
          <div className="mt-2 flex items-center gap-2">
            <Input
              aria-label="新しいフォルダーの名前"
              autoFocus
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void doMkdir();
                if (e.key === "Escape") setNewFolder(null);
              }}
            />
            <Button size="sm" onClick={() => void doMkdir()}>
              作成
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setNewFolder(null)}
            >
              キャンセル
            </Button>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-2 text-sm text-red-400">
            {error}
          </p>
        )}

        {confirm?.kind === "overwrite" && (
          <div
            role="alertdialog"
            className="mt-2 flex items-center justify-between gap-2 rounded border border-amber-600 bg-amber-950/40 px-3 py-2 text-sm"
          >
            <span>
              「{baseName(confirm.localPath)}」は既にあります。上書きしますか？
            </span>
            <span className="flex gap-1">
              <Button size="sm" onClick={() => void answerOverwrite(true)}>
                上書き
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void answerOverwrite(false)}
              >
                スキップ
              </Button>
            </span>
          </div>
        )}
        {confirm?.kind === "delete" && (
          <div
            role="alertdialog"
            className="mt-2 flex items-center justify-between gap-2 rounded border border-red-700 bg-red-950/40 px-3 py-2 text-sm"
          >
            <span>
              「{confirm.entry.name}」を削除しますか？
              {confirm.entry.isDir && "（空のフォルダーのみ削除できます）"}
            </span>
            <span className="flex gap-1">
              <Button size="sm" onClick={() => void doDelete()}>
                削除する
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirm(null)}
              >
                やめる
              </Button>
            </span>
          </div>
        )}

        <div
          className="mt-3 max-h-72 overflow-y-auto rounded border border-neutral-700"
          aria-busy={loading}
        >
          {entries.length === 0 && !loading ? (
            <p className="p-3 text-sm text-neutral-400">
              このフォルダーは空です。
            </p>
          ) : (
            <ul>
              {entries.map((entry) => (
                <li
                  key={entry.name}
                  className="flex items-center gap-2 border-b border-neutral-800 px-3 py-1 text-sm last:border-b-0"
                >
                  {entry.isDir ? (
                    <button
                      className="flex min-w-0 flex-1 items-center gap-2 text-left hover:underline"
                      onClick={() =>
                        path && void load(joinPath(path, entry.name))
                      }
                    >
                      <Folder className="h-4 w-4 shrink-0 text-sky-400" />
                      <span className="truncate">{entry.name}</span>
                    </button>
                  ) : (
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="w-4 shrink-0" />
                      <span className="truncate">{entry.name}</span>
                    </span>
                  )}
                  <span className="w-20 shrink-0 text-right text-neutral-400">
                    {entry.isDir ? "" : formatSize(entry.size)}
                  </span>
                  <span className="w-36 shrink-0 text-neutral-400">
                    {formatModified(entry.modified)}
                  </span>
                  <span className="flex w-16 shrink-0 justify-end gap-1">
                    {!entry.isDir && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6"
                        aria-label={`${entry.name} をダウンロード`}
                        onClick={() => void download(entry)}
                      >
                        <Download className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      aria-label={`${entry.name} を削除`}
                      onClick={() => setConfirm({ kind: "delete", entry })}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {transfers.length > 0 && (
          <ul className="mt-3 grid gap-1 text-sm" aria-label="転送">
            {transfers.map((t) => {
              const pct = progressPercent(t.transferred, t.total);
              return (
                <li
                  key={t.id}
                  className="rounded border border-neutral-700 p-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{t.label}</span>
                    {t.state === "running" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`${t.label} を中止`}
                        onClick={() => void sftpCancel(t.id)}
                      >
                        中止
                      </Button>
                    ) : (
                      <span
                        className={
                          t.state === "done"
                            ? "text-emerald-400"
                            : t.state === "error"
                              ? "text-red-400"
                              : "text-amber-300"
                        }
                      >
                        {t.state === "done"
                          ? "完了"
                          : t.state === "error"
                            ? "失敗"
                            : "中止"}
                      </span>
                    )}
                  </div>
                  {t.state === "running" && (
                    <progress
                      className="mt-1 h-1.5 w-full"
                      max={100}
                      value={pct ?? undefined}
                      aria-label="進捗"
                    />
                  )}
                  {t.message && (
                    <p className="mt-1 break-all text-xs text-neutral-400">
                      {t.message}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-4 flex justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            閉じる
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

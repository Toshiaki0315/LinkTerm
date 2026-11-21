import { useState } from "react";
import {
  NO_FOLDER,
  folderNames,
  formatTags,
  groupProfiles,
  parseTagInput,
  profileMatches,
} from "../lib/profile-groups";
import type { SavedProfile } from "../lib/terminal-api";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profiles: SavedProfile[];
  /** 接続する（パスワードが要る接続は、入力用のダイアログが開く）。 */
  onOpenProfile: (profile: SavedProfile) => void;
  /** 名前・フォルダー・タグを変える。失敗したら例外を投げる。 */
  onUpdate: (profile: {
    id: string;
    name: string;
    folder: string;
    tags: string[];
  }) => Promise<void>;
  onDelete: (id: string) => void;
  /** 書き出す。結果の文を返す（キャンセルなら null）。渡さなければボタンを出さない。 */
  onExport?: () => Promise<string | null>;
  /** 読み込む。結果の文を返す（キャンセルなら null）。渡さなければボタンを出さない。 */
  onImport?: () => Promise<string | null>;
}

interface Draft {
  id: string;
  name: string;
  folder: string;
  tags: string;
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 保存済みの接続の一覧（フォルダー別）と、名前・フォルダー・タグの編集、削除。 */
export function ProfilesDialog({
  open,
  onOpenChange,
  profiles,
  onOpenProfile,
  onUpdate,
  onDelete,
  onExport,
  onImport,
}: Props) {
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const transfer = async (
    action: () => Promise<string | null>,
    failure: string,
  ) => {
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
    } catch (e) {
      setError(`${failure}: ${describe(e)}`);
    }
  };

  const visible = profiles.filter((p) => profileMatches(p, query));
  const groups = groupProfiles(visible);

  const submit = async () => {
    if (!draft) return;
    if (draft.name.trim() === "") {
      setError("名前を入力してください");
      return;
    }
    try {
      await onUpdate({
        id: draft.id,
        name: draft.name.trim(),
        folder: draft.folder.trim(),
        tags: parseTagInput(draft.tags),
      });
      setDraft(null);
      setError(null);
    } catch (e) {
      setError(`保存できません: ${describe(e)}`);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setDraft(null);
          setConfirmId(null);
          setError(null);
          setNotice(null);
          setQuery("");
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogTitle>保存済みの接続</DialogTitle>
        <DialogDescription className="mt-1">
          フォルダーとタグで整理できます。名前・フォルダー・タグでの検索は、コマンドパレット（⌘⇧P）からも使えます。
        </DialogDescription>

        {error && (
          <p role="alert" className="mt-3 text-sm text-red-400">
            {error}
          </p>
        )}

        {notice && (
          <p role="status" className="mt-3 text-sm text-emerald-400">
            {notice}
          </p>
        )}

        {draft ? (
          <div className="mt-4 grid gap-3">
            <div className="grid gap-1">
              <Label htmlFor="pf-name">名前</Label>
              <Input
                id="pf-name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1">
                <Label htmlFor="pf-folder">フォルダー</Label>
                <Input
                  id="pf-folder"
                  list="pf-folder-suggestions"
                  value={draft.folder}
                  onChange={(e) =>
                    setDraft({ ...draft, folder: e.target.value })
                  }
                />
                <datalist id="pf-folder-suggestions">
                  {folderNames(profiles).map((f) => (
                    <option key={f} value={f} />
                  ))}
                </datalist>
              </div>
              <div className="grid gap-1">
                <Label htmlFor="pf-tags">タグ（カンマ区切り）</Label>
                <Input
                  id="pf-tags"
                  value={draft.tags}
                  onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setDraft(null);
                  setError(null);
                }}
              >
                キャンセル
              </Button>
              <Button onClick={() => void submit()}>保存</Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 grid gap-3">
            <Input
              aria-label="接続を検索"
              placeholder="名前・フォルダー・タグで絞り込み"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="max-h-80 overflow-y-auto">
              {profiles.length === 0 ? (
                <p className="text-sm text-neutral-400">
                  保存済みの接続はまだありません。接続ダイアログの「この接続を保存する」で追加できます。
                </p>
              ) : groups.length === 0 ? (
                <p className="text-sm text-neutral-400">
                  一致する接続がありません。
                </p>
              ) : (
                groups.map((g) => (
                  <section
                    key={g.folder}
                    aria-label={g.folder === NO_FOLDER ? "未分類" : g.folder}
                    className="mb-3"
                  >
                    <h3 className="mb-1 text-xs font-semibold text-neutral-400">
                      {g.folder === NO_FOLDER ? "未分類" : g.folder}
                    </h3>
                    <ul className="grid gap-1">
                      {g.profiles.map((p) => (
                        <li
                          key={p.id}
                          className="flex items-center justify-between gap-2 rounded border border-neutral-700 px-3 py-1.5 text-sm"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate">{p.name}</span>
                            {(p.tags ?? []).map((t) => (
                              <span
                                key={t}
                                className="shrink-0 rounded bg-neutral-800 px-1.5 text-xs text-neutral-300"
                              >
                                {t}
                              </span>
                            ))}
                          </span>
                          {confirmId === p.id ? (
                            <span className="flex shrink-0 items-center gap-1">
                              <span className="text-xs text-red-300">
                                削除しますか？
                              </span>
                              <Button
                                size="sm"
                                onClick={() => {
                                  onDelete(p.id);
                                  setConfirmId(null);
                                }}
                              >
                                削除する
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setConfirmId(null)}
                              >
                                やめる
                              </Button>
                            </span>
                          ) : (
                            <span className="flex shrink-0 gap-1">
                              <Button
                                size="sm"
                                aria-label={`${p.name} に接続`}
                                onClick={() => {
                                  onOpenChange(false);
                                  onOpenProfile(p);
                                }}
                              >
                                接続
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                aria-label={`${p.name} を編集`}
                                onClick={() => {
                                  setError(null);
                                  setDraft({
                                    id: p.id,
                                    name: p.name,
                                    folder: p.folder ?? "",
                                    tags: formatTags(p.tags),
                                  });
                                }}
                              >
                                編集
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                aria-label={`${p.name} を削除`}
                                onClick={() => setConfirmId(p.id)}
                              >
                                削除
                              </Button>
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                ))
              )}
            </div>
            <div className="flex justify-between gap-2">
              <span className="flex gap-2">
                {onImport && (
                  <Button
                    variant="outline"
                    onClick={() => void transfer(onImport, "読み込めません")}
                  >
                    読み込み…
                  </Button>
                )}
                {onExport && (
                  <Button
                    variant="outline"
                    onClick={() => void transfer(onExport, "書き出せません")}
                  >
                    書き出し…
                  </Button>
                )}
              </span>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                閉じる
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

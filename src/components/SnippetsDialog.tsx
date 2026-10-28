import { useState } from "react";
import {
  MAX_LINE_DELAY_MS,
  MAX_NAME_CHARS,
  MAX_SNIPPETS,
  MAX_TEXT_CHARS,
  newSnippet,
  type Snippet,
} from "../lib/snippets";
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
  snippets: Snippet[];
  /** 保存する。失敗したら例外を投げる。 */
  onSave: (snippets: Snippet[]) => Promise<void>;
}

/** 入力内容を検証する。問題がなければ `null`。 */
export function validateSnippet(s: Snippet): string | null {
  if (s.name.trim() === "") return "名前を入力してください";
  if ([...s.name.trim()].length > MAX_NAME_CHARS)
    return `名前は${MAX_NAME_CHARS}文字以内で入力してください`;
  if (s.text === "") return "内容を入力してください";
  if ([...s.text].length > MAX_TEXT_CHARS)
    return `内容は${MAX_TEXT_CHARS}文字以内で入力してください`;
  if (
    !Number.isInteger(s.lineDelayMs) ||
    s.lineDelayMs < 0 ||
    s.lineDelayMs > MAX_LINE_DELAY_MS
  )
    return `行間の待ち時間は0〜${MAX_LINE_DELAY_MS}ミリ秒で入力してください`;
  return null;
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** スニペットの一覧・追加・編集・削除。 */
export function SnippetsDialog({
  open,
  onOpenChange,
  snippets,
  onSave,
}: Props) {
  /** 編集中のスニペット。`null` なら一覧だけ表示する。 */
  const [draft, setDraft] = useState<Snippet | null>(null);
  const [error, setError] = useState<string | null>(null);

  const persist = async (next: Snippet[]) => {
    try {
      await onSave(next);
      setError(null);
      return true;
    } catch (e) {
      setError(`保存できません: ${describe(e)}`);
      return false;
    }
  };

  const submit = async () => {
    if (!draft) return;
    const problem = validateSnippet(draft);
    if (problem) {
      setError(problem);
      return;
    }
    const cleaned = { ...draft, name: draft.name.trim() };
    const exists = snippets.some((s) => s.id === cleaned.id);
    const next = exists
      ? snippets.map((s) => (s.id === cleaned.id ? cleaned : s))
      : [...snippets, cleaned];
    if (await persist(next)) setDraft(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setDraft(null);
          setError(null);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogTitle>スニペット</DialogTitle>
        <DialogDescription className="mt-1">
          よく使うコマンドを登録し、タブバーの「スニペット」から操作中のペインへ送ります。
          複数行は1行ずつ送ります。パスワードなどの秘密情報は登録しないでください（平文で保存されます）。
        </DialogDescription>

        {error && (
          <p role="alert" className="mt-3 text-sm text-red-400">
            {error}
          </p>
        )}

        {draft ? (
          <div className="mt-4 grid gap-3">
            <div className="grid gap-1">
              <Label htmlFor="snippet-name">名前</Label>
              <Input
                id="snippet-name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="snippet-text">内容（1行ずつ送ります）</Label>
              <textarea
                id="snippet-text"
                rows={6}
                value={draft.text}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                className="w-full rounded-md border border-neutral-600 bg-neutral-900 px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="snippet-delay">
                行と行の間の待ち時間（ミリ秒）
              </Label>
              <Input
                id="snippet-delay"
                type="number"
                min={0}
                max={MAX_LINE_DELAY_MS}
                value={draft.lineDelayMs}
                onChange={(e) =>
                  setDraft({ ...draft, lineDelayMs: e.target.valueAsNumber })
                }
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.sendEnter}
                onChange={(e) =>
                  setDraft({ ...draft, sendEnter: e.target.checked })
                }
              />
              最後の行にも Enter を付けて実行する
            </label>
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
            {snippets.length === 0 ? (
              <p className="text-sm text-neutral-400">
                スニペットはまだありません。
              </p>
            ) : (
              <ul className="grid gap-1">
                {snippets.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-2 rounded border border-neutral-700 px-3 py-1.5"
                  >
                    <span className="min-w-0 truncate text-sm">{s.name}</span>
                    <span className="flex shrink-0 gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`${s.name} を編集`}
                        onClick={() => {
                          setError(null);
                          setDraft(s);
                        }}
                      >
                        編集
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`${s.name} を削除`}
                        onClick={() =>
                          void persist(snippets.filter((x) => x.id !== s.id))
                        }
                      >
                        削除
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-between">
              <Button
                disabled={snippets.length >= MAX_SNIPPETS}
                onClick={() => {
                  setError(null);
                  setDraft(newSnippet(crypto.randomUUID()));
                }}
              >
                追加
              </Button>
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

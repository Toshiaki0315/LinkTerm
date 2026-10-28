import { useState } from "react";
import {
  MAX_PATTERN_CHARS,
  MAX_RULES,
  newRule,
  validateRule,
  type HighlightRule,
} from "../lib/highlight";
import { TAB_COLORS, tabColorHex } from "../lib/tab-colors";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import { Input, Select } from "./ui/input";
import { Label } from "./ui/label";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rules: HighlightRule[];
  /** 保存する。失敗したら例外を投げる。 */
  onSave: (rules: HighlightRule[]) => Promise<void>;
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** キーワードの強調（色付け）と通知の規則の一覧・追加・編集・削除。 */
export function HighlightsDialog({ open, onOpenChange, rules, onSave }: Props) {
  const [draft, setDraft] = useState<HighlightRule | null>(null);
  const [error, setError] = useState<string | null>(null);

  const persist = async (next: HighlightRule[]) => {
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
    const problem = validateRule(draft);
    if (problem) {
      setError(problem);
      return;
    }
    const exists = rules.some((r) => r.id === draft.id);
    const next = exists
      ? rules.map((r) => (r.id === draft.id ? draft : r))
      : [...rules, draft];
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
        <DialogTitle>キーワードの強調・通知</DialogTitle>
        <DialogDescription className="mt-1">
          画面に出た文字列が規則に一致すると、その部分に色を付けます。「通知する」を付けた規則は、そのタブを見ていないときに、macOS
          の通知とタブの印でお知らせします（通知には、見つけた語と接続先だけを載せます）。規則は上にあるものが優先されます。
        </DialogDescription>

        {error && (
          <p role="alert" className="mt-3 text-sm text-red-400">
            {error}
          </p>
        )}

        {draft ? (
          <div className="mt-4 grid gap-3">
            <div className="grid gap-1">
              <Label htmlFor="hl-pattern">見つけたい文字列</Label>
              <Input
                id="hl-pattern"
                value={draft.pattern}
                maxLength={MAX_PATTERN_CHARS}
                onChange={(e) =>
                  setDraft({ ...draft, pattern: e.target.value })
                }
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.regex}
                onChange={(e) =>
                  setDraft({ ...draft, regex: e.target.checked })
                }
              />
              正規表現として扱う
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.caseSensitive}
                onChange={(e) =>
                  setDraft({ ...draft, caseSensitive: e.target.checked })
                }
              />
              大文字・小文字を区別する
            </label>
            <div className="grid gap-1">
              <Label htmlFor="hl-color">色</Label>
              <Select
                id="hl-color"
                value={draft.color}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    color: e.target.value as HighlightRule["color"],
                  })
                }
              >
                {TAB_COLORS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.notify}
                onChange={(e) =>
                  setDraft({ ...draft, notify: e.target.checked })
                }
              />
              通知する（見ていないタブで見つかったとき）
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
            {rules.length === 0 ? (
              <p className="text-sm text-neutral-400">規則はまだありません。</p>
            ) : (
              <ul className="grid gap-1">
                {rules.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between gap-2 rounded border border-neutral-700 px-3 py-1.5"
                  >
                    <span className="flex min-w-0 items-center gap-2 text-sm">
                      <span
                        aria-hidden
                        className="h-3 w-3 shrink-0 rounded-full"
                        style={{ backgroundColor: tabColorHex(r.color) }}
                      />
                      <span className="truncate font-mono">{r.pattern}</span>
                      {r.regex && (
                        <span className="shrink-0 text-xs text-neutral-400">
                          正規表現
                        </span>
                      )}
                      {r.notify && (
                        <span className="shrink-0 text-xs text-amber-300">
                          通知
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`${r.pattern} を編集`}
                        onClick={() => {
                          setError(null);
                          setDraft(r);
                        }}
                      >
                        編集
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`${r.pattern} を削除`}
                        onClick={() =>
                          void persist(rules.filter((x) => x.id !== r.id))
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
                disabled={rules.length >= MAX_RULES}
                onClick={() => {
                  setError(null);
                  setDraft(newRule(crypto.randomUUID()));
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

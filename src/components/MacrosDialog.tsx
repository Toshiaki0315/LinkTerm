import { useMemo, useState } from "react";
import { PLAIN_TEXT_PROPS } from "../lib/text-input";
import {
  MAX_MACROS,
  checkMacroSource,
  newMacro,
  validateMacro,
  type Macro,
} from "../lib/macros";
import { pickMacroFile } from "../lib/macro-file";
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
  macros: Macro[];
  /** 保存する。失敗したら例外を投げる。 */
  onSave: (macros: Macro[]) => Promise<void>;
  /** 一覧から実行する。渡さなければ、実行ボタンを出さない。 */
  onRun?: (macro: Macro) => void;
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** マクロの一覧・追加・編集・削除・`.ttl` ファイルの読み込み・文法のチェック。 */
export function MacrosDialog({
  open,
  onOpenChange,
  macros,
  onSave,
  onRun,
}: Props) {
  /** 編集中のマクロ。`null` なら一覧だけ表示する。 */
  const [draft, setDraft] = useState<Macro | null>(null);
  const [error, setError] = useState<string | null>(null);

  const issues = useMemo(
    () => (draft ? checkMacroSource(draft.text) : []),
    [draft],
  );

  const persist = async (next: Macro[]) => {
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
    const problem = validateMacro(draft);
    if (problem) {
      setError(problem);
      return;
    }
    const cleaned = { ...draft, name: draft.name.trim() };
    const exists = macros.some((m) => m.id === cleaned.id);
    const next = exists
      ? macros.map((m) => (m.id === cleaned.id ? cleaned : m))
      : [...macros, cleaned];
    if (await persist(next)) setDraft(null);
  };

  const importFile = async () => {
    if (!draft) return;
    try {
      const picked = await pickMacroFile();
      if (picked === null) return;
      setError(null);
      setDraft((d) =>
        d
          ? {
              ...d,
              text: picked.text,
              name: d.name.trim() === "" ? picked.name : d.name,
            }
          : d,
      );
    } catch (e) {
      setError(`ファイルを読み込めません: ${describe(e)}`);
    }
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
      <DialogContent className="max-w-2xl">
        <DialogTitle>マクロ</DialogTitle>
        <DialogDescription className="mt-1">
          Tera Term
          のマクロ（TTL）と同じ書き方のスクリプトを、操作中のペインで実行します。
          Tera Term の .ttl
          ファイルを読み込めます（ファイル・外部コマンドを扱う命令は使えません）。
          パスワードはスクリプトに書かず、passwordbox
          で実行時に入力してください（スクリプトは平文で保存されます）。
        </DialogDescription>

        {error && (
          <p role="alert" className="mt-3 text-sm text-red-400">
            {error}
          </p>
        )}

        {draft ? (
          <div className="mt-4 grid gap-3">
            <div className="grid gap-1">
              <Label htmlFor="macro-name">名前</Label>
              <Input
                id="macro-name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div className="grid gap-1">
              <div className="flex items-center justify-between">
                <Label htmlFor="macro-text">スクリプト</Label>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void importFile()}
                >
                  ファイルから読み込む…
                </Button>
              </div>
              <textarea
                id="macro-text"
                rows={14}
                {...PLAIN_TEXT_PROPS}
                value={draft.text}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                className="w-full rounded-md border border-neutral-600 bg-neutral-900 px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
              />
              {draft.text.trim() === "" || issues.length === 0 ? (
                <p className="text-xs text-neutral-400">文法: 問題ありません</p>
              ) : (
                <ul
                  aria-label="文法のエラー"
                  className="max-h-28 overflow-y-auto text-xs text-red-400"
                >
                  {issues.map((i, index) => (
                    <li key={index}>
                      {i.line}行目: {i.message}
                    </li>
                  ))}
                </ul>
              )}
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
            {macros.length === 0 ? (
              <p className="text-sm text-neutral-400">
                マクロはまだありません。
              </p>
            ) : (
              <ul className="grid gap-1">
                {macros.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-center justify-between gap-2 rounded border border-neutral-700 px-3 py-1.5"
                  >
                    <span className="min-w-0 truncate text-sm">{m.name}</span>
                    <span className="flex shrink-0 gap-1">
                      {onRun && (
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`${m.name} を実行`}
                          onClick={() => onRun(m)}
                        >
                          実行
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`${m.name} を編集`}
                        onClick={() => {
                          setError(null);
                          setDraft(m);
                        }}
                      >
                        編集
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`${m.name} を削除`}
                        onClick={() =>
                          void persist(macros.filter((x) => x.id !== m.id))
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
                disabled={macros.length >= MAX_MACROS}
                onClick={() => {
                  setError(null);
                  setDraft(newMacro(crypto.randomUUID()));
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

import { useEffect, useState } from "react";
import {
  DEFAULT_BINDINGS,
  SHORTCUT_DEFS,
  bindingFromEvent,
  formatBinding,
  validateBinding,
  type Bindings,
  type ShortcutId,
} from "../lib/shortcuts";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bindings: Bindings;
  /** 新しい割り当てを保存する。失敗したら例外を投げる。 */
  onSave: (bindings: Bindings) => Promise<void>;
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** ショートカットの一覧と変更。「変更」を押してから、割り当てたいキーを押す。 */
export function ShortcutsDialog({
  open,
  onOpenChange,
  bindings,
  onSave,
}: Props) {
  /** キーの入力待ちの操作。 */
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [message, setMessage] = useState<{
    kind: "error" | "hint";
    text: string;
  } | null>(null);

  const save = async (next: Bindings) => {
    try {
      await onSave(next);
      setMessage(null);
    } catch (e) {
      setMessage({ kind: "error", text: `保存できません: ${describe(e)}` });
    }
  };

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // 入力待ちの間のキーは、ここで受け止める（アプリのほかの操作・ダイアログの Esc に回さない）。
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(null);
        setMessage(null);
        return;
      }
      const binding = bindingFromEvent(event);
      if (binding === null) {
        // 修飾キーだけを押した間は、待ち続ける。
        if (
          !["Meta", "Shift", "Control", "Alt", "CapsLock"].includes(event.key)
        ) {
          setMessage({
            kind: "hint",
            text: "⌘ を押しながらキーを押してください（Esc で取り消し）",
          });
        }
        return;
      }
      const problem = validateBinding(recording, binding, bindings);
      if (problem) {
        setMessage({ kind: "error", text: problem });
        return;
      }
      setRecording(null);
      void save({ ...bindings, [recording]: binding });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // `save` は props の `onSave` だけに依存する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, bindings, onSave]);

  const allDefault = SHORTCUT_DEFS.every((d) => bindings[d.id] === d.binding);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setRecording(null);
          setMessage(null);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogTitle>ショートカット</DialogTitle>
        <DialogDescription className="mt-1">
          「変更」を押してから、割り当てたいキーを押してください（⌘
          を含む組み合わせのみ）。⌘1〜9（タブの番号選択）は固定です。
        </DialogDescription>

        {message && (
          <p
            role={message.kind === "error" ? "alert" : "status"}
            className={
              message.kind === "error"
                ? "mt-3 text-sm text-red-400"
                : "mt-3 text-sm text-amber-300"
            }
          >
            {message.text}
          </p>
        )}

        <ul className="mt-4 grid gap-1">
          {SHORTCUT_DEFS.map((d) => {
            const isRecording = recording === d.id;
            return (
              <li
                key={d.id}
                className="flex items-center justify-between gap-2 rounded border border-neutral-700 px-3 py-1.5 text-sm"
              >
                <span className="min-w-0 truncate">{d.label}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <kbd
                    className="min-w-16 rounded bg-neutral-800 px-2 py-0.5 text-center font-sans"
                    aria-label={`${d.label} の現在のキー`}
                  >
                    {isRecording
                      ? "キーを押す…"
                      : formatBinding(bindings[d.id])}
                  </kbd>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`${d.label} のショートカットを変更`}
                    onClick={() => {
                      setMessage(null);
                      setRecording(isRecording ? null : d.id);
                    }}
                  >
                    {isRecording ? "取り消し" : "変更"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`${d.label} を初期値に戻す`}
                    disabled={bindings[d.id] === d.binding}
                    onClick={() => {
                      const initial = d.binding;
                      const problem = validateBinding(d.id, initial, bindings);
                      if (problem) {
                        setMessage({ kind: "error", text: problem });
                        return;
                      }
                      void save({ ...bindings, [d.id]: initial });
                    }}
                  >
                    初期値
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>

        <div className="mt-4 flex justify-between">
          <Button
            variant="outline"
            disabled={allDefault}
            onClick={() => {
              setRecording(null);
              void save({ ...DEFAULT_BINDINGS });
            }}
          >
            すべて初期値に戻す
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            閉じる
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { filterCommands, type PaletteCommand } from "../lib/command-search";
import { cn } from "../lib/utils";
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
  commands: PaletteCommand[];
}

/** 表示する件数の上限（極端に多いとき）。絞り込めば、その外も見つかる。 */
const MAX_VISIBLE = 100;

/** コマンドパレット。語で絞り込み、↑↓ で選び、Enter で実行する。 */
export function CommandPalette({ open, onOpenChange, commands }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-24 max-w-xl -translate-y-0 p-3">
        <DialogTitle className="sr-only">コマンドパレット</DialogTitle>
        <DialogDescription className="sr-only">
          コマンドを検索して実行します。↑↓で選び、Enter で実行、Esc で閉じます。
        </DialogDescription>
        {/* 開くたびに状態を新しくするため、開いている間だけ中身を置く。 */}
        {open && (
          <PaletteBody
            commands={commands}
            onRun={(c) => {
              onOpenChange(false);
              c.run();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PaletteBody({
  commands,
  onRun,
}: {
  commands: PaletteCommand[];
  onRun: (command: PaletteCommand) => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const shown = useMemo(
    () => filterCommands(commands, query).slice(0, MAX_VISIBLE),
    [commands, query],
  );
  const current = Math.min(index, Math.max(shown.length - 1, 0));

  useEffect(() => {
    // 選択中の項目が見えるようにする。
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [current, shown]);

  const move = (delta: number) => {
    if (shown.length === 0) return;
    setIndex((current + delta + shown.length) % shown.length);
  };

  return (
    <div className="grid gap-2">
      <Input
        autoFocus
        role="combobox"
        aria-label="コマンドを検索"
        aria-expanded
        aria-controls="palette-list"
        aria-activedescendant={
          shown[current] ? `palette-${shown[current].id}` : undefined
        }
        placeholder="コマンドを入力…（例: 分割、設定、タブ名）"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          // 日本語入力の変換中の Enter・矢印は、変換の操作なので扱わない。
          if (e.nativeEvent.isComposing) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            move(-1);
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (shown[current]) onRun(shown[current]);
          }
        }}
      />
      <ul
        id="palette-list"
        role="listbox"
        ref={listRef}
        className="max-h-80 overflow-y-auto"
      >
        {shown.length === 0 ? (
          <li className="px-3 py-2 text-sm text-neutral-400">
            一致するコマンドがありません。
          </li>
        ) : (
          shown.map((c, i) => (
            <li
              key={c.id}
              id={`palette-${c.id}`}
              role="option"
              aria-selected={i === current}
              onMouseMove={() => setIndex(i)}
              onClick={() => onRun(c)}
              className={cn(
                "flex cursor-pointer items-center justify-between gap-3 rounded px-3 py-1.5 text-sm",
                i === current && "bg-neutral-800",
              )}
            >
              <span className="min-w-0 truncate">{c.title}</span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-neutral-400">
                {c.hint && <kbd className="font-sans">{c.hint}</kbd>}
                <span>{c.group}</span>
              </span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

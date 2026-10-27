import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SessionStatus } from "../hooks/useTerminalSession";
import type { Tab } from "../lib/tabs";
import { cn } from "../lib/utils";
import { ContextMenu } from "./ContextMenu";
import { Button } from "./ui/button";

interface Props {
  tabs: Tab[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /** タブ名の変更。渡さなければ編集できない。 */
  onRename?: (id: string, title: string) => void;
  /** タブの複製。渡さなければメニューに出さない。 */
  onDuplicate?: (id: string) => void;
  /** 並べ替え（`toIndex` へ移動）。渡さなければドラッグできない。 */
  onMove?: (id: string, toIndex: number) => void;
}

/** タブ名の編集欄。Enter / フォーカス喪失で確定、Esc で取り消す。 */
function TitleEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 確定・取り消しのどちらかが済んだら、フォーカス喪失で二重に処理しない。 */
  const finished = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const title = draft.trim();
    if (commit && title !== "" && title !== initial) onCommit(title);
    else onCancel();
  };

  return (
    <input
      ref={inputRef}
      aria-label="タブ名"
      className="h-5 w-40 rounded border border-sky-600 bg-neutral-950 px-1 text-sm"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: "",
  connecting: "接続中",
  connected: "",
  closed: "切断",
  error: "エラー",
};

const STATUS_DOT: Record<SessionStatus, string> = {
  idle: "bg-neutral-500",
  connecting: "bg-amber-400 animate-pulse",
  connected: "bg-emerald-500",
  closed: "bg-neutral-500",
  error: "bg-red-500",
};

export function TabBar({
  tabs,
  activeId,
  onActivate,
  onClose,
  onNew,
  onRename,
  onDuplicate,
  onMove,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const hasMenu = Boolean(onRename || onDuplicate);

  const menuItems = (id: string) => [
    ...(onRename
      ? [{ label: "名前を変更", onSelect: () => setEditingId(id) }]
      : []),
    ...(onDuplicate
      ? [{ label: "複製", onSelect: () => onDuplicate(id) }]
      : []),
    { label: "閉じる", onSelect: () => onClose(id) },
  ];

  return (
    <div className="flex items-center gap-1 border-b border-neutral-800 bg-neutral-950 px-2 pt-1">
      <div role="tablist" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          const statusId = `tab-status-${tab.id}`;
          return (
            <div
              key={tab.id}
              draggable={Boolean(onMove) && editingId !== tab.id}
              onDragStart={(e) => {
                setDragId(tab.id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", tab.id);
              }}
              onDragOver={(e) => {
                if (dragId === null || dragId === tab.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setOverId(tab.id);
              }}
              onDragLeave={() => setOverId((id) => (id === tab.id ? null : id))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId !== null && dragId !== tab.id) {
                  onMove?.(
                    dragId,
                    tabs.findIndex((t) => t.id === tab.id),
                  );
                }
                setDragId(null);
                setOverId(null);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              onContextMenu={(e) => {
                if (!hasMenu) return;
                e.preventDefault();
                setMenu({ id: tab.id, x: e.clientX, y: e.clientY });
              }}
              className={cn(
                "group flex items-center gap-1 rounded-t-md border border-b-0 px-2 py-1 text-sm",
                active
                  ? "border-neutral-700 bg-neutral-900 text-neutral-100"
                  : "border-transparent text-neutral-400 hover:bg-neutral-900/60",
                dragId === tab.id && "opacity-50",
                overId === tab.id && "border-l-sky-500",
              )}
            >
              {editingId === tab.id ? (
                <TitleEditor
                  initial={tab.title}
                  onCommit={(title) => {
                    setEditingId(null);
                    onRename?.(tab.id, title);
                  }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <button
                  role="tab"
                  aria-selected={active}
                  aria-describedby={statusId}
                  onClick={() => onActivate(tab.id)}
                  onDoubleClick={() => onRename && setEditingId(tab.id)}
                  className="flex max-w-48 items-center gap-2 truncate"
                >
                  <span
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full",
                      STATUS_DOT[tab.status],
                    )}
                    aria-hidden
                  />
                  <span className="truncate">{tab.title}</span>
                </button>
              )}
              <span id={statusId} className="sr-only">
                {STATUS_LABEL[tab.status]}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                aria-label={`${tab.title} を閉じる`}
                onClick={() => onClose(tab.id)}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          );
        })}
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label="新しい接続"
        onClick={onNew}
      >
        <Plus className="h-4 w-4" />
      </Button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.id)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

import { Plus, X } from "lucide-react";
import type { SessionStatus } from "../hooks/useTerminalSession";
import type { Tab } from "../lib/tabs";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

interface Props {
  tabs: Tab[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
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

export function TabBar({ tabs, activeId, onActivate, onClose, onNew }: Props) {
  return (
    <div className="flex items-center gap-1 border-b border-neutral-800 bg-neutral-950 px-2 pt-1">
      <div role="tablist" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          const statusId = `tab-status-${tab.id}`;
          return (
            <div
              key={tab.id}
              className={cn(
                "group flex items-center gap-1 rounded-t-md border border-b-0 px-2 py-1 text-sm",
                active
                  ? "border-neutral-700 bg-neutral-900 text-neutral-100"
                  : "border-transparent text-neutral-400 hover:bg-neutral-900/60",
              )}
            >
              <button
                role="tab"
                aria-selected={active}
                aria-describedby={statusId}
                onClick={() => onActivate(tab.id)}
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
    </div>
  );
}

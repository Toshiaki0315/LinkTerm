import type { SessionStatus } from "../hooks/useTerminalSession";
import type { Tab } from "../lib/tabs";
import type { Appearance } from "../lib/settings";
import { cn } from "../lib/utils";
import { TerminalTab } from "./TerminalTab";

interface Props {
  tabs: Tab[];
  activeId: string | null;
  onStatusChange: (id: string, status: SessionStatus) => void;
  onSecretsConsumed: (id: string) => void;
  onEditAndReconnect: (id: string) => void;
  appearance?: Appearance;
}

/** 非アクティブなタブもアンマウントせず `hidden` で隠す（セッションと表示内容を保持）。 */
export function TerminalWorkspace({
  tabs,
  activeId,
  onStatusChange,
  onSecretsConsumed,
  onEditAndReconnect,
  appearance,
}: Props) {
  if (tabs.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-neutral-500">
        「＋」から新しい接続を開始してください
      </div>
    );
  }
  return (
    <div className="relative flex-1">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={cn(
            "absolute inset-0 p-1",
            tab.id !== activeId && "hidden",
          )}
        >
          <TerminalTab
            tabId={tab.id}
            title={tab.title}
            values={tab.values}
            active={tab.id === activeId}
            onStatusChange={onStatusChange}
            onSecretsConsumed={onSecretsConsumed}
            onEditAndReconnect={onEditAndReconnect}
            appearance={appearance}
          />
        </div>
      ))}
    </div>
  );
}

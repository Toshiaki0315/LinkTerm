import type { SessionStatus } from "../hooks/useTerminalSession";
import type { Tab } from "../lib/tabs";
import type { Appearance, AutoReconnect } from "../lib/settings";
import { themeFor } from "../lib/themes";
import { cn } from "../lib/utils";
import { TerminalTab } from "./TerminalTab";

interface Props {
  tabs: Tab[];
  activeId: string | null;
  onStatusChange: (id: string, status: SessionStatus) => void;
  onSecretsConsumed: (id: string) => void;
  onEditAndReconnect: (id: string) => void;
  appearance?: Appearance;
  autoReconnect?: AutoReconnect;
  /** タブごとの検索要求の回数。増えたタブが検索バーを開く。 */
  findSignals?: Record<string, number>;
}

/** 非アクティブなタブもアンマウントせず `hidden` で隠す（セッションと表示内容を保持）。 */
export function TerminalWorkspace({
  tabs,
  activeId,
  onStatusChange,
  onSecretsConsumed,
  onEditAndReconnect,
  appearance,
  autoReconnect,
  findSignals,
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
          style={{ backgroundColor: themeFor(appearance?.theme).background }}
          className={cn(
            "absolute inset-0 p-1",
            tab.id !== activeId && "hidden",
          )}
        >
          <TerminalTab
            tabId={tab.id}
            title={tab.title}
            deferStart={tab.deferStart}
            values={tab.values}
            active={tab.id === activeId}
            onStatusChange={onStatusChange}
            onSecretsConsumed={onSecretsConsumed}
            onEditAndReconnect={onEditAndReconnect}
            appearance={appearance}
            autoReconnect={autoReconnect}
            findSignal={findSignals?.[tab.id] ?? 0}
          />
        </div>
      ))}
    </div>
  );
}

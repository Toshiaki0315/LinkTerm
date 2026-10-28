import type { PointerEvent as ReactPointerEvent } from "react";
import type { SessionStatus } from "../hooks/useTerminalSession";
import { computeRects, type Divider, type SplitDir } from "../lib/layout";
import { activePaneIdOf, layoutOf, panesOf, type Tab } from "../lib/tabs";
import type { Appearance, AutoReconnect } from "../lib/settings";
import type { HighlightRule } from "../lib/highlight";
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
  /** ペインごとの検索要求の回数。増えたペインが検索バーを開く。 */
  findSignals?: Record<string, number>;
  /** 各行に時刻を表示するペイン。 */
  timestamps?: ReadonlySet<string>;
  onToggleTimestamps?: (paneId: string) => void;
  /** キー入力・貼り付けの同時入力（ペインの ID と入力）。 */
  onBroadcast?: (paneId: string, data: string) => void;
  /** キーワードのハイライト規則。 */
  highlightRules?: HighlightRule[];
  /** 通知する規則に一致したが、見えていないタブ（タブの注目表示用）。 */
  onAttention?: (tabId: string) => void;
  onActivatePane?: (tabId: string, paneId: string) => void;
  onResizeSplit?: (tabId: string, splitId: string, ratio: number) => void;
  onSplit?: (tabId: string, dir: SplitDir) => void;
  onClosePane?: (tabId: string, paneId: string) => void;
}

/** 分割の境目の、つかみやすさのための幅（px）。 */
const DIVIDER_PX = 6;

/**
 * 非アクティブなタブもアンマウントせず `hidden` で隠す（セッションと表示内容を保持）。
 * ペインは入れ子にせず、同じ階層に並べて位置だけを割合で指定する（分割・統合でセッションが作り直されない）。
 */
export function TerminalWorkspace({
  tabs,
  activeId,
  onStatusChange,
  onSecretsConsumed,
  onEditAndReconnect,
  appearance,
  autoReconnect,
  findSignals,
  highlightRules,
  timestamps,
  onToggleTimestamps,
  onAttention,
  onBroadcast,
  onActivatePane,
  onResizeSplit,
  onSplit,
  onClosePane,
}: Props) {
  if (tabs.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-neutral-500">
        「＋」から新しい接続を開始してください
      </div>
    );
  }

  const startDrag = (
    e: ReactPointerEvent<HTMLDivElement>,
    tabId: string,
    divider: Divider,
  ) => {
    const area = e.currentTarget.parentElement;
    if (!area || !onResizeSplit) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      const box = area.getBoundingClientRect();
      const global =
        divider.dir === "row"
          ? ((ev.clientX - box.left) / box.width) * 100
          : ((ev.clientY - box.top) / box.height) * 100;
      const start = divider.dir === "row" ? divider.rect.x : divider.rect.y;
      const size = divider.dir === "row" ? divider.rect.w : divider.rect.h;
      onResizeSplit(tabId, divider.splitId, (global - start) / size);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="relative flex-1">
      {tabs.map((tab) => {
        const panes = panesOf(tab);
        const multi = panes.length > 1;
        const { panes: rects, dividers } = computeRects(layoutOf(tab));
        const activePane = activePaneIdOf(tab);
        return (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            style={{ backgroundColor: themeFor(appearance?.theme).background }}
            className={cn(
              "absolute inset-0 p-1",
              tab.id !== activeId && "hidden",
            )}
          >
            <div className="relative h-full w-full">
              {panes.map((pane) => {
                const r = rects[pane.id];
                return (
                  <div
                    key={pane.id}
                    data-pane-id={pane.id}
                    style={{
                      left: `${r.x}%`,
                      top: `${r.y}%`,
                      width: `${r.w}%`,
                      height: `${r.h}%`,
                    }}
                    className={cn(
                      "absolute",
                      multi && "box-border p-0.5",
                      multi &&
                        pane.id === activePane &&
                        "ring-1 ring-inset ring-sky-500/70",
                    )}
                    onMouseDownCapture={() => onActivatePane?.(tab.id, pane.id)}
                  >
                    <TerminalTab
                      tabId={pane.id}
                      title={tab.title}
                      deferStart={pane.deferStart}
                      values={pane.values}
                      active={tab.id === activeId && pane.id === activePane}
                      onStatusChange={onStatusChange}
                      onSecretsConsumed={onSecretsConsumed}
                      onEditAndReconnect={onEditAndReconnect}
                      appearance={appearance}
                      autoReconnect={autoReconnect}
                      findSignal={findSignals?.[pane.id] ?? 0}
                      highlightRules={highlightRules}
                      showTimestamps={timestamps?.has(pane.id) ?? false}
                      onToggleTimestamps={
                        onToggleTimestamps &&
                        (() => onToggleTimestamps(pane.id))
                      }
                      onBroadcast={
                        onBroadcast && ((data) => onBroadcast(pane.id, data))
                      }
                      onAttention={onAttention && (() => onAttention(tab.id))}
                      onSplit={onSplit && ((dir) => onSplit(tab.id, dir))}
                      onClosePane={
                        multi && onClosePane
                          ? () => onClosePane(tab.id, pane.id)
                          : undefined
                      }
                    />
                  </div>
                );
              })}
              {dividers.map((d) => {
                const row = d.dir === "row";
                const pos = row
                  ? d.rect.x + d.rect.w * d.ratio
                  : d.rect.y + d.rect.h * d.ratio;
                return (
                  <div
                    key={d.splitId}
                    role="separator"
                    aria-orientation={row ? "vertical" : "horizontal"}
                    aria-label="分割の境目（ドラッグで大きさを変更）"
                    onPointerDown={(e) => startDrag(e, tab.id, d)}
                    style={
                      row
                        ? {
                            left: `${pos}%`,
                            top: `${d.rect.y}%`,
                            height: `${d.rect.h}%`,
                            width: DIVIDER_PX,
                            transform: "translateX(-50%)",
                          }
                        : {
                            top: `${pos}%`,
                            left: `${d.rect.x}%`,
                            width: `${d.rect.w}%`,
                            height: DIVIDER_PX,
                            transform: "translateY(-50%)",
                          }
                    }
                    className={cn(
                      "absolute z-20 bg-neutral-700/60 hover:bg-sky-500/70",
                      row ? "cursor-col-resize" : "cursor-row-resize",
                    )}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

import { panesOf, type Tab } from "./tabs";

/** 同時入力の範囲。 */
export type BroadcastMode = "off" | "tab" | "all";

export const BROADCAST_LABELS: Record<BroadcastMode, string> = {
  off: "オフ",
  tab: "このタブの全ペイン",
  all: "すべてのタブの全ペイン",
};

/**
 * 入力の送り先になるペイン（入力したペイン自身は含めない）。
 * `tab` は入力したペインと同じタブ、`all` は全タブ。
 */
export function broadcastTargets(
  tabs: Tab[],
  sourcePaneId: string,
  mode: BroadcastMode,
): string[] {
  if (mode === "off") return [];
  const owner = tabs.find((t) => panesOf(t).some((p) => p.id === sourcePaneId));
  if (!owner) return [];
  const scope = mode === "tab" ? [owner] : tabs;
  return scope
    .flatMap((t) => panesOf(t).map((p) => p.id))
    .filter((id) => id !== sourcePaneId);
}

/** 同時入力が届くペインの数（操作中のペインを含む。バナーの表示用）。 */
export function broadcastPaneCount(
  tabs: Tab[],
  activeTabId: string | null,
  mode: BroadcastMode,
): number {
  if (mode === "off") return 0;
  const scope =
    mode === "tab" ? tabs.filter((t) => t.id === activeTabId) : tabs;
  return scope.reduce((n, t) => n + panesOf(t).length, 0);
}

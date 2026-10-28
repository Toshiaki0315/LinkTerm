import {
  stripSecrets,
  type ConnectionValues,
  parseSavedValues,
} from "./connection-schema";
import type { LayoutNode } from "./layout";
import type { SavedTab } from "./terminal-api";
import { activePaneIdOf, layoutOf, panesOf, type Tab } from "./tabs";

/** 読み込む分割の深さの上限（壊れた・悪意ある保存データで、深い木を作らせない）。 */
const MAX_DEPTH = 16;
const MAX_PANES = 16;

/** 保存用の ID（`p0`, `p1`, ...）。保存のたびに付け直す。 */
const savedId = (index: number) => `p${index}`;

/** タブを、保存する形にする（秘密情報は除く）。分割していなければ、これまでと同じ形。 */
export function serializeTab(tab: Tab): SavedTab {
  const panes = panesOf(tab);
  if (!tab.panes && panes.length === 1) {
    return { title: tab.title, values: stripSecrets(tab.values) };
  }
  const index = new Map(panes.map((p, i) => [p.id, i]));
  const rename = (node: LayoutNode): LayoutNode =>
    node.kind === "pane"
      ? { kind: "pane", id: savedId(index.get(node.id) ?? 0) }
      : { ...node, a: rename(node.a), b: rename(node.b) };
  return {
    title: tab.title,
    values: stripSecrets(panes[0].values),
    panes: panes.map((p, i) => ({
      id: savedId(i),
      values: stripSecrets(p.values),
    })),
    layout: rename(layoutOf(tab)),
    activePane: savedId(index.get(activePaneIdOf(tab)) ?? 0),
  };
}

/** 復元する分割（新しいペイン ID つき）。 */
export interface RestoredSplit {
  panes: Array<{ id: string; values: ConnectionValues }>;
  layout: LayoutNode;
  activePaneId: string;
}

/** 保存された配置を検証して、新しい ID の木にする。形が正しくなければ `null`。 */
function readLayout(
  raw: unknown,
  ids: Map<string, string>,
  used: Set<string>,
  newSplitId: () => string,
  depth = 0,
): LayoutNode | null {
  if (depth > MAX_DEPTH || typeof raw !== "object" || raw === null) return null;
  const node = raw as Record<string, unknown>;
  if (node.kind === "pane") {
    const mapped = typeof node.id === "string" ? ids.get(node.id) : undefined;
    // 存在しないペイン、同じペインの二重参照は不正。
    if (!mapped || used.has(mapped)) return null;
    used.add(mapped);
    return { kind: "pane", id: mapped };
  }
  if (node.kind === "split") {
    const dir = node.dir;
    const ratio = node.ratio;
    if (dir !== "row" && dir !== "column") return null;
    if (typeof ratio !== "number" || !Number.isFinite(ratio)) return null;
    const a = readLayout(node.a, ids, used, newSplitId, depth + 1);
    const b = a && readLayout(node.b, ids, used, newSplitId, depth + 1);
    if (!a || !b) return null;
    return {
      kind: "split",
      id: newSplitId(),
      dir,
      ratio: Math.min(0.9, Math.max(0.1, ratio)),
      a,
      b,
    };
  }
  return null;
}

/**
 * 保存されたタブから、分割の情報を読む。分割していない・読めない・不正なときは `null`
 * （呼び出し側は、先頭のペインだけのタブとして復元する）。
 */
export function readSplit(
  saved: SavedTab,
  newId: () => string = () => crypto.randomUUID(),
): RestoredSplit | null {
  if (
    !saved.panes ||
    saved.panes.length < 2 ||
    saved.panes.length > MAX_PANES
  ) {
    return null;
  }
  const ids = new Map<string, string>();
  const panes: RestoredSplit["panes"] = [];
  for (const p of saved.panes) {
    if (typeof p.id !== "string" || ids.has(p.id)) return null;
    const values = parseSavedValues(p.values);
    if (!values) return null;
    const id = newId();
    ids.set(p.id, id);
    panes.push({ id, values });
  }
  const used = new Set<string>();
  const layout = readLayout(saved.layout, ids, used, newId);
  // すべてのペインが、配置にちょうど1回ずつ現れること。
  if (!layout || used.size !== panes.length) return null;
  const active =
    typeof saved.activePane === "string"
      ? ids.get(saved.activePane)
      : undefined;
  return { panes, layout, activePaneId: active ?? panes[0].id };
}

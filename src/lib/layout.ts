/** 画面分割のレイアウト。葉がペイン（セッション）、節が分割。 */
export type SplitDir = "row" | "column";

export type LayoutNode =
  | { kind: "pane"; id: string }
  | {
      kind: "split";
      id: string;
      /** `row` は左右（a が左）、`column` は上下（a が上）。 */
      dir: SplitDir;
      /** a が占める割合。 */
      ratio: number;
      a: LayoutNode;
      b: LayoutNode;
    };

/** 親に対する割合（%）で表した矩形。 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Divider {
  splitId: string;
  dir: SplitDir;
  /** この分割全体の矩形。境目の位置と、ドラッグ量の換算に使う。 */
  rect: Rect;
  ratio: number;
}

export const MIN_RATIO = 0.1;
export const MAX_RATIO = 0.9;

/** 左上から順に並べたペイン ID。 */
export function paneIds(node: LayoutNode): string[] {
  return node.kind === "pane"
    ? [node.id]
    : [...paneIds(node.a), ...paneIds(node.b)];
}

/** `paneId` の葉を分割し、元のペインを a、新しいペインを b にする。 */
export function splitLeaf(
  node: LayoutNode,
  paneId: string,
  dir: SplitDir,
  newPaneId: string,
  splitId: string,
): LayoutNode {
  if (node.kind === "pane") {
    return node.id === paneId
      ? {
          kind: "split",
          id: splitId,
          dir,
          ratio: 0.5,
          a: node,
          b: { kind: "pane", id: newPaneId },
        }
      : node;
  }
  const a = splitLeaf(node.a, paneId, dir, newPaneId, splitId);
  const b = splitLeaf(node.b, paneId, dir, newPaneId, splitId);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/** 葉を取り除く。兄弟が親の場所を引き継ぐ。最後の1つなら `null`。 */
export function removeLeaf(
  node: LayoutNode,
  paneId: string,
): LayoutNode | null {
  if (node.kind === "pane") return node.id === paneId ? null : node;
  const a = removeLeaf(node.a, paneId);
  const b = removeLeaf(node.b, paneId);
  if (a === null) return b;
  if (b === null) return a;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/** 分割の比率を変える。範囲に収め、数値でなければ変えない。 */
export function setRatio(
  node: LayoutNode,
  splitId: string,
  ratio: number,
): LayoutNode {
  if (node.kind === "pane" || Number.isNaN(ratio)) return node;
  if (node.id === splitId) {
    const next = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
    return next === node.ratio ? node : { ...node, ratio: next };
  }
  const a = setRatio(node.a, splitId, ratio);
  const b = setRatio(node.b, splitId, ratio);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/** 各ペインの矩形（%）と、境目の一覧を求める。 */
export function computeRects(
  node: LayoutNode,
  rect: Rect = { x: 0, y: 0, w: 100, h: 100 },
): { panes: Record<string, Rect>; dividers: Divider[] } {
  if (node.kind === "pane") return { panes: { [node.id]: rect }, dividers: [] };
  const first: Rect =
    node.dir === "row"
      ? { ...rect, w: rect.w * node.ratio }
      : { ...rect, h: rect.h * node.ratio };
  const second: Rect =
    node.dir === "row"
      ? { ...rect, x: rect.x + first.w, w: rect.w - first.w }
      : { ...rect, y: rect.y + first.h, h: rect.h - first.h };
  const a = computeRects(node.a, first);
  const b = computeRects(node.b, second);
  return {
    panes: { ...a.panes, ...b.panes },
    dividers: [
      { splitId: node.id, dir: node.dir, rect, ratio: node.ratio },
      ...a.dividers,
      ...b.dividers,
    ],
  };
}

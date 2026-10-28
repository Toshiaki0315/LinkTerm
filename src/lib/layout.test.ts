import { describe, expect, it } from "vitest";
import {
  computeRects,
  paneIds,
  removeLeaf,
  setRatio,
  splitLeaf,
  type LayoutNode,
} from "./layout";

const leaf = (id: string): LayoutNode => ({ kind: "pane", id });

describe("splitLeaf", () => {
  it("葉を分割し、元のペインを前（左／上）、新しいペインを後ろに置く", () => {
    const next = splitLeaf(leaf("a"), "a", "row", "b", "s1");
    expect(next).toEqual({
      kind: "split",
      id: "s1",
      dir: "row",
      ratio: 0.5,
      a: leaf("a"),
      b: leaf("b"),
    });
  });

  it("入れ子の葉も分割できる。存在しないペインなら変えない", () => {
    const root = splitLeaf(leaf("a"), "a", "row", "b", "s1");
    const next = splitLeaf(root, "b", "column", "c", "s2");
    expect(paneIds(next)).toEqual(["a", "b", "c"]);
    expect(splitLeaf(root, "zzz", "row", "c", "s2")).toBe(root);
  });
});

describe("removeLeaf", () => {
  it("消すと兄弟が親の場所を引き継ぐ", () => {
    let root = splitLeaf(leaf("a"), "a", "row", "b", "s1");
    root = splitLeaf(root, "b", "column", "c", "s2");
    const next = removeLeaf(root, "b");
    expect(paneIds(next!)).toEqual(["a", "c"]);
    expect(next).toMatchObject({ kind: "split", id: "s1" });
  });

  it("最後の1つを消すと null", () => {
    expect(removeLeaf(leaf("a"), "a")).toBeNull();
  });

  it("存在しないペインなら変えない", () => {
    const root = splitLeaf(leaf("a"), "a", "row", "b", "s1");
    expect(removeLeaf(root, "x")).toBe(root);
  });
});

describe("setRatio", () => {
  it("比率を変える。範囲（0.1〜0.9）に収める", () => {
    const root = splitLeaf(leaf("a"), "a", "row", "b", "s1");
    expect(setRatio(root, "s1", 0.3)).toMatchObject({ ratio: 0.3 });
    expect(setRatio(root, "s1", 0)).toMatchObject({ ratio: 0.1 });
    expect(setRatio(root, "s1", 5)).toMatchObject({ ratio: 0.9 });
    expect(setRatio(root, "s1", NaN)).toBe(root);
    expect(setRatio(root, "nope", 0.3)).toBe(root);
  });
});

describe("computeRects", () => {
  it("1ペインは全面", () => {
    const { panes, dividers } = computeRects(leaf("a"));
    expect(panes).toEqual({ a: { x: 0, y: 0, w: 100, h: 100 } });
    expect(dividers).toEqual([]);
  });

  it("左右分割は幅を比率で分け、境目の位置を返す", () => {
    let root = splitLeaf(leaf("a"), "a", "row", "b", "s1");
    root = setRatio(root, "s1", 0.25);
    const { panes, dividers } = computeRects(root);
    expect(panes.a).toEqual({ x: 0, y: 0, w: 25, h: 100 });
    expect(panes.b).toEqual({ x: 25, y: 0, w: 75, h: 100 });
    expect(dividers).toEqual([
      {
        splitId: "s1",
        dir: "row",
        rect: { x: 0, y: 0, w: 100, h: 100 },
        ratio: 0.25,
      },
    ]);
  });

  it("上下分割と入れ子", () => {
    let root = splitLeaf(leaf("a"), "a", "row", "b", "s1");
    root = splitLeaf(root, "b", "column", "c", "s2");
    const { panes, dividers } = computeRects(root);
    expect(panes.b).toEqual({ x: 50, y: 0, w: 50, h: 50 });
    expect(panes.c).toEqual({ x: 50, y: 50, w: 50, h: 50 });
    expect(dividers.map((d) => d.splitId)).toEqual(["s1", "s2"]);
  });
});

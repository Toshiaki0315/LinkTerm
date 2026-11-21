import { describe, expect, it, vi } from "vitest";
import {
  getPaneMenu,
  getRecordingPaneIds,
  menuSignature,
  publishPaneMenu,
  subscribePaneMenus,
  type PaneMenu,
} from "./pane-menu";

const menu = (over: Partial<PaneMenu> = {}): PaneMenu => ({
  items: [{ label: "検索…", onSelect: () => {} }],
  recording: false,
  ...over,
});

describe("pane-menu", () => {
  it("公開したメニューを取り出せ、解除すると取り出せない", () => {
    const off = publishPaneMenu("p1", menu());
    expect(getPaneMenu("p1")?.items[0].label).toBe("検索…");
    expect(getPaneMenu("none")).toBeUndefined();
    off();
    expect(getPaneMenu("p1")).toBeUndefined();
  });

  it("公開・解除のたびに購読者へ知らせる。購読を解除すると知らせない", () => {
    const cb = vi.fn();
    const unsubscribe = subscribePaneMenus(cb);
    const off = publishPaneMenu("p2", menu());
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    expect(cb).toHaveBeenCalledTimes(2);
    unsubscribe();
    publishPaneMenu("p2", menu())();
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("後から同じ ID で公開したものを、古い解除が消さない", () => {
    const first = publishPaneMenu("p3", menu({ recording: false }));
    const second = publishPaneMenu("p3", menu({ recording: true }));
    first();
    expect(getPaneMenu("p3")?.recording).toBe(true);
    second();
  });

  it("同じメニューを取り出すと、同じ参照が返る（再描画の無限ループを避ける）", () => {
    const off = publishPaneMenu("p4", menu());
    expect(getPaneMenu("p4")).toBe(getPaneMenu("p4"));
    off();
  });

  it("menuSignature: 見た目が同じなら同じ文字列。関数の違いは無視し、ラベル・状態の違いは区別する", () => {
    const a = menuSignature(menu());
    expect(menuSignature(menu())).toBe(a);
    expect(
      menuSignature(
        menu({ items: [{ label: "検索…", onSelect: () => console.log("x") }] }),
      ),
    ).toBe(a);
    expect(menuSignature(menu({ recording: true }))).not.toBe(a);
    expect(
      menuSignature(
        menu({
          items: [{ label: "検索…", onSelect: () => {}, disabled: true }],
        }),
      ),
    ).not.toBe(a);
    expect(
      menuSignature(
        menu({
          items: [{ label: "検索…", onSelect: () => {}, checked: false }],
        }),
      ),
    ).not.toBe(
      menuSignature(
        menu({
          items: [{ label: "検索…", onSelect: () => {}, checked: true }],
        }),
      ),
    );
  });

  it("記録中のペインの ID の集合を取り出せる。公開・解除で更新し、変わらなければ同じ参照", () => {
    const none = getRecordingPaneIds();
    expect(getRecordingPaneIds()).toBe(none);
    const offA = publishPaneMenu("ra", menu({ recording: true }));
    const offB = publishPaneMenu("rb", menu({ recording: false }));
    const some = getRecordingPaneIds();
    expect([...some]).toContain("ra");
    expect([...some]).not.toContain("rb");
    expect(getRecordingPaneIds()).toBe(some);
    offA();
    expect([...getRecordingPaneIds()]).not.toContain("ra");
    offB();
  });
});

import { describe, expect, it } from "vitest";
import { initialTabsState, tabsReducer, type TabsState } from "./tabs";

const local = { type: "local", encoding: "UTF-8" } as const;
const add = (s: TabsState, id: string) =>
  tabsReducer(s, { type: "add", tab: { id, title: id, values: local } });

describe("tabsReducer", () => {
  it("初期状態は空でアクティブなし", () => {
    expect(initialTabsState).toEqual({ tabs: [], activeId: null });
  });

  it("追加したタブがアクティブになる", () => {
    let s = add(initialTabsState, "a");
    s = add(s, "b");
    expect(s.tabs.map((t) => t.id)).toEqual(["a", "b"]);
    expect(s.activeId).toBe("b");
    expect(s.tabs[0].status).toBe("connecting");
  });

  it("activate は存在するIDのみ受け付ける", () => {
    let s = add(add(initialTabsState, "a"), "b");
    s = tabsReducer(s, { type: "activate", id: "a" });
    expect(s.activeId).toBe("a");
    expect(tabsReducer(s, { type: "activate", id: "zzz" })).toBe(s);
  });

  it("アクティブなタブを閉じると右隣、なければ左隣がアクティブ", () => {
    let s = add(add(add(initialTabsState, "a"), "b"), "c");
    s = tabsReducer(s, { type: "activate", id: "b" });
    s = tabsReducer(s, { type: "close", id: "b" });
    expect(s.activeId).toBe("c");
    s = tabsReducer(s, { type: "close", id: "c" });
    expect(s.activeId).toBe("a");
    s = tabsReducer(s, { type: "close", id: "a" });
    expect(s).toEqual({ tabs: [], activeId: null });
  });

  it("非アクティブなタブを閉じてもアクティブは変わらない", () => {
    let s = add(add(initialTabsState, "a"), "b");
    s = tabsReducer(s, { type: "close", id: "a" });
    expect(s.activeId).toBe("b");
    expect(s.tabs).toHaveLength(1);
  });

  it("存在しないIDの close は何もしない", () => {
    const s = add(initialTabsState, "a");
    expect(tabsReducer(s, { type: "close", id: "x" })).toBe(s);
  });

  it("setStatus は対象タブだけ更新する", () => {
    let s = add(add(initialTabsState, "a"), "b");
    s = tabsReducer(s, { type: "setStatus", id: "a", status: "connected" });
    expect(s.tabs.map((t) => t.status)).toEqual(["connected", "connecting"]);
    const same = tabsReducer(s, {
      type: "setStatus",
      id: "a",
      status: "connected",
    });
    expect(same).toBe(s);
  });
});

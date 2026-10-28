import { describe, expect, it } from "vitest";
import { broadcastPaneCount, broadcastTargets } from "./broadcast";
import { initialTabsState, tabsReducer, type TabsState } from "./tabs";

const local = { type: "local", encoding: "UTF-8" } as const;

/** タブ a（ペイン a, a2）とタブ b（ペイン b）。 */
function state(): TabsState {
  let s = tabsReducer(initialTabsState, {
    type: "add",
    tab: { id: "a", title: "a", values: local },
  });
  s = tabsReducer(s, {
    type: "splitPane",
    tabId: "a",
    dir: "row",
    splitId: "sp",
    pane: { id: "a2", values: local },
  });
  return tabsReducer(s, {
    type: "add",
    tab: { id: "b", title: "b", values: local },
  });
}

describe("broadcastTargets", () => {
  it("オフなら、送り先なし", () => {
    expect(broadcastTargets(state().tabs, "a", "off")).toEqual([]);
  });

  it("tab: 同じタブの、ほかのペインだけ", () => {
    expect(broadcastTargets(state().tabs, "a", "tab")).toEqual(["a2"]);
    expect(broadcastTargets(state().tabs, "a2", "tab")).toEqual(["a"]);
    expect(broadcastTargets(state().tabs, "b", "tab")).toEqual([]);
  });

  it("all: 全タブの、入力したペイン以外", () => {
    expect(broadcastTargets(state().tabs, "a", "all")).toEqual(["a2", "b"]);
    expect(broadcastTargets(state().tabs, "b", "all")).toEqual(["a", "a2"]);
  });

  it("入力元が見つからなければ、送り先なし", () => {
    expect(broadcastTargets(state().tabs, "zzz", "all")).toEqual([]);
  });
});

describe("broadcastPaneCount", () => {
  it("範囲に入るペインの数（操作中のペインを含む）", () => {
    const { tabs } = state();
    expect(broadcastPaneCount(tabs, "a", "off")).toBe(0);
    expect(broadcastPaneCount(tabs, "a", "tab")).toBe(2);
    expect(broadcastPaneCount(tabs, "b", "tab")).toBe(1);
    expect(broadcastPaneCount(tabs, "a", "all")).toBe(3);
    expect(broadcastPaneCount(tabs, null, "tab")).toBe(0);
  });
});

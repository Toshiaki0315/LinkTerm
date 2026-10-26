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

  const abc = () => add(add(add(initialTabsState, "a"), "b"), "c");

  it("activateIndex: 番号指定と最後のタブ、範囲外は無視", () => {
    let s = abc();
    s = tabsReducer(s, { type: "activateIndex", index: 0 });
    expect(s.activeId).toBe("a");
    s = tabsReducer(s, { type: "activateIndex", index: "last" });
    expect(s.activeId).toBe("c");
    const same = tabsReducer(s, { type: "activateIndex", index: 7 });
    expect(same).toBe(s);
    expect(
      tabsReducer(initialTabsState, { type: "activateIndex", index: "last" }),
    ).toBe(initialTabsState);
  });

  it("activateRelative: 次・前に循環移動する", () => {
    let s = abc(); // active = c
    s = tabsReducer(s, { type: "activateRelative", delta: 1 });
    expect(s.activeId).toBe("a");
    s = tabsReducer(s, { type: "activateRelative", delta: -1 });
    expect(s.activeId).toBe("c");
    s = tabsReducer(s, { type: "activateRelative", delta: -1 });
    expect(s.activeId).toBe("b");
    expect(
      tabsReducer(initialTabsState, { type: "activateRelative", delta: 1 }),
    ).toBe(initialTabsState);
  });

  it("scrubSecrets: SSHのパスワードとパスフレーズだけを消す", () => {
    const sshValues = {
      type: "ssh",
      encoding: "UTF-8",
      host: "h",
      port: 22,
      username: "u",
      authKind: "password",
      password: "secret",
      remember: false,
      keyPath: "/k",
      passphrase: "pp",
    } as const;
    let s = tabsReducer(initialTabsState, {
      type: "add",
      tab: { id: "a", title: "a", values: sshValues },
    });
    s = tabsReducer(s, { type: "scrubSecrets", id: "a" });
    expect(s.tabs[0].values).toEqual({
      ...sshValues,
      password: "",
      passphrase: "",
    });
  });

  it("scrubSecrets: SSH以外・対象なしは何も変えない", () => {
    const s = add(initialTabsState, "a");
    expect(tabsReducer(s, { type: "scrubSecrets", id: "a" })).toBe(s);
    expect(tabsReducer(s, { type: "scrubSecrets", id: "zzz" })).toBe(s);
  });
});

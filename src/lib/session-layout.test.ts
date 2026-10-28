import { describe, expect, it } from "vitest";
import { paneIds } from "./layout";
import { readSplit, serializeTab } from "./session-layout";
import {
  activePaneIdOf,
  initialTabsState,
  tabsReducer,
  type Tab,
} from "./tabs";
import type { SavedTab } from "./terminal-api";

const local = { type: "local", encoding: "UTF-8" } as const;
const telnet = {
  type: "telnet",
  encoding: "UTF-8",
  termType: "xterm-256color",
  localEcho: "auto",
  host: "r",
  port: 23,
  txNewline: "Cr",
  rxNewline: "Raw",
  loginScript: "",
  loginPassword: "",
} as const;

function splitTab(): Tab {
  let s = tabsReducer(initialTabsState, {
    type: "add",
    tab: { id: "a", title: "分割", values: local },
  });
  s = tabsReducer(s, {
    type: "splitPane",
    tabId: "a",
    dir: "row",
    splitId: "s1",
    pane: { id: "u-2", values: telnet },
  });
  s = tabsReducer(s, {
    type: "splitPane",
    tabId: "a",
    dir: "column",
    splitId: "s2",
    pane: { id: "u-3", values: local },
  });
  return s.tabs[0];
}

let counter = 0;
const nextId = () => `n${counter++}`;

describe("serializeTab", () => {
  it("分割していないタブは、これまでと同じ形（分割の項目なし）", () => {
    const tab: Tab = {
      id: "a",
      title: "t",
      values: local,
      status: "connected",
    };
    expect(serializeTab(tab)).toEqual({ title: "t", values: local });
  });

  it("分割したタブは、ペインの ID を付け直し、配置と操作中のペインを保存する。パスワードは含めない", () => {
    const tab = splitTab();
    const withSecret = {
      ...tab,
      panes: tab.panes!.map((p) =>
        p.id === "u-2"
          ? {
              ...p,
              values: {
                ...telnet,
                loginScript: "P: => {password}",
                loginPassword: "secret",
              },
            }
          : p,
      ),
    } as Tab;
    const saved = serializeTab(withSecret);
    expect(saved.panes!.map((p) => p.id)).toEqual(["p0", "p1", "p2"]);
    expect(JSON.stringify(saved)).not.toContain("secret");
    expect(JSON.stringify(saved)).not.toContain("u-2");
    expect(paneIds(saved.layout as never)).toEqual(["p0", "p1", "p2"]);
    expect(saved.activePane).toBe("p2");
    expect(saved.values).toEqual(local);
  });
});

describe("readSplit", () => {
  it("serializeTab で保存したものを、新しい ID で復元できる（配置・操作中のペインを保つ）", () => {
    counter = 0;
    const tab = splitTab();
    const restored = readSplit(serializeTab(tab), nextId)!;
    expect(restored).not.toBeNull();
    expect(restored.panes.map((p) => p.values.type)).toEqual([
      "local",
      "telnet",
      "local",
    ]);
    expect(paneIds(restored.layout)).toEqual(restored.panes.map((p) => p.id));
    expect(restored.activePaneId).toBe(restored.panes[2].id);
    expect(restored.layout).toMatchObject({ kind: "split", dir: "row" });
    // 元のタブの ID は引き継がない。
    expect(restored.panes.map((p) => p.id)).not.toContain("u-2");
    expect(activePaneIdOf(tab)).toBe("u-3");
  });

  it("分割していない・ペインが1つ以下のタブは null", () => {
    expect(readSplit({ title: "t", values: local })).toBeNull();
    expect(
      readSplit({
        title: "t",
        values: local,
        panes: [{ id: "p0", values: local }],
      }),
    ).toBeNull();
  });

  const base = (): SavedTab => serializeTab(splitTab());

  it("不正な保存データ（読めない接続・ID の重複・配置の不整合・深すぎる木）は null", () => {
    const bad: SavedTab[] = [];
    let s = base();
    s.panes![1].values = { type: "nonsense" };
    bad.push(s);
    s = base();
    s.panes![1].id = "p0";
    bad.push(s);
    s = base();
    s.layout = undefined;
    bad.push(s);
    s = base();
    s.layout = { kind: "pane", id: "p0" }; // 1つしか参照していない
    bad.push(s);
    s = base();
    s.layout = {
      kind: "split",
      id: "x",
      dir: "row",
      ratio: 0.5,
      a: { kind: "pane", id: "p0" },
      b: { kind: "pane", id: "p0" }, // 二重参照
    };
    bad.push(s);
    s = base();
    s.layout = {
      kind: "split",
      id: "x",
      dir: "diagonal",
      ratio: 0.5,
      a: { kind: "pane", id: "p0" },
      b: { kind: "pane", id: "p1" },
    };
    bad.push(s);
    // 深すぎる木
    let deep: unknown = { kind: "pane", id: "p0" };
    for (let i = 0; i < 40; i += 1) {
      deep = {
        kind: "split",
        id: `d${i}`,
        dir: "row",
        ratio: 0.5,
        a: deep,
        b: { kind: "pane", id: "p1" },
      };
    }
    s = base();
    s.layout = deep;
    bad.push(s);
    for (const saved of bad) expect(readSplit(saved)).toBeNull();
  });

  it("比率は範囲内に収める。操作中のペインが見つからなければ先頭", () => {
    const saved = base();
    (saved.layout as { ratio: number }).ratio = 5;
    saved.activePane = "zzz";
    const restored = readSplit(saved)!;
    expect(restored.layout).toMatchObject({ ratio: 0.9 });
    expect(restored.activePaneId).toBe(restored.panes[0].id);
  });

  it("パスワード認証のSSHなど、秘密情報が要るペインも、空のまま読める", () => {
    const saved = base();
    saved.panes![1].values = {
      type: "ssh",
      host: "h",
      port: 22,
      username: "u",
      authKind: "password",
    };
    const restored = readSplit(saved)!;
    expect(restored.panes[1].values).toMatchObject({
      type: "ssh",
      password: "",
    });
  });
});

import { describe, expect, it } from "vitest";
import { paneIds } from "./layout";
import {
  activePaneIdOf,
  initialTabsState,
  layoutOf,
  panesOf,
  tabsReducer,
  type TabsState,
} from "./tabs";

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
      termType: "xterm-256color",
      host: "h",
      port: 22,
      username: "u",
      useSshConfig: true,
      jumpHosts: "",
      forwards: "",
      socksPorts: "",
      remoteForwards: "",
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

  it("add に afterId を付けると、そのタブの右隣へ挿入する", () => {
    let s = add(add(add(initialTabsState, "a"), "b"), "c");
    s = tabsReducer(s, {
      type: "add",
      afterId: "a",
      tab: { id: "x", title: "x", values: local },
    });
    expect(s.tabs.map((t) => t.id)).toEqual(["a", "x", "b", "c"]);
    expect(s.activeId).toBe("x");
    s = tabsReducer(s, {
      type: "add",
      afterId: "no-such-tab",
      tab: { id: "y", title: "y", values: local },
    });
    expect(s.tabs.map((t) => t.id)).toEqual(["a", "x", "b", "c", "y"]);
  });

  describe("rename", () => {
    it("タブ名を変更する（前後の空白は除く）", () => {
      let s = add(initialTabsState, "a");
      s = tabsReducer(s, {
        type: "rename",
        id: "a",
        title: "  本番サーバー  ",
      });
      expect(s.tabs[0].title).toBe("本番サーバー");
    });

    it("空・空白だけの名前、変化なし、存在しないタブは無視する", () => {
      const s = add(initialTabsState, "a");
      expect(tabsReducer(s, { type: "rename", id: "a", title: "" })).toBe(s);
      expect(tabsReducer(s, { type: "rename", id: "a", title: "   " })).toBe(s);
      expect(tabsReducer(s, { type: "rename", id: "a", title: "a" })).toBe(s);
      expect(tabsReducer(s, { type: "rename", id: "zzz", title: "x" })).toBe(s);
    });

    it("長すぎる名前は60文字に切り詰める", () => {
      const s = tabsReducer(add(initialTabsState, "a"), {
        type: "rename",
        id: "a",
        title: "あ".repeat(100),
      });
      expect([...s.tabs[0].title]).toHaveLength(60);
    });
  });

  describe("move（並べ替え）", () => {
    const abc = () => add(add(add(initialTabsState, "a"), "b"), "c");
    const order = (s: TabsState) => s.tabs.map((t) => t.id).join("");

    it("指定位置へ移動し、アクティブなタブは変わらない", () => {
      const s = abc();
      expect(s.activeId).toBe("c");
      expect(order(tabsReducer(s, { type: "move", id: "a", toIndex: 2 }))).toBe(
        "bca",
      );
      expect(order(tabsReducer(s, { type: "move", id: "c", toIndex: 0 }))).toBe(
        "cab",
      );
      expect(order(tabsReducer(s, { type: "move", id: "b", toIndex: 2 }))).toBe(
        "acb",
      );
      expect(
        tabsReducer(s, { type: "move", id: "a", toIndex: 2 }).activeId,
      ).toBe("c");
    });

    it("範囲外は端に丸める。同じ位置・存在しないタブは何もしない", () => {
      const s = abc();
      expect(
        order(tabsReducer(s, { type: "move", id: "a", toIndex: 99 })),
      ).toBe("bca");
      expect(
        order(tabsReducer(s, { type: "move", id: "c", toIndex: -5 })),
      ).toBe("cab");
      expect(tabsReducer(s, { type: "move", id: "b", toIndex: 1 })).toBe(s);
      expect(tabsReducer(s, { type: "move", id: "zzz", toIndex: 0 })).toBe(s);
    });
  });

  it("deferStart を指定したタブは、その印を保つ（復元したタブを自動接続しないため）", () => {
    const s = tabsReducer(initialTabsState, {
      type: "add",
      tab: { id: "a", title: "a", values: local, deferStart: true },
    });
    expect(s.tabs[0].deferStart).toBe(true);
    expect(add(initialTabsState, "b").tabs[0].deferStart).toBeUndefined();
  });

  it("setColor でタブの色を設定・解除できる。同じ色なら state を変えない", () => {
    let s = add(add(initialTabsState, "a"), "b");
    s = tabsReducer(s, { type: "setColor", id: "a", color: "red" });
    expect(s.tabs[0].values.tabColor).toBe("red");
    expect(s.tabs[1].values.tabColor).toBeUndefined();
    expect(tabsReducer(s, { type: "setColor", id: "a", color: "red" })).toBe(s);
    s = tabsReducer(s, { type: "setColor", id: "a", color: undefined });
    expect(s.tabs[0].values.tabColor).toBeUndefined();
    expect(tabsReducer(s, { type: "setColor", id: "zzz", color: "red" })).toBe(
      s,
    );
  });
});

describe("画面分割", () => {
  const split = (
    s: TabsState,
    paneId: string,
    dir: "row" | "column" = "row",
    splitId = `s-${paneId}`,
  ) =>
    tabsReducer(s, {
      type: "splitPane",
      tabId: "a",
      dir,
      splitId,
      pane: { id: paneId, values: local },
    });
  const base = () => add(initialTabsState, "a");

  it("分割すると新しいペインが操作対象になり、タブの表示項目は先頭ペインのまま", () => {
    const s = split(base(), "p2");
    const tab = s.tabs[0];
    expect(panesOf(tab).map((p) => p.id)).toEqual(["a", "p2"]);
    expect(tab.activePaneId).toBe("p2");
    expect(tab.layout).toMatchObject({ kind: "split", dir: "row" });
    expect(tab.values).toBe(panesOf(tab)[0].values);
    expect(s.activeId).toBe("a");
  });

  it("操作対象のペインを分割する（入れ子）", () => {
    let s = split(base(), "p2");
    s = split(s, "p3", "column");
    expect(paneIds(layoutOf(s.tabs[0]))).toEqual(["a", "p2", "p3"]);
    expect(s.tabs[0].layout).toMatchObject({
      b: { kind: "split", dir: "column" },
    });
  });

  it("ペインごとに状態を持つ。先頭ペインの状態はタブへ写る", () => {
    let s = split(base(), "p2");
    s = tabsReducer(s, { type: "setStatus", id: "p2", status: "connected" });
    expect(panesOf(s.tabs[0]).map((p) => p.status)).toEqual([
      "connecting",
      "connected",
    ]);
    expect(s.tabs[0].status).toBe("connecting");
    s = tabsReducer(s, { type: "setStatus", id: "a", status: "error" });
    expect(s.tabs[0].status).toBe("error");
  });

  it("ペインを閉じると兄弟が場所を引き継ぐ。先頭を閉じたら次が先頭になる", () => {
    let s = split(base(), "p2");
    s = split(s, "p3");
    s = tabsReducer(s, { type: "closePane", tabId: "a", paneId: "a" });
    expect(panesOf(s.tabs[0]).map((p) => p.id)).toEqual(["p2", "p3"]);
    expect(s.tabs[0].values).toBe(panesOf(s.tabs[0])[0].values);
    expect(paneIds(layoutOf(s.tabs[0]))).toEqual(["p2", "p3"]);
  });

  it("操作対象のペインを閉じたら近いペインへ移る", () => {
    let s = split(base(), "p2");
    s = tabsReducer(s, { type: "closePane", tabId: "a", paneId: "p2" });
    expect(s.tabs[0].panes).toBeUndefined();
    expect(s.tabs[0].layout).toBeUndefined();
    expect(activePaneIdOf(s.tabs[0])).toBe("a");
  });

  it("1つに戻したら、分割していないタブの形に戻る", () => {
    let s = split(base(), "p2");
    s = tabsReducer(s, { type: "closePane", tabId: "a", paneId: "p2" });
    expect(s.tabs[0]).toEqual({
      id: "a",
      title: "a",
      values: local,
      status: "connecting",
    });
  });

  it("最後の1ペインを閉じるとタブごと閉じる", () => {
    const s = tabsReducer(base(), {
      type: "closePane",
      tabId: "a",
      paneId: "a",
    });
    expect(s.tabs).toEqual([]);
  });

  it("先頭を閉じて1つ残ったとき、ペインの ID はタブと違っても描画に必要な情報を保つ", () => {
    let s = split(base(), "p2");
    s = tabsReducer(s, { type: "closePane", tabId: "a", paneId: "a" });
    expect(panesOf(s.tabs[0]).map((p) => p.id)).toEqual(["p2"]);
    expect(paneIds(layoutOf(s.tabs[0]))).toEqual(["p2"]);
  });

  it("activatePane / cyclePane で操作対象を切り替える", () => {
    let s = split(base(), "p2");
    s = tabsReducer(s, { type: "activatePane", tabId: "a", paneId: "a" });
    expect(activePaneIdOf(s.tabs[0])).toBe("a");
    s = tabsReducer(s, { type: "cyclePane", tabId: "a", delta: 1 });
    expect(activePaneIdOf(s.tabs[0])).toBe("p2");
    s = tabsReducer(s, { type: "cyclePane", tabId: "a", delta: 1 });
    expect(activePaneIdOf(s.tabs[0])).toBe("a");
    s = tabsReducer(s, { type: "cyclePane", tabId: "a", delta: -1 });
    expect(activePaneIdOf(s.tabs[0])).toBe("p2");
    expect(
      tabsReducer(s, { type: "activatePane", tabId: "a", paneId: "zzz" }),
    ).toBe(s);
    expect(
      tabsReducer(base(), { type: "cyclePane", tabId: "a", delta: 1 }).tabs[0]
        .panes,
    ).toBeUndefined();
  });

  it("resizeSplit で比率を変える", () => {
    let s = split(base(), "p2", "row", "sp");
    s = tabsReducer(s, {
      type: "resizeSplit",
      tabId: "a",
      splitId: "sp",
      ratio: 0.3,
    });
    expect(s.tabs[0].layout).toMatchObject({ ratio: 0.3 });
  });

  it("色は全ペインに付く。パスワードの消去はそのペインだけ", () => {
    const ssh = {
      type: "ssh",
      encoding: "UTF-8",
      termType: "xterm-256color",
      host: "h",
      port: 22,
      username: "u",
      useSshConfig: true,
      jumpHosts: "",
      forwards: "",
      socksPorts: "",
      remoteForwards: "",
      authKind: "password",
      password: "secret",
      remember: false,
      keyPath: "",
      passphrase: "",
    } as const;
    let s = split(base(), "p2");
    s = tabsReducer(s, {
      type: "replacePane",
      tabId: "a",
      paneId: "p2",
      pane: { id: "p3", values: ssh },
    });
    s = tabsReducer(s, { type: "setColor", id: "a", color: "red" });
    expect(panesOf(s.tabs[0]).map((p) => p.values.tabColor)).toEqual([
      "red",
      "red",
    ]);
    s = tabsReducer(s, { type: "scrubSecrets", id: "p3" });
    const p3 = panesOf(s.tabs[0])[1].values;
    expect(p3.type === "ssh" && p3.password).toBe("");
  });

  it("replacePane は配置を保ったままペインを入れ替える", () => {
    let s = split(base(), "p2");
    s = tabsReducer(s, {
      type: "replacePane",
      tabId: "a",
      paneId: "p2",
      pane: { id: "p9", values: local },
    });
    expect(paneIds(layoutOf(s.tabs[0]))).toEqual(["a", "p9"]);
    expect(activePaneIdOf(s.tabs[0])).toBe("p9");
  });

  it("タブを閉じれば全ペインが消える", () => {
    const s = tabsReducer(split(base(), "p2"), { type: "close", id: "a" });
    expect(s.tabs).toEqual([]);
  });

  it("scrubSecrets: Telnet / シリアルのログイン用パスワードも消す", () => {
    const telnetValues = {
      type: "telnet",
      encoding: "UTF-8",
      termType: "xterm-256color",
      localEcho: "auto",
      host: "h",
      port: 23,
      txNewline: "Cr",
      rxNewline: "Raw",
      loginScript: "P: => {password}",
      loginPassword: "secret",
    } as const;
    let s = tabsReducer(initialTabsState, {
      type: "add",
      tab: { id: "a", title: "a", values: telnetValues },
    });
    s = tabsReducer(s, { type: "scrubSecrets", id: "a" });
    expect(s.tabs[0].values).toEqual({ ...telnetValues, loginPassword: "" });
  });
});

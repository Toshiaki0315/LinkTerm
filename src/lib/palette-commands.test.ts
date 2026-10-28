import { describe, expect, it, vi } from "vitest";
import { connectionSchema } from "./connection-schema";
import {
  buildPaletteCommands,
  type PaletteActions,
  type PaletteContext,
} from "./palette-commands";
import type { Tab } from "./tabs";

const local = { type: "local", encoding: "UTF-8" } as const;
const tab = (id: string, title = id): Tab => ({
  id,
  title,
  values: local,
  status: "connected",
});

function actions(): { [K in keyof PaletteActions]: ReturnType<typeof vi.fn> } {
  return {
    newConnection: vi.fn(),
    openSettings: vi.fn(),
    closePane: vi.fn(),
    nextTab: vi.fn(),
    previousTab: vi.fn(),
    activateTab: vi.fn(),
    split: vi.fn(),
    cyclePane: vi.fn(),
    find: vi.fn(),
    duplicateTab: vi.fn(),
    setColor: vi.fn(),
    setBroadcast: vi.fn(),
    runSnippet: vi.fn(),
    manageSnippets: vi.fn(),
    manageHighlights: vi.fn(),
    openRecent: vi.fn(),
    clearRecents: vi.fn(),
    openProfile: vi.fn(),
  };
}

const build = (over: Partial<PaletteContext> = {}) => {
  const a = actions();
  const list = buildPaletteCommands({
    tabs: [tab("a", "alice@h"), tab("b")],
    activeId: "a",
    snippets: [],
    recents: [],
    profiles: [],
    broadcast: "off",
    actions: a as unknown as PaletteActions,
    ...over,
  });
  const byId = (id: string) => list.find((c) => c.id === id)!;
  return { list, a, byId };
};

describe("buildPaletteCommands", () => {
  it("項目の id は重複しない", () => {
    const { list } = build({
      snippets: [
        { id: "s", name: "x", text: "ls", lineDelayMs: 0, sendEnter: true },
      ],
      recents: [
        {
          values: connectionSchema.parse({
            type: "telnet",
            host: "r",
            port: 23,
          }),
          usedAt: 1,
        },
      ],
      profiles: [{ id: "p", name: "本番", values: { type: "local" } }],
    });
    expect(new Set(list.map((c) => c.id)).size).toBe(list.length);
  });

  it("タブがなければ、タブに対する操作は出さない（新規・設定などは出す）", () => {
    const { list } = build({ tabs: [], activeId: null });
    const ids = list.map((c) => c.id);
    expect(ids).toContain("new");
    expect(ids).toContain("settings");
    for (const gone of [
      "close",
      "split-row",
      "find",
      "duplicate",
      "next-tab",
    ]) {
      expect(ids).not.toContain(gone);
    }
  });

  it("タブが1つなら、タブの切り替えは出さない", () => {
    const { list } = build({ tabs: [tab("a")], activeId: "a" });
    expect(list.map((c) => c.id)).not.toContain("next-tab");
  });

  it("各項目は対応する操作を呼ぶ", () => {
    const { byId, a } = build();
    byId("new").run();
    byId("settings").run();
    byId("close").run();
    byId("find").run();
    byId("duplicate").run();
    byId("next-tab").run();
    byId("prev-tab").run();
    byId("split-row").run();
    byId("split-column").run();
    byId("next-pane").run();
    byId("prev-pane").run();
    byId("goto-b").run();
    byId("color-red").run();
    byId("color-none").run();
    byId("snippets").run();
    byId("highlights").run();
    expect(a.newConnection).toHaveBeenCalled();
    expect(a.openSettings).toHaveBeenCalled();
    expect(a.closePane).toHaveBeenCalled();
    expect(a.find).toHaveBeenCalled();
    expect(a.duplicateTab).toHaveBeenCalledWith("a");
    expect(a.nextTab).toHaveBeenCalled();
    expect(a.previousTab).toHaveBeenCalled();
    expect(a.split).toHaveBeenNthCalledWith(1, "row");
    expect(a.split).toHaveBeenNthCalledWith(2, "column");
    expect(a.cyclePane).toHaveBeenNthCalledWith(1, 1);
    expect(a.cyclePane).toHaveBeenNthCalledWith(2, -1);
    expect(a.activateTab).toHaveBeenCalledWith("b");
    expect(a.setColor).toHaveBeenNthCalledWith(1, "red");
    expect(a.setColor).toHaveBeenNthCalledWith(2, undefined);
    expect(a.manageSnippets).toHaveBeenCalled();
    expect(a.manageHighlights).toHaveBeenCalled();
  });

  it("同時入力は、範囲ごとの項目を出し、現在の範囲に印を付ける", () => {
    const { byId, a } = build({ broadcast: "tab" });
    expect(byId("broadcast-tab").title).toContain("（現在）");
    expect(byId("broadcast-off").title).not.toContain("（現在）");
    byId("broadcast-all").run();
    expect(a.setBroadcast).toHaveBeenCalledWith("all");
  });

  it("スニペット・最近の接続・保存済みの接続を項目にする", () => {
    const snippet = {
      id: "s",
      name: "経路確認",
      text: "ls",
      lineDelayMs: 0,
      sendEnter: true,
    };
    const entry = {
      values: connectionSchema.parse({
        type: "telnet",
        host: "router",
        port: 2323,
      }),
      usedAt: 1,
    };
    const profile = { id: "p", name: "本番", values: { type: "local" } };
    const { byId, a } = build({
      snippets: [snippet],
      recents: [entry],
      profiles: [profile],
    });
    byId("snippet-s").run();
    byId("recent-0").run();
    byId("clear-recents").run();
    byId("profile-p").run();
    expect(byId("snippet-s").title).toBe("スニペットを実行: 経路確認");
    expect(byId("recent-0").title).toBe("最近の接続: telnet://router:2323");
    expect(a.runSnippet).toHaveBeenCalledWith(snippet);
    expect(a.openRecent).toHaveBeenCalledWith(entry);
    expect(a.clearRecents).toHaveBeenCalled();
    expect(a.openProfile).toHaveBeenCalledWith(profile);
  });

  it("履歴がなければ、履歴の消去は出さない", () => {
    expect(build().list.map((c) => c.id)).not.toContain("clear-recents");
  });
});

import { BROADCAST_LABELS, type BroadcastMode } from "./broadcast";
import type { PaletteCommand } from "./command-search";
import { recentLabel, type RecentEntry } from "./recent";
import type { Snippet } from "./snippets";
import { TAB_COLORS, type TabColorId } from "./tab-colors";
import type { SavedProfile } from "./terminal-api";
import type { SplitDir } from "./layout";
import { formatBinding, type Bindings, type ShortcutId } from "./shortcuts";
import type { Tab } from "./tabs";

/** パレットから呼ぶ操作。 */
export interface PaletteActions {
  newConnection(): void;
  openSettings(): void;
  closePane(): void;
  nextTab(): void;
  previousTab(): void;
  activateTab(id: string): void;
  split(dir: SplitDir): void;
  cyclePane(delta: 1 | -1): void;
  find(): void;
  duplicateTab(id: string): void;
  setColor(color: TabColorId | undefined): void;
  setBroadcast(mode: BroadcastMode): void;
  runSnippet(snippet: Snippet): void;
  manageSnippets(): void;
  manageHighlights(): void;
  openRecent(entry: RecentEntry): void;
  clearRecents(): void;
  openProfile(profile: SavedProfile): void;
  openShortcuts(): void;
}

export interface PaletteContext {
  tabs: Tab[];
  activeId: string | null;
  snippets: Snippet[];
  recents: RecentEntry[];
  profiles: SavedProfile[];
  broadcast: BroadcastMode;
  /** いまのショートカット（ヒントの表示用）。 */
  bindings: Bindings;
  actions: PaletteActions;
}

/** パレットに出す項目を組み立てる。タブがないときは、タブに対する操作は出さない。 */
export function buildPaletteCommands(ctx: PaletteContext): PaletteCommand[] {
  const { actions: a } = ctx;
  const activeTab = ctx.tabs.find((t) => t.id === ctx.activeId);
  const list: PaletteCommand[] = [];
  const hint = (id: ShortcutId) => formatBinding(ctx.bindings[id]);
  const add = (
    group: string,
    id: string,
    title: string,
    run: () => void,
    extra: { hint?: string; keywords?: string } = {},
  ) => list.push({ id, title, group, run, ...extra });

  add("接続", "new", "新しい接続", a.newConnection, {
    hint: hint("new"),
    keywords: "new connect 開く",
  });
  add("アプリ", "settings", "設定を開く", a.openSettings, {
    hint: "⌘,",
    keywords: "settings preferences フォント テーマ",
  });

  if (activeTab) {
    add("タブ", "close", "タブ／ペインを閉じる", a.closePane, {
      hint: hint("close"),
      keywords: "close",
    });
    add("タブ", "duplicate", "タブを複製", () => a.duplicateTab(activeTab.id), {
      keywords: "duplicate copy",
    });
    add("タブ", "find", "画面内を検索", a.find, {
      hint: hint("find"),
      keywords: "find search",
    });
  }
  if (ctx.tabs.length > 1) {
    add("タブ", "next-tab", "次のタブ", a.nextTab, { hint: hint("next-tab") });
    add("タブ", "prev-tab", "前のタブ", a.previousTab, {
      hint: hint("previous-tab"),
    });
  }
  if (activeTab) {
    add("画面分割", "split-row", "右に分割", () => a.split("row"), {
      hint: hint("split-right"),
      keywords: "split",
    });
    add("画面分割", "split-column", "下に分割", () => a.split("column"), {
      hint: hint("split-down"),
      keywords: "split",
    });
    add("画面分割", "next-pane", "次のペインへ", () => a.cyclePane(1), {
      hint: hint("next-pane"),
    });
    add("画面分割", "prev-pane", "前のペインへ", () => a.cyclePane(-1), {
      hint: hint("previous-pane"),
    });
    for (const mode of ["off", "tab", "all"] as const) {
      add(
        "同時入力",
        `broadcast-${mode}`,
        `同時入力: ${BROADCAST_LABELS[mode]}${ctx.broadcast === mode ? "（現在）" : ""}`,
        () => a.setBroadcast(mode),
        {
          hint: mode === "off" ? hint("broadcast") : undefined,
          keywords: "broadcast",
        },
      );
    }
    for (const c of TAB_COLORS) {
      add("タブの色", `color-${c.id}`, `タブの色: ${c.label}`, () =>
        a.setColor(c.id),
      );
    }
    add("タブの色", "color-none", "タブの色: なし", () =>
      a.setColor(undefined),
    );
  }

  for (const tab of ctx.tabs) {
    add("タブ", `goto-${tab.id}`, `タブへ移動: ${tab.title}`, () =>
      a.activateTab(tab.id),
    );
  }

  for (const s of ctx.snippets) {
    add("スニペット", `snippet-${s.id}`, `スニペットを実行: ${s.name}`, () =>
      a.runSnippet(s),
    );
  }
  add("アプリ", "shortcuts", "ショートカットを設定…", a.openShortcuts, {
    keywords: "shortcut keybinding キー",
  });
  add("スニペット", "snippets", "スニペットを管理…", a.manageSnippets);
  add(
    "アプリ",
    "highlights",
    "キーワードの強調・通知を設定…",
    a.manageHighlights,
    {
      keywords: "highlight notify ハイライト",
    },
  );

  for (const [index, entry] of ctx.recents.entries()) {
    add(
      "最近使った接続",
      `recent-${index}`,
      `最近の接続: ${recentLabel(entry.values)}`,
      () => a.openRecent(entry),
    );
  }
  if (ctx.recents.length > 0) {
    add(
      "最近使った接続",
      "clear-recents",
      "最近使った接続の履歴を消去",
      a.clearRecents,
    );
  }
  for (const p of ctx.profiles) {
    add("保存済みの接続", `profile-${p.id}`, `保存済みの接続: ${p.name}`, () =>
      a.openProfile(p),
    );
  }
  return list;
}

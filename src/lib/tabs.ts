import type { SessionStatus } from "../hooks/useTerminalSession";
import type { ConnectionValues } from "./connection-schema";
import {
  paneIds,
  removeLeaf,
  setRatio,
  splitLeaf,
  type LayoutNode,
  type SplitDir,
} from "./layout";
import type { TabColorId } from "./tab-colors";

/** 分割画面の1区画（1セッション）。 */
export interface Pane {
  id: string;
  values: ConnectionValues;
  status: SessionStatus;
  deferStart?: boolean;
}

export interface Tab {
  id: string;
  title: string;
  values: ConnectionValues;
  status: SessionStatus;
  /** 復元したタブ。接続せずに表示し、「接続」を押したときに接続する。 */
  deferStart?: boolean;
  /**
   * 分割画面のペイン。分割していないタブでは省略し、`id` を ID とする1ペインとして扱う。
   * 分割しているタブでは、`values` / `status` / `deferStart` は先頭のペインの写し。
   */
  panes?: Pane[];
  /** ペインの配置。`panes` があるときだけ持つ。 */
  layout?: LayoutNode;
  /** 操作対象のペイン。省略時は先頭。 */
  activePaneId?: string;
}

/** タブのペイン一覧（分割していなければタブ自身の1ペイン）。 */
export const panesOf = (tab: Tab): Pane[] =>
  tab.panes ?? [
    {
      id: tab.id,
      values: tab.values,
      status: tab.status,
      deferStart: tab.deferStart,
    },
  ];

export const layoutOf = (tab: Tab): LayoutNode =>
  tab.layout ?? { kind: "pane", id: tab.id };

/** 操作対象のペインの ID。 */
export function activePaneIdOf(tab: Tab): string {
  const panes = panesOf(tab);
  return panes.some((p) => p.id === tab.activePaneId)
    ? (tab.activePaneId as string)
    : panes[0].id;
}

/** 先頭のペインの内容をタブの `values` などへ写す。 */
function withPanes(tab: Tab, panes: Pane[], layout: LayoutNode): Tab {
  const first = panes[0];
  return {
    ...tab,
    panes,
    layout,
    values: first.values,
    status: first.status,
    deferStart: first.deferStart,
  };
}

/** `fn` でペインを書き換える。分割していないタブは、タブ自身の項目を書き換える。 */
function updatePane(tab: Tab, paneId: string, fn: (pane: Pane) => Pane): Tab {
  if (!tab.panes) {
    if (paneId !== tab.id) return tab;
    const next = fn(panesOf(tab)[0]);
    return {
      ...tab,
      values: next.values,
      status: next.status,
      deferStart: next.deferStart,
    };
  }
  return withPanes(
    tab,
    tab.panes.map((p) => (p.id === paneId ? fn(p) : p)),
    layoutOf(tab),
  );
}

const findTabOfPane = (state: TabsState, paneId: string) =>
  state.tabs.find((t) => panesOf(t).some((p) => p.id === paneId));

const replaceTab = (state: TabsState, tab: Tab): TabsState => ({
  ...state,
  tabs: state.tabs.map((t) => (t.id === tab.id ? tab : t)),
});

export interface NewPane {
  id: string;
  values: ConnectionValues;
  deferStart?: boolean;
}

export interface TabsState {
  tabs: Tab[];
  activeId: string | null;
}

export type TabsAction =
  | { type: "add"; tab: Omit<Tab, "status">; afterId?: string }
  /** 分割したタブを、まとめて追加する（前回の画面の復元）。 */
  | {
      type: "addSplit";
      tab: { id: string; title: string };
      panes: NewPane[];
      layout: LayoutNode;
      activePaneId: string;
    }
  | { type: "close"; id: string }
  | { type: "rename"; id: string; title: string }
  /** タブを `toIndex` の位置へ移動する（並べ替え）。アクティブなタブは変わらない。 */
  | { type: "move"; id: string; toIndex: number }
  | { type: "activate"; id: string }
  | { type: "activateIndex"; index: number | "last" }
  | { type: "activateRelative"; delta: 1 | -1 }
  | { type: "setStatus"; id: string; status: SessionStatus }
  /** タブの色を変える。`undefined` で色なしに戻す。 */
  | { type: "setColor"; id: string; color: TabColorId | undefined }
  /** 接続開始後、保持しているパスワード等の秘密情報を消す。`id` はペインの ID。 */
  | { type: "scrubSecrets"; id: string }
  /** 操作対象のペインを分割し、新しいペインを後ろ（右／下）に置いて操作対象にする。 */
  | {
      type: "splitPane";
      tabId: string;
      dir: SplitDir;
      splitId: string;
      pane: NewPane;
    }
  /** ペインを閉じる。最後の1つならタブごと閉じる。 */
  | { type: "closePane"; tabId: string; paneId: string }
  | { type: "activatePane"; tabId: string; paneId: string }
  /** 操作対象のペインを前後へ移す。 */
  | { type: "cyclePane"; tabId: string; delta: 1 | -1 }
  | { type: "resizeSplit"; tabId: string; splitId: string; ratio: number }
  /** ペインの接続を別の内容に置き換える（再入力して再接続）。配置は保つ。 */
  | { type: "replacePane"; tabId: string; paneId: string; pane: NewPane };

/** タブ名の最大文字数。 */
export const MAX_TITLE_CHARS = 60;

export const initialTabsState: TabsState = { tabs: [], activeId: null };

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case "add": {
      const added: Tab = { ...action.tab, status: "connecting" };
      const after = state.tabs.findIndex((t) => t.id === action.afterId);
      const tabs =
        after < 0
          ? [...state.tabs, added]
          : [
              ...state.tabs.slice(0, after + 1),
              added,
              ...state.tabs.slice(after + 1),
            ];
      return { tabs, activeId: added.id };
    }
    case "addSplit": {
      if (action.panes.length === 0) return state;
      const panes: Pane[] = action.panes.map((p) => ({
        ...p,
        status: "connecting",
      }));
      const first = panes[0];
      const tab: Tab = {
        id: action.tab.id,
        title: action.tab.title,
        values: first.values,
        status: first.status,
        deferStart: first.deferStart,
      };
      const next: Tab = {
        ...withPanes(tab, panes, action.layout),
        activePaneId: panes.some((p) => p.id === action.activePaneId)
          ? action.activePaneId
          : first.id,
      };
      return { tabs: [...state.tabs, next], activeId: next.id };
    }
    case "rename": {
      const title = [...action.title.trim()].slice(0, MAX_TITLE_CHARS).join("");
      const tab = state.tabs.find((t) => t.id === action.id);
      if (!tab || title === "" || title === tab.title) return state;
      return {
        ...state,
        tabs: state.tabs.map((t) => (t.id === action.id ? { ...t, title } : t)),
      };
    }
    case "move": {
      const from = state.tabs.findIndex((t) => t.id === action.id);
      if (from < 0) return state;
      const to = Math.max(0, Math.min(action.toIndex, state.tabs.length - 1));
      if (to === from) return state;
      const tabs = [...state.tabs];
      const [moved] = tabs.splice(from, 1);
      tabs.splice(to, 0, moved);
      return { ...state, tabs };
    }
    case "activate":
      return state.tabs.some((t) => t.id === action.id)
        ? { ...state, activeId: action.id }
        : state;
    case "activateIndex": {
      const index =
        action.index === "last" ? state.tabs.length - 1 : action.index;
      const tab = state.tabs[index];
      return tab ? { ...state, activeId: tab.id } : state;
    }
    case "activateRelative": {
      if (state.tabs.length === 0) return state;
      const current = state.tabs.findIndex((t) => t.id === state.activeId);
      const next =
        (current + action.delta + state.tabs.length) % state.tabs.length;
      return { ...state, activeId: state.tabs[next].id };
    }
    case "close": {
      const index = state.tabs.findIndex((t) => t.id === action.id);
      if (index < 0) return state;
      const tabs = state.tabs.filter((t) => t.id !== action.id);
      if (state.activeId !== action.id) return { ...state, tabs };
      const next = tabs[index] ?? tabs[index - 1] ?? null;
      return { tabs, activeId: next?.id ?? null };
    }
    case "scrubSecrets": {
      const tab = findTabOfPane(state, action.id);
      const pane = tab && panesOf(tab).find((p) => p.id === action.id);
      if (!tab || !pane) return state;
      const v = pane.values;
      let values: ConnectionValues;
      if (v.type === "ssh") {
        values = { ...v, password: "", passphrase: "" };
      } else if (v.type === "telnet" || v.type === "serial") {
        values = { ...v, loginPassword: "" };
      } else {
        return state;
      }
      return replaceTab(
        state,
        updatePane(tab, action.id, (p) => ({ ...p, values })),
      );
    }
    case "setColor": {
      const tab = state.tabs.find((t) => t.id === action.id);
      if (!tab || tab.values.tabColor === action.color) return state;
      const panes = panesOf(tab).map((p) => ({
        ...p,
        values: { ...p.values, tabColor: action.color },
      }));
      return replaceTab(
        state,
        tab.panes
          ? withPanes(tab, panes, layoutOf(tab))
          : { ...tab, values: panes[0].values },
      );
    }
    case "setStatus": {
      const tab = findTabOfPane(state, action.id);
      const pane = tab && panesOf(tab).find((p) => p.id === action.id);
      if (!tab || !pane || pane.status === action.status) return state;
      return replaceTab(
        state,
        updatePane(tab, action.id, (p) => ({ ...p, status: action.status })),
      );
    }
    case "splitPane": {
      const tab = state.tabs.find((t) => t.id === action.tabId);
      if (!tab) return state;
      const panes = panesOf(tab);
      const target = activePaneIdOf(tab);
      const added: Pane = { ...action.pane, status: "connecting" };
      const at = panes.findIndex((p) => p.id === target);
      const next = [...panes.slice(0, at + 1), added, ...panes.slice(at + 1)];
      const layout = splitLeaf(
        layoutOf(tab),
        target,
        action.dir,
        added.id,
        action.splitId,
      );
      return replaceTab(state, {
        ...withPanes(tab, next, layout),
        activePaneId: added.id,
      });
    }
    case "closePane": {
      const tab = state.tabs.find((t) => t.id === action.tabId);
      if (!tab || !panesOf(tab).some((p) => p.id === action.paneId)) {
        return state;
      }
      const panes = panesOf(tab);
      if (panes.length === 1) {
        return tabsReducer(state, { type: "close", id: tab.id });
      }
      const order = paneIds(layoutOf(tab));
      const layout = removeLeaf(layoutOf(tab), action.paneId);
      if (!layout) return state;
      const rest = panes.filter((p) => p.id !== action.paneId);
      const index = order.indexOf(action.paneId);
      const remaining = paneIds(layout);
      const active =
        activePaneIdOf(tab) === action.paneId
          ? (remaining[Math.min(index, remaining.length - 1)] ?? rest[0].id)
          : activePaneIdOf(tab);
      if (rest.length === 1) {
        // 1つに戻ったら、分割していないタブの形に戻す。
        const only = rest[0];
        const { panes: _p, layout: _l, activePaneId: _a, ...base } = tab;
        return replaceTab(state, {
          ...base,
          id: tab.id,
          values: only.values,
          status: only.status,
          deferStart: only.deferStart,
          // ペインの ID がタブの ID と違っても、描画側が参照できるよう配置を残す。
          ...(only.id === tab.id
            ? {}
            : { panes: rest, layout, activePaneId: only.id }),
        });
      }
      return replaceTab(state, {
        ...withPanes(tab, rest, layout),
        activePaneId: active,
      });
    }
    case "activatePane": {
      const tab = state.tabs.find((t) => t.id === action.tabId);
      if (
        !tab ||
        !panesOf(tab).some((p) => p.id === action.paneId) ||
        activePaneIdOf(tab) === action.paneId
      ) {
        return state;
      }
      return replaceTab(state, { ...tab, activePaneId: action.paneId });
    }
    case "cyclePane": {
      const tab = state.tabs.find((t) => t.id === action.tabId);
      if (!tab) return state;
      const order = paneIds(layoutOf(tab));
      if (order.length < 2) return state;
      const current = order.indexOf(activePaneIdOf(tab));
      const next =
        order[(current + action.delta + order.length) % order.length];
      return replaceTab(state, { ...tab, activePaneId: next });
    }
    case "resizeSplit": {
      const tab = state.tabs.find((t) => t.id === action.tabId);
      if (!tab?.layout) return state;
      const layout = setRatio(tab.layout, action.splitId, action.ratio);
      return layout === tab.layout
        ? state
        : replaceTab(state, { ...tab, layout });
    }
    case "replacePane": {
      const tab = state.tabs.find((t) => t.id === action.tabId);
      if (!tab || !panesOf(tab).some((p) => p.id === action.paneId)) {
        return state;
      }
      const added: Pane = { ...action.pane, status: "connecting" };
      const panes = panesOf(tab).map((p) =>
        p.id === action.paneId ? added : p,
      );
      const swap = (n: LayoutNode): LayoutNode =>
        n.kind === "pane"
          ? n.id === action.paneId
            ? { kind: "pane", id: added.id }
            : n
          : { ...n, a: swap(n.a), b: swap(n.b) };
      return replaceTab(state, {
        ...withPanes(tab, panes, swap(layoutOf(tab))),
        activePaneId: added.id,
      });
    }
  }
}

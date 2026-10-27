import type { SessionStatus } from "../hooks/useTerminalSession";
import type { ConnectionValues } from "./connection-schema";

export interface Tab {
  id: string;
  title: string;
  values: ConnectionValues;
  status: SessionStatus;
  /** 復元したタブ。接続せずに表示し、「接続」を押したときに接続する。 */
  deferStart?: boolean;
}

export interface TabsState {
  tabs: Tab[];
  activeId: string | null;
}

export type TabsAction =
  | { type: "add"; tab: Omit<Tab, "status">; afterId?: string }
  | { type: "close"; id: string }
  | { type: "rename"; id: string; title: string }
  /** タブを `toIndex` の位置へ移動する（並べ替え）。アクティブなタブは変わらない。 */
  | { type: "move"; id: string; toIndex: number }
  | { type: "activate"; id: string }
  | { type: "activateIndex"; index: number | "last" }
  | { type: "activateRelative"; delta: 1 | -1 }
  | { type: "setStatus"; id: string; status: SessionStatus }
  /** 接続開始後、保持しているパスワード等の秘密情報を消す。 */
  | { type: "scrubSecrets"; id: string };

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
      const tab = state.tabs.find((t) => t.id === action.id);
      if (!tab || tab.values.type !== "ssh") return state;
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.id
            ? { ...t, values: { ...tab.values, password: "", passphrase: "" } }
            : t,
        ),
      };
    }
    case "setStatus": {
      const tab = state.tabs.find((t) => t.id === action.id);
      if (!tab || tab.status === action.status) return state;
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.id ? { ...t, status: action.status } : t,
        ),
      };
    }
  }
}

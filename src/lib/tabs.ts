import type { SessionStatus } from "../hooks/useTerminalSession";
import type { ConnectionValues } from "./connection-schema";

export interface Tab {
  id: string;
  title: string;
  values: ConnectionValues;
  status: SessionStatus;
}

export interface TabsState {
  tabs: Tab[];
  activeId: string | null;
}

export type TabsAction =
  | { type: "add"; tab: Omit<Tab, "status"> }
  | { type: "close"; id: string }
  | { type: "activate"; id: string }
  | { type: "setStatus"; id: string; status: SessionStatus };

export const initialTabsState: TabsState = { tabs: [], activeId: null };

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case "add":
      return {
        tabs: [...state.tabs, { ...action.tab, status: "connecting" }],
        activeId: action.tab.id,
      };
    case "activate":
      return state.tabs.some((t) => t.id === action.id)
        ? { ...state, activeId: action.id }
        : state;
    case "close": {
      const index = state.tabs.findIndex((t) => t.id === action.id);
      if (index < 0) return state;
      const tabs = state.tabs.filter((t) => t.id !== action.id);
      if (state.activeId !== action.id) return { ...state, tabs };
      const next = tabs[index] ?? tabs[index - 1] ?? null;
      return { tabs, activeId: next?.id ?? null };
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

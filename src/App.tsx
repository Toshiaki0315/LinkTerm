import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { HostKeyDialog } from "./components/HostKeyDialog";
import { TabBar } from "./components/TabBar";
import { TerminalWorkspace } from "./components/TerminalWorkspace";
import type { SessionStatus } from "./hooks/useTerminalSession";
import {
  connectionTitle,
  type ConnectionValues,
} from "./lib/connection-schema";
import { shortcutFor } from "./lib/shortcuts";
import { initialTabsState, tabsReducer } from "./lib/tabs";
import {
  onHostKeyRequest,
  pendingHostKeyRequests,
  respondHostKey,
  type HostKeyRequest,
} from "./lib/terminal-api";

function App() {
  const [state, dispatch] = useReducer(tabsReducer, initialTabsState);
  /** 接続ダイアログの状態。`replaceTabId` があれば、送信時にそのタブを置き換える（再入力して再接続）。 */
  const [dialog, setDialog] = useState<{
    initialValues?: ConnectionValues;
    replaceTabId?: string;
  } | null>(null);
  const dialogOpen = dialog !== null;
  const [hostKeyQueue, setHostKeyQueue] = useState<HostKeyRequest[]>([]);
  /** 応答済みの要求ID。イベントと問い合わせの両方で届いた要求を二重に出さないために使う。 */
  const handledRequests = useRef(new Set<string>());

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const enqueue = (req: HostKeyRequest) =>
      setHostKeyQueue((q) =>
        handledRequests.current.has(req.requestId) ||
        q.some((r) => r.requestId === req.requestId)
          ? q
          : [...q, req],
      );
    (async () => {
      // 購読を確立してから問い合わせる。購読前に出た要求は問い合わせで取り込む。
      const un = await onHostKeyRequest(enqueue);
      if (disposed) {
        un();
        return;
      }
      unlisten = un;
      try {
        for (const req of await pendingHostKeyRequests()) enqueue(req);
      } catch (e) {
        console.error("未応答のホスト鍵要求を取得できません:", e);
      }
    })().catch((e: unknown) =>
      console.error("ホスト鍵要求の購読に失敗しました:", e),
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const modalOpen = dialogOpen || hostKeyQueue.length > 0;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // ダイアログ表示中は入力を妨げない。
      if (modalOpen) return;
      const action = shortcutFor(event);
      if (!action) return;
      event.preventDefault();
      switch (action.type) {
        case "new":
          setDialog({});
          break;
        case "close":
          if (state.activeId) dispatch({ type: "close", id: state.activeId });
          break;
        case "select":
          dispatch({ type: "activateIndex", index: action.index });
          break;
        case "next":
          dispatch({ type: "activateRelative", delta: 1 });
          break;
        case "previous":
          dispatch({ type: "activateRelative", delta: -1 });
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [modalOpen, state.activeId]);

  const addTab = useCallback(
    (values: ConnectionValues) => {
      if (dialog?.replaceTabId) {
        dispatch({ type: "close", id: dialog.replaceTabId });
      }
      dispatch({
        type: "add",
        tab: {
          id: crypto.randomUUID(),
          title: connectionTitle(values),
          values,
        },
      });
    },
    [dialog],
  );

  const onSecretsConsumed = useCallback((id: string) => {
    dispatch({ type: "scrubSecrets", id });
  }, []);

  const onEditAndReconnect = useCallback(
    (id: string) => {
      const tab = state.tabs.find((t) => t.id === id);
      if (tab) setDialog({ initialValues: tab.values, replaceTabId: id });
    },
    [state.tabs],
  );

  const onStatusChange = useCallback((id: string, status: SessionStatus) => {
    dispatch({ type: "setStatus", id, status });
  }, []);

  const respond = useCallback((requestId: string, approved: boolean) => {
    handledRequests.current.add(requestId);
    setHostKeyQueue((q) => q.filter((r) => r.requestId !== requestId));
    respondHostKey(requestId, approved).catch((e: unknown) =>
      console.error("ホスト鍵の応答に失敗しました:", e),
    );
  }, []);

  return (
    <div className="flex h-screen flex-col bg-neutral-900 text-neutral-100">
      <h1 className="sr-only">LinkTerm</h1>
      <TabBar
        tabs={state.tabs}
        activeId={state.activeId}
        onActivate={(id) => dispatch({ type: "activate", id })}
        onClose={(id) => dispatch({ type: "close", id })}
        onNew={() => setDialog({})}
      />
      <TerminalWorkspace
        tabs={state.tabs}
        activeId={state.activeId}
        onStatusChange={onStatusChange}
        onSecretsConsumed={onSecretsConsumed}
        onEditAndReconnect={onEditAndReconnect}
      />
      <ConnectionDialog
        open={dialogOpen}
        initialValues={dialog?.initialValues}
        onOpenChange={(open) => !open && setDialog(null)}
        onSubmit={addTab}
      />
      <HostKeyDialog request={hostKeyQueue[0] ?? null} onRespond={respond} />
    </div>
  );
}

export default App;

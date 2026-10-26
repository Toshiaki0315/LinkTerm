import { useCallback, useEffect, useReducer, useState } from "react";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { HostKeyDialog } from "./components/HostKeyDialog";
import { TabBar } from "./components/TabBar";
import { TerminalWorkspace } from "./components/TerminalWorkspace";
import type { SessionStatus } from "./hooks/useTerminalSession";
import {
  connectionTitle,
  type ConnectionValues,
} from "./lib/connection-schema";
import { initialTabsState, tabsReducer } from "./lib/tabs";
import {
  onHostKeyRequest,
  respondHostKey,
  type HostKeyRequest,
} from "./lib/terminal-api";

function App() {
  const [state, dispatch] = useReducer(tabsReducer, initialTabsState);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [hostKeyQueue, setHostKeyQueue] = useState<HostKeyRequest[]>([]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onHostKeyRequest((req) => setHostKeyQueue((q) => [...q, req]))
      .then((un) => (disposed ? un() : (unlisten = un)))
      .catch((e: unknown) =>
        console.error("ホスト鍵要求の購読に失敗しました:", e),
      );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const addTab = useCallback((values: ConnectionValues) => {
    dispatch({
      type: "add",
      tab: { id: crypto.randomUUID(), title: connectionTitle(values), values },
    });
  }, []);

  const onStatusChange = useCallback((id: string, status: SessionStatus) => {
    dispatch({ type: "setStatus", id, status });
  }, []);

  const respond = useCallback((requestId: string, approved: boolean) => {
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
        onNew={() => setDialogOpen(true)}
      />
      <TerminalWorkspace
        tabs={state.tabs}
        activeId={state.activeId}
        onStatusChange={onStatusChange}
      />
      <ConnectionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={addTab}
      />
      <HostKeyDialog request={hostKeyQueue[0] ?? null} onRespond={respond} />
    </div>
  );
}

export default App;

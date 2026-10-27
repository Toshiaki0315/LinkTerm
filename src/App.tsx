import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import {
  ConnectionDialog,
  type SubmitOptions,
} from "./components/ConnectionDialog";
import { HostKeyDialog } from "./components/HostKeyDialog";
import { TabBar } from "./components/TabBar";
import { TerminalWorkspace } from "./components/TerminalWorkspace";
import type { SessionStatus } from "./hooks/useTerminalSession";
import { SettingsDialog } from "./components/SettingsDialog";
import {
  connectionSchema,
  connectionTitle,
  type ConnectionValues,
} from "./lib/connection-schema";
import { DEFAULT_SETTINGS, type Settings } from "./lib/settings";
import { shortcutFor } from "./lib/shortcuts";
import { initialTabsState, tabsReducer } from "./lib/tabs";
import {
  deleteProfile,
  getSettings,
  listProfiles,
  onHostKeyRequest,
  onOpenSettings,
  pendingHostKeyRequests,
  respondHostKey,
  saveProfile,
  saveSettings,
  type HostKeyRequest,
  type SavedProfile,
} from "./lib/terminal-api";

/** 接続ダイアログへ渡す入力済みの値（秘密情報は含めない）。 */
type DialogInitialValues = ComponentProps<
  typeof ConnectionDialog
>["initialValues"];

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

function App() {
  const [state, dispatch] = useReducer(tabsReducer, initialTabsState);
  /** 接続ダイアログの状態。`replaceTabId` があれば、送信時にそのタブを置き換える（再入力して再接続）。 */
  const [dialog, setDialog] = useState<{
    initialValues?: DialogInitialValues;
    replaceTabId?: string;
  } | null>(null);
  const dialogOpen = dialog !== null;
  const [profiles, setProfiles] = useState<SavedProfile[]>([]);
  /** 保存済みの接続の読み込み・保存・削除の失敗をユーザーへ伝える。 */
  const [notice, setNotice] = useState<string | null>(null);

  const reloadProfiles = useCallback(async () => {
    try {
      setProfiles(await listProfiles());
    } catch (e) {
      setNotice(`保存済みの接続を読み込めません: ${describe(e)}`);
    }
  }, []);

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const startupDone = useRef(false);
  /** タブごとの検索要求の回数（⌘F のたびに増やし、そのタブが検索バーを開く）。 */
  const [findSignals, setFindSignals] = useState<Record<string, number>>({});

  /** タブを追加する。 */
  const openTab = useCallback((values: ConnectionValues) => {
    dispatch({
      type: "add",
      tab: {
        id: crypto.randomUUID(),
        title: connectionTitle(values),
        values,
      },
    });
  }, []);

  useEffect(() => {
    // 設定と保存済みの接続を読み込み、起動時に開くターミナルを開く（1回だけ）。
    let cancelled = false;
    (async () => {
      const [settingsResult, profilesResult] = await Promise.allSettled([
        getSettings(),
        listProfiles(),
      ]);
      if (cancelled) return;
      const notices: string[] = [];
      let loadedSettings = DEFAULT_SETTINGS;
      if (settingsResult.status === "fulfilled") {
        loadedSettings = settingsResult.value;
        setSettings(loadedSettings);
      } else {
        notices.push(
          `設定を読み込めません: ${describe(settingsResult.reason)}`,
        );
      }
      let loadedProfiles: SavedProfile[] = [];
      if (profilesResult.status === "fulfilled") {
        loadedProfiles = profilesResult.value;
        setProfiles(loadedProfiles);
      } else {
        notices.push(
          `保存済みの接続を読み込めません: ${describe(profilesResult.reason)}`,
        );
      }

      if (!startupDone.current) {
        startupDone.current = true;
        const { startup } = loadedSettings;
        if (startup.kind === "local") {
          openTab(connectionSchema.parse({ type: "local" }));
        } else if (startup.kind === "profile") {
          const profile = loadedProfiles.find(
            (p) => p.id === startup.profileId,
          );
          const raw = profile?.values;
          if (!profile || !raw) {
            notices.push("起動時に開く保存済みの接続が見つかりません");
          } else if (raw.type === "ssh" && raw.authKind === "password") {
            // パスワードは保存していないため、検証の前に、入力用の接続ダイアログを開く。
            setDialog({ initialValues: raw as DialogInitialValues });
          } else {
            const parsed = connectionSchema.safeParse(raw);
            if (parsed.success) {
              openTab(parsed.data);
            } else {
              notices.push(
                `起動時に開く保存済みの接続「${profile.name}」の内容が不正です`,
              );
            }
          }
        }
      }
      if (notices.length > 0) setNotice(notices.join(" / "));
    })();
    return () => {
      cancelled = true;
    };
  }, [openTab]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onOpenSettings(() => setSettingsOpen(true))
      .then((un) => (disposed ? un() : (unlisten = un)))
      .catch((e: unknown) =>
        console.error("設定メニューの購読に失敗しました:", e),
      );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const onSaveSettings = useCallback(async (next: Settings) => {
    setSettings(await saveSettings(next));
  }, []);

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

  const modalOpen = dialogOpen || settingsOpen || hostKeyQueue.length > 0;
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
        case "find": {
          const id = state.activeId;
          if (id) setFindSignals((s) => ({ ...s, [id]: (s[id] ?? 0) + 1 }));
          break;
        }
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
    (values: ConnectionValues, options?: SubmitOptions) => {
      if (dialog?.replaceTabId) {
        dispatch({ type: "close", id: dialog.replaceTabId });
      }
      openTab(values);
      if (options?.saveAs) {
        saveProfile(options.saveAs)
          .then(reloadProfiles)
          .catch((e: unknown) =>
            setNotice(`接続の保存に失敗しました: ${describe(e)}`),
          );
      }
    },
    [dialog, openTab, reloadProfiles],
  );

  const onDeleteProfile = useCallback(
    (id: string) => {
      deleteProfile(id)
        .then(reloadProfiles)
        .catch((e: unknown) =>
          setNotice(`保存済みの接続を削除できません: ${describe(e)}`),
        );
    },
    [reloadProfiles],
  );

  const onRenameTab = useCallback((id: string, title: string) => {
    dispatch({ type: "rename", id, title });
  }, []);

  const onMoveTab = useCallback((id: string, toIndex: number) => {
    dispatch({ type: "move", id, toIndex });
  }, []);

  /** タブを複製する。保持していない秘密情報（SSHのパスワード）が要る場合は、入力用のダイアログを開く。 */
  const onDuplicateTab = useCallback(
    (id: string) => {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) return;
      const needsSecret =
        tab.values.type === "ssh" &&
        tab.values.authKind === "password" &&
        tab.values.password === "";
      if (needsSecret) {
        setDialog({ initialValues: tab.values });
        return;
      }
      dispatch({
        type: "add",
        afterId: id,
        tab: { id: crypto.randomUUID(), title: tab.title, values: tab.values },
      });
    },
    [state.tabs],
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
        onRename={onRenameTab}
        onDuplicate={onDuplicateTab}
        onMove={onMoveTab}
      />
      {notice && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 bg-red-900/80 px-3 py-1 text-sm"
        >
          <span>{notice}</span>
          <button
            className="underline"
            aria-label="通知を閉じる"
            onClick={() => setNotice(null)}
          >
            閉じる
          </button>
        </div>
      )}
      <TerminalWorkspace
        tabs={state.tabs}
        activeId={state.activeId}
        onStatusChange={onStatusChange}
        onSecretsConsumed={onSecretsConsumed}
        onEditAndReconnect={onEditAndReconnect}
        appearance={settings}
        autoReconnect={settings.autoReconnect}
        findSignals={findSignals}
      />
      <ConnectionDialog
        open={dialogOpen}
        initialValues={dialog?.initialValues}
        onOpenChange={(open) => !open && setDialog(null)}
        onSubmit={addTab}
        profiles={profiles}
        onDeleteProfile={onDeleteProfile}
      />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        profiles={profiles}
        onSave={onSaveSettings}
      />
      <HostKeyDialog request={hostKeyQueue[0] ?? null} onRespond={respond} />
    </div>
  );
}

export default App;

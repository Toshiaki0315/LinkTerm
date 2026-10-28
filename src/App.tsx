import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import {
  ConnectionDialog,
  type SubmitOptions,
} from "./components/ConnectionDialog";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { CommandPalette } from "./components/CommandPalette";
import { HighlightsDialog } from "./components/HighlightsDialog";
import { SnippetsDialog } from "./components/SnippetsDialog";
import { HostKeyDialog } from "./components/HostKeyDialog";
import { TabBar } from "./components/TabBar";
import { TerminalWorkspace } from "./components/TerminalWorkspace";
import type { SessionStatus } from "./hooks/useTerminalSession";
import { SettingsDialog } from "./components/SettingsDialog";
import {
  connectionSchema,
  connectionTitle,
  isSecretMissing,
  parseSavedValues,
  requiresSecretAtOpen,
  stripSecrets,
  type ConnectionValues,
} from "./lib/connection-schema";
import { DEFAULT_SETTINGS, type Settings } from "./lib/settings";
import {
  MAX_RECENT,
  parseRecent,
  recordRecent,
  toStoredRecent,
  type RecentEntry,
} from "./lib/recent";
import {
  broadcastPaneCount,
  broadcastTargets,
  type BroadcastMode,
} from "./lib/broadcast";
import type { HighlightRule } from "./lib/highlight";
import { buildPaletteCommands } from "./lib/palette-commands";
import { sendToPane } from "./lib/pane-input";
import {
  overridesOf,
  resolveBindings,
  shortcutFor,
  type Bindings,
} from "./lib/shortcuts";
import { runSnippet, type Snippet } from "./lib/snippets";
import type { SplitDir } from "./lib/layout";
import {
  activePaneIdOf,
  initialTabsState,
  panesOf,
  tabsReducer,
} from "./lib/tabs";
import {
  deleteProfile,
  getSessionState,
  getSettings,
  listProfiles,
  onHostKeyRequest,
  onOpenSettings,
  pendingHostKeyRequests,
  respondHostKey,
  getRecentConnections,
  getHighlightRules,
  getKeybindings,
  saveKeybindings,
  getSnippets,
  saveHighlightRules,
  saveSnippets,
  saveProfile,
  saveRecentConnections,
  saveSessionState,
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
    /** 分割したペインの接続を置き換える（複数ペインのタブの再接続）。 */
    replacePane?: { tabId: string; paneId: string };
    /** 画面を分割して、新しいペインに開く。 */
    split?: { tabId: string; dir: SplitDir };
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

  /** 最近使った接続先（新しい順）。`dirty` は読み込み後に変更があり、保存が要ること。 */
  const [recent, setRecent] = useState<{ list: RecentEntry[]; dirty: boolean }>(
    { list: [], dirty: false },
  );

  useEffect(() => {
    let cancelled = false;
    getRecentConnections()
      .then((raw) => {
        // 読み込み前に接続した分は、履歴の先頭に残したまま古い履歴をつなぐ。
        if (!cancelled)
          setRecent((r) => ({
            list: [...r.list, ...parseRecent(raw)].slice(0, MAX_RECENT),
            dirty: r.dirty,
          }));
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setNotice(`最近使った接続を読み込めません: ${describe(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const recentPayload = JSON.stringify(toStoredRecent(recent.list));
  const recentDirty = recent.dirty;
  useEffect(() => {
    if (!recentDirty) return;
    const timer = setTimeout(() => {
      saveRecentConnections(JSON.parse(recentPayload)).catch((e: unknown) =>
        setNotice(`最近使った接続を保存できません: ${describe(e)}`),
      );
    }, 200);
    return () => clearTimeout(timer);
  }, [recentDirty, recentPayload]);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** 初期値から変えたショートカット。 */
  const [keyOverrides, setKeyOverrides] = useState<
    Array<{ id: string; binding: string }>
  >([]);
  const bindings = useMemo(() => resolveBindings(keyOverrides), [keyOverrides]);

  useEffect(() => {
    let cancelled = false;
    getKeybindings()
      .then((list) => {
        if (!cancelled) setKeyOverrides(list);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setNotice(`ショートカットを読み込めません: ${describe(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSaveBindings = useCallback(async (next: Bindings) => {
    setKeyOverrides(await saveKeybindings(overridesOf(next)));
  }, []);

  /** 同時入力の範囲。 */
  const [broadcast, setBroadcast] = useState<BroadcastMode>("off");

  const [highlightRules, setHighlightRules] = useState<HighlightRule[]>([]);
  const [highlightsOpen, setHighlightsOpen] = useState(false);
  /** 通知するキーワードが見つかった、見ていないタブ。 */
  const [attention, setAttention] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    getHighlightRules()
      .then((list) => {
        if (!cancelled) setHighlightRules(list);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setNotice(`ハイライト規則を読み込めません: ${describe(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSaveHighlights = useCallback(async (next: HighlightRule[]) => {
    setHighlightRules(await saveHighlightRules(next));
  }, []);

  const onAttention = useCallback((tabId: string) => {
    setAttention((s) => (s.has(tabId) ? s : new Set(s).add(tabId)));
  }, []);

  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [snippetsOpen, setSnippetsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSnippets()
      .then((list) => {
        if (!cancelled) setSnippets(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) setNotice(`スニペットを読み込めません: ${describe(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSaveSnippets = useCallback(async (next: Snippet[]) => {
    setSnippets(await saveSnippets(next));
  }, []);

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const startupDone = useRef(false);
  /** 起動時の復元が済んだか。済むまでは、保存済みのタブ構成を上書きしない。 */
  const [sessionReady, setSessionReady] = useState(false);
  /** タブごとの検索要求の回数（⌘F のたびに増やし、そのタブが検索バーを開く）。 */
  const [findSignals, setFindSignals] = useState<Record<string, number>>({});

  /** タブを追加する。 */
  const openTab = useCallback(
    (
      values: ConnectionValues,
      extra?: { title?: string; deferStart?: boolean },
    ) => {
      dispatch({
        type: "add",
        tab: {
          id: crypto.randomUUID(),
          title: extra?.title ?? connectionTitle(values),
          values,
          deferStart: extra?.deferStart,
        },
      });
    },
    [],
  );

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
        if (startup.kind === "restore") {
          try {
            const session = await getSessionState();
            if (cancelled) return;
            let skipped = 0;
            let activeIndex: number | null = null;
            let restoredCount = 0;
            session.tabs.forEach((saved, index) => {
              const values = parseSavedValues(saved.values);
              if (!values) {
                skipped += 1;
                return;
              }
              if (index === session.active) activeIndex = restoredCount;
              restoredCount += 1;
              openTab(values, {
                title: saved.title,
                // パスワードは保存していないため、パスワード認証のSSHは「接続」を待つ。
                deferStart: requiresSecretAtOpen(values),
              });
            });
            if (activeIndex !== null) {
              dispatch({ type: "activateIndex", index: activeIndex });
            }
            if (skipped > 0) {
              notices.push(`${skipped}個のタブを復元できませんでした`);
            }
          } catch (e) {
            if (cancelled) return;
            notices.push(`タブ構成を読み込めません: ${describe(e)}`);
          }
        } else if (startup.kind === "local") {
          openTab(connectionSchema.parse({ type: "local" }));
        } else if (startup.kind === "profile") {
          const profile = loadedProfiles.find(
            (p) => p.id === startup.profileId,
          );
          const raw = profile?.values;
          if (!profile || !raw) {
            notices.push("起動時に開く保存済みの接続が見つかりません");
          } else if (requiresSecretAtOpen(raw)) {
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
      setSessionReady(true);
      if (notices.length > 0) setNotice(notices.join(" / "));
    })();
    return () => {
      cancelled = true;
    };
  }, [openTab]);

  /** 保存するタブ構成（パスワード類を除く）。内容が変わったときだけ保存するため、文字列にして比べる。 */
  const sessionPayload = JSON.stringify({
    tabs: state.tabs.map((t) => ({
      title: t.title,
      values: stripSecrets(t.values),
    })),
    active: state.tabs.some((t) => t.id === state.activeId)
      ? state.tabs.findIndex((t) => t.id === state.activeId)
      : null,
  });
  const saveLayout = settings.startup.kind === "restore" && sessionReady;
  useEffect(() => {
    if (!saveLayout) return;
    const timer = setTimeout(() => {
      saveSessionState(JSON.parse(sessionPayload)).catch((e: unknown) =>
        setNotice(`タブ構成を保存できません: ${describe(e)}`),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [saveLayout, sessionPayload]);

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

  const activeTab = state.tabs.find((t) => t.id === state.activeId);

  /** 操作対象のペインと同じ接続で、画面を分割する。パスワードが要る場合は入力用のダイアログを開く。 */
  const splitTab = useCallback(
    (tabId: string, dir: SplitDir) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      const paneId = activePaneIdOf(tab);
      const pane = panesOf(tab).find((p) => p.id === paneId);
      if (!pane) return;
      const v = pane.values;
      if (isSecretMissing(v)) {
        setDialog({ initialValues: v, split: { tabId, dir } });
        return;
      }
      dispatch({
        type: "splitPane",
        tabId,
        dir,
        splitId: crypto.randomUUID(),
        pane: { id: crypto.randomUUID(), values: v },
      });
    },
    [state.tabs],
  );

  /** キー入力・貼り付けを、同時入力の送り先のペインへも送る。 */
  const onBroadcast = useCallback(
    (sourcePaneId: string, data: string) => {
      for (const id of broadcastTargets(state.tabs, sourcePaneId, broadcast)) {
        sendToPane(id, data);
      }
    },
    [state.tabs, broadcast],
  );

  /** スニペットを、操作中のペインへ送る。 */
  const onRunSnippet = useCallback(
    (snippet: Snippet) => {
      const tab = state.tabs.find((t) => t.id === state.activeId);
      if (!tab) return;
      const paneId = activePaneIdOf(tab);
      runSnippet(snippet, (data) => sendToPane(paneId, data))
        .then((done) => {
          if (!done)
            setNotice(
              `「${snippet.name}」を最後まで送れませんでした（送り先が閉じられました）`,
            );
        })
        .catch((e: unknown) =>
          setNotice(`スニペットを送れません: ${describe(e)}`),
        );
    },
    [state.tabs, state.activeId],
  );

  const modalOpen =
    dialogOpen ||
    settingsOpen ||
    snippetsOpen ||
    highlightsOpen ||
    paletteOpen ||
    shortcutsOpen ||
    hostKeyQueue.length > 0;

  // 見たタブの印は消す（切り替えたとき・ウィンドウに戻ったとき）。
  const [seenActiveId, setSeenActiveId] = useState<string | null>(null);
  if (state.activeId !== seenActiveId) {
    setSeenActiveId(state.activeId);
    if (state.activeId && attention.has(state.activeId)) {
      const next = new Set(attention);
      next.delete(state.activeId);
      setAttention(next);
    }
  }
  useEffect(() => {
    const onFocus = () =>
      setAttention((s) => {
        if (!state.activeId || !s.has(state.activeId)) return s;
        const next = new Set(s);
        next.delete(state.activeId);
        return next;
      });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [state.activeId]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // ダイアログ表示中は入力を妨げない。
      if (modalOpen) return;
      const action = shortcutFor(event, bindings);
      if (!action) return;
      event.preventDefault();
      switch (action.type) {
        case "new":
          setDialog({});
          break;
        case "close":
          // 分割しているときは、操作対象のペインだけを閉じる。
          if (activeTab) {
            dispatch({
              type: "closePane",
              tabId: activeTab.id,
              paneId: activePaneIdOf(activeTab),
            });
          }
          break;
        case "find": {
          // 検索は操作対象のペインに対して開く。
          const id = activeTab ? activePaneIdOf(activeTab) : null;
          if (id) setFindSignals((s) => ({ ...s, [id]: (s[id] ?? 0) + 1 }));
          break;
        }
        case "split":
          if (activeTab) splitTab(activeTab.id, action.dir);
          break;
        case "palette":
          setPaletteOpen(true);
          break;
        case "broadcast":
          setBroadcast((m) => (m === "off" ? "tab" : "off"));
          break;
        case "nextPane":
        case "previousPane":
          if (activeTab) {
            dispatch({
              type: "cyclePane",
              tabId: activeTab.id,
              delta: action.type === "nextPane" ? 1 : -1,
            });
          }
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
  }, [modalOpen, state.activeId, activeTab, splitTab, bindings]);

  const addTab = useCallback(
    (values: ConnectionValues, options?: SubmitOptions) => {
      if (dialog?.split) {
        dispatch({
          type: "splitPane",
          tabId: dialog.split.tabId,
          dir: dialog.split.dir,
          splitId: crypto.randomUUID(),
          pane: { id: crypto.randomUUID(), values },
        });
      } else if (dialog?.replacePane) {
        dispatch({
          type: "replacePane",
          tabId: dialog.replacePane.tabId,
          paneId: dialog.replacePane.paneId,
          pane: { id: crypto.randomUUID(), values },
        });
      } else {
        if (dialog?.replaceTabId) {
          dispatch({ type: "close", id: dialog.replaceTabId });
        }
        openTab(values);
      }
      setRecent((r) => ({
        list: recordRecent(r.list, values, Date.now()),
        dirty: true,
      }));
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

  /** 履歴から接続する。パスワードが要るSSHは、入力用のダイアログを開く。 */
  const onOpenRecent = useCallback(
    (entry: RecentEntry) => {
      const v = entry.values;
      if (requiresSecretAtOpen(v)) {
        setDialog({ initialValues: v });
        return;
      }
      addTab(v);
    },
    [addTab],
  );

  const onClearRecents = useCallback(
    () => setRecent({ list: [], dirty: true }),
    [],
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
      const needsSecret = isSecretMissing(tab.values);
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
      // `id` はペインの ID。
      const tab = state.tabs.find((t) => panesOf(t).some((p) => p.id === id));
      const pane = tab && panesOf(tab).find((p) => p.id === id);
      if (!tab || !pane) return;
      setDialog(
        tab.panes
          ? {
              initialValues: pane.values,
              replacePane: { tabId: tab.id, paneId: id },
            }
          : { initialValues: pane.values, replaceTabId: tab.id },
      );
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

  /** 保存済みの接続を開く。秘密情報が要る接続は、入力用のダイアログを開く。 */
  const onOpenProfile = useCallback(
    (profile: SavedProfile) => {
      const raw = profile.values;
      if (requiresSecretAtOpen(raw)) {
        setDialog({ initialValues: raw as DialogInitialValues });
        return;
      }
      const values = parseSavedValues(raw);
      if (!values) {
        setNotice(`保存済みの接続「${profile.name}」の内容が不正です`);
        return;
      }
      addTab(values);
    },
    [addTab],
  );

  const paletteCommands = useMemo(
    () =>
      buildPaletteCommands({
        tabs: state.tabs,
        activeId: state.activeId,
        snippets,
        recents: recent.list,
        profiles,
        broadcast,
        bindings,
        actions: {
          newConnection: () => setDialog({}),
          openSettings: () => setSettingsOpen(true),
          closePane: () => {
            if (activeTab) {
              dispatch({
                type: "closePane",
                tabId: activeTab.id,
                paneId: activePaneIdOf(activeTab),
              });
            }
          },
          nextTab: () => dispatch({ type: "activateRelative", delta: 1 }),
          previousTab: () => dispatch({ type: "activateRelative", delta: -1 }),
          activateTab: (id) => dispatch({ type: "activate", id }),
          split: (dir) => {
            if (activeTab) splitTab(activeTab.id, dir);
          },
          cyclePane: (delta) => {
            if (activeTab) {
              dispatch({ type: "cyclePane", tabId: activeTab.id, delta });
            }
          },
          find: () => {
            const id = activeTab ? activePaneIdOf(activeTab) : null;
            if (id) setFindSignals((s) => ({ ...s, [id]: (s[id] ?? 0) + 1 }));
          },
          duplicateTab: onDuplicateTab,
          setColor: (color) => {
            if (activeTab) {
              dispatch({ type: "setColor", id: activeTab.id, color });
            }
          },
          setBroadcast,
          runSnippet: onRunSnippet,
          manageSnippets: () => setSnippetsOpen(true),
          manageHighlights: () => setHighlightsOpen(true),
          openRecent: onOpenRecent,
          clearRecents: onClearRecents,
          openProfile: onOpenProfile,
          openShortcuts: () => setShortcutsOpen(true),
        },
      }),
    [
      state.tabs,
      state.activeId,
      activeTab,
      snippets,
      recent.list,
      profiles,
      broadcast,
      bindings,
      splitTab,
      onDuplicateTab,
      onRunSnippet,
      onOpenRecent,
      onClearRecents,
      onOpenProfile,
    ],
  );

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
        onColor={(id, color) => dispatch({ type: "setColor", id, color })}
        recents={recent.list}
        onOpenRecent={onOpenRecent}
        onClearRecents={onClearRecents}
        snippets={snippets}
        onRunSnippet={onRunSnippet}
        onManageSnippets={() => setSnippetsOpen(true)}
        onManageHighlights={() => setHighlightsOpen(true)}
        broadcast={broadcast}
        onBroadcastChange={setBroadcast}
        attention={attention}
      />
      {broadcast !== "off" && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 bg-amber-900/70 px-3 py-1 text-sm text-amber-100"
        >
          <span>
            同時入力中: 入力は
            {broadcastPaneCount(state.tabs, state.activeId, broadcast)}
            個のペインへ送られます（パスワードも送られます）
          </span>
          <button className="underline" onClick={() => setBroadcast("off")}>
            解除
          </button>
        </div>
      )}
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
        highlightRules={highlightRules}
        onAttention={onAttention}
        onBroadcast={onBroadcast}
        onActivatePane={(tabId, paneId) =>
          dispatch({ type: "activatePane", tabId, paneId })
        }
        onResizeSplit={(tabId, splitId, ratio) =>
          dispatch({ type: "resizeSplit", tabId, splitId, ratio })
        }
        onSplit={splitTab}
        onClosePane={(tabId, paneId) =>
          dispatch({ type: "closePane", tabId, paneId })
        }
      />
      <ConnectionDialog
        open={dialogOpen}
        initialValues={dialog?.initialValues}
        onOpenChange={(open) => !open && setDialog(null)}
        onSubmit={addTab}
        profiles={profiles}
        onDeleteProfile={onDeleteProfile}
        recents={recent.list}
      />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        profiles={profiles}
        onSave={onSaveSettings}
        onOpenShortcuts={() => {
          setSettingsOpen(false);
          setShortcutsOpen(true);
        }}
      />
      <ShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        bindings={bindings}
        onSave={onSaveBindings}
      />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        commands={paletteCommands}
      />
      <HighlightsDialog
        open={highlightsOpen}
        onOpenChange={setHighlightsOpen}
        rules={highlightRules}
        onSave={onSaveHighlights}
      />
      <SnippetsDialog
        open={snippetsOpen}
        onOpenChange={setSnippetsOpen}
        snippets={snippets}
        onSave={onSaveSnippets}
      />
      <HostKeyDialog request={hostKeyQueue[0] ?? null} onRespond={respond} />
    </div>
  );
}

export default App;

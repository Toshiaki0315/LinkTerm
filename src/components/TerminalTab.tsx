import { Clock, FolderOpen, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAutoReconnect } from "../hooks/useAutoReconnect";
import { useTerminalSession } from "../hooks/useTerminalSession";
import {
  isSecretMissing,
  toStartRequest,
  type ConnectionValues,
} from "../lib/connection-schema";
import { LoginRunner, parseLoginScript } from "../lib/auto-login";
import { OutputMatcher, type HighlightRule } from "../lib/highlight";
import { NOTIFY_INTERVAL_MS, Throttle, notifyMatch } from "../lib/notify";
import { exportText } from "../lib/export-text";
import { registerPaneActions } from "../lib/pane-actions";
import { registerPaneInput } from "../lib/pane-input";
import { echoFor, isLocalEchoOn, type EchoMode } from "../lib/local-echo";
import type { Appearance, AutoReconnect } from "../lib/settings";
import { copyText, pasteText } from "../lib/clipboard";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { EchoControl } from "./EchoControl";
import { SearchBar } from "./SearchBar";
import { SftpDialog } from "./SftpDialog";
import { LogControl } from "./LogControl";
import { SerialControls } from "./SerialControls";
import { Button } from "./ui/button";
import { TerminalView, type TerminalHandle } from "./TerminalView";
import type { SessionStatus } from "../hooks/useTerminalSession";

const DISABLED_AUTO_RECONNECT: AutoReconnect = {
  enabled: false,
  delaySeconds: 5,
  maxAttempts: 5,
};

interface Props {
  tabId: string;
  title: string;
  values: ConnectionValues;
  active: boolean;
  onStatusChange: (id: string, status: SessionStatus) => void;
  /** 接続要求を組み立て終えた（パスワード等を保持し続ける必要がなくなった）。 */
  onSecretsConsumed: (id: string) => void;
  /** 保持していない秘密情報の再入力が必要な再接続。 */
  onEditAndReconnect: (id: string) => void;
  appearance?: Appearance;
  /** 異常な切断のあとの自動再接続。省略すると無効。 */
  autoReconnect?: AutoReconnect;
  /** 増えたら検索バーを開く（⌘F）。 */
  findSignal?: number;
  /** 復元したタブ: 自動では接続せず、「接続」ボタンで接続する。 */
  deferStart?: boolean;
  /** 各行に時刻を表示するか。 */
  showTimestamps?: boolean;
  /** 時刻の表示を切り替える。省略するとボタンを出さない。 */
  onToggleTimestamps?: () => void;
  /** キー入力・貼り付けを、ほかのペインにも送る（同時入力）。省略すると送らない。 */
  onBroadcast?: (data: string) => void;
  /** キーワードのハイライト規則（色付けと、見つけたときの通知）。 */
  highlightRules?: HighlightRule[];
  /** 通知する規則に一致した（このペインが見えていないとき）。タブの注目表示に使う。 */
  onAttention?: () => void;
  /** 画面を分割する（右クリックメニュー）。省略すると項目を出さない。 */
  onSplit?: (dir: "row" | "column") => void;
  /** このペインを閉じる（分割しているときだけ渡す）。 */
  onClosePane?: () => void;
}

/** 1タブ = 1セッション。xterm とセッションをここで結び付ける。 */
export function TerminalTab({
  tabId,
  title,
  values,
  active,
  onStatusChange,
  onSecretsConsumed,
  onEditAndReconnect,
  appearance,
  autoReconnect = DISABLED_AUTO_RECONNECT,
  findSignal = 0,
  deferStart = false,
  highlightRules,
  showTimestamps = false,
  onToggleTimestamps,
  onAttention,
  onBroadcast,
  onSplit,
  onClosePane,
}: Props) {
  const termRef = useRef<TerminalHandle>(null);
  const startedRef = useRef(false);

  /** 自動ログイン（Telnet / シリアルで、スクリプトがあるとき）。 */
  const loginRef = useRef<LoginRunner | null>(null);
  const decoderRef = useRef<TextDecoder | null>(null);

  /** 通知する規則の照合（規則が変わったら作り直す）。 */
  const matcherRef = useRef<OutputMatcher | null>(null);
  const throttleRef = useRef(new Throttle(NOTIFY_INTERVAL_MS));
  /** 最新の値（出力のコールバックから読む）。 */
  const liveRef = useRef({ active, title, onAttention });
  useEffect(() => {
    liveRef.current = { active, title, onAttention };
  }, [active, title, onAttention]);
  useEffect(() => {
    const notifying = (highlightRules ?? []).some((r) => r.notify);
    matcherRef.current = notifying
      ? new OutputMatcher(highlightRules ?? [])
      : null;
  }, [highlightRules]);

  /** ベルが鳴った直後の、画面の点滅。 */
  const [bellFlash, setBellFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** ベル: 画面を一瞬光らせる。見ていなければ、タブの注目表示も出す。 */
  const onBell = useCallback(() => {
    setBellFlash(true);
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => {
      flashTimer.current = null;
      setBellFlash(false);
    }, 150);
    const live = liveRef.current;
    if (!live.active || !document.hasFocus()) live.onAttention?.();
  }, []);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    },
    [],
  );

  /** 通知する規則に一致したとき。画面を見ていなければ、通知とタブの注目表示を出す。 */
  const onMatches = useCallback((hits: HighlightRule[]) => {
    const live = liveRef.current;
    if (live.active && document.hasFocus()) return;
    live.onAttention?.();
    for (const rule of hits) {
      if (!throttleRef.current.allow(rule.id)) continue;
      notifyMatch(
        "キーワードを検出しました",
        `「${rule.pattern}」 — ${live.title}`,
      ).catch((e: unknown) => console.error("通知に失敗しました:", e));
    }
  }, []);

  const onData = useCallback(
    (data: Uint8Array) => {
      termRef.current?.write(data);
      const runner = loginRef.current;
      const loginActive = runner !== null && !runner.done;
      const matcher = matcherRef.current;
      if (!loginActive && !matcher) return;
      decoderRef.current ??= new TextDecoder();
      const text = decoderRef.current.decode(data, { stream: true });
      if (runner && loginActive) {
        // 出力が届いた時点で、セッションは確立している。
        runner.begin();
        runner.feed(text);
      }
      if (matcher) {
        const hits = matcher.feed(text);
        if (hits.length > 0) onMatches(hits);
      }
    },
    [onMatches],
  );
  const { status, sessionId, error, remoteEcho, start, write, resize } =
    useTerminalSession({ onData });

  /** ローカルエコー。Telnet / シリアルだけが対象で、接続設定の値で始め、実行中に切り替えられる。 */
  const supportsEcho = values.type === "telnet" || values.type === "serial";
  const [echoMode, setEchoMode] = useState<EchoMode>(
    values.type === "telnet" || values.type === "serial"
      ? values.localEcho
      : "off",
  );
  const localEcho = supportsEcho && isLocalEchoOn(echoMode, remoteEcho);

  const [searchOpen, setSearchOpen] = useState(false);
  const [sftpOpen, setSftpOpen] = useState(false);
  /** 画面の保存の結果（成功・失敗）の表示。 */
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [seenFindSignal, setSeenFindSignal] = useState(findSignal);
  if (findSignal !== seenFindSignal) {
    // 検索の要求が来た（⌘F）。描画中の状態更新は、値が変わったときの1回だけ。
    setSeenFindSignal(findSignal);
    setSearchOpen(true);
  }
  /** 右クリックメニュー。選択の有無は、開いた時点のものを使う。 */
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);
  const logError = (what: string) => (e: unknown) =>
    console.error(`${what}に失敗しました:`, e);
  /** 画面の内容（スクロールバックを含む）を、保存ダイアログで選んだファイルへ保存する。 */
  const saveScreenText = () => {
    const text = termRef.current?.getText() ?? "";
    if (text === "") {
      setSaveNotice("保存する内容がありません");
      return;
    }
    exportText(text)
      .then((path) => setSaveNotice(path ? `保存しました: ${path}` : null))
      .catch((e: unknown) =>
        setSaveNotice(
          `保存できません: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
  };
  /** メニュー項目を作る。右クリックのイベント処理の中で呼ぶ（ref を描画中に読まないため）。 */
  const buildMenuItems = (hasSelection: boolean): ContextMenuItem[] => [
    {
      label: "コピー",
      disabled: !hasSelection,
      onSelect: () => {
        copyText(termRef.current?.getSelection() ?? "").catch(
          logError("コピー"),
        );
      },
    },
    {
      label: "貼り付け",
      onSelect: () => {
        pasteText()
          .then((text) => {
            if (text !== "") termRef.current?.paste(text);
          })
          .catch(logError("貼り付け"));
      },
    },
    { label: "すべて選択", onSelect: () => termRef.current?.selectAll() },
    { label: "検索…", onSelect: () => setSearchOpen(true) },
    { label: "画面をクリア", onSelect: () => termRef.current?.clear() },
    {
      label: "画面をテキストで保存…",
      onSelect: () => saveScreenText(),
    },
    ...(onSplit
      ? [
          {
            label: "右に分割（⌘D）",
            separatorBefore: true,
            onSelect: () => onSplit("row"),
          },
          { label: "下に分割（⌘⇧D）", onSelect: () => onSplit("column") },
        ]
      : []),
    ...(onClosePane
      ? [{ label: "ペインを閉じる", onSelect: onClosePane }]
      : []),
  ];

  const closeSearch = () => {
    setSearchOpen(false);
    termRef.current?.clearSearch();
    termRef.current?.focus();
  };

  const note = useCallback((text: string) => {
    termRef.current?.write(new TextEncoder().encode(`\r\n--- ${text} ---\r\n`));
  }, []);

  /** 接続し、自動ログインのスクリプトがあれば始める。 */
  const launch = useCallback(async () => {
    loginRef.current?.stop();
    loginRef.current = null;
    decoderRef.current = null;
    const request = toStartRequest(
      values,
      termRef.current?.size() ?? { cols: 80, rows: 24 },
    );
    let runner: LoginRunner | null = null;
    if (values.type === "telnet" || values.type === "serial") {
      const parsed = parseLoginScript(values.loginScript ?? "");
      if (parsed.ok && parsed.steps.length > 0) {
        // パスワードはここで取り込む（接続後、画面側の保持分は消される）。
        runner = new LoginRunner({
          steps: parsed.steps,
          password: values.loginPassword ?? "",
          send: (data) =>
            write(data).catch((e: unknown) =>
              console.error("自動ログインの送信に失敗しました:", e),
            ),
          onDone: () => note("自動ログインを完了しました"),
          onTimeout: (waiting) =>
            note(`自動ログイン: 「${waiting}」が表示されないため中断しました`),
        });
        loginRef.current = runner;
      }
    }
    const connected = await start(request);
    if (!runner || loginRef.current !== runner) return;
    if (connected) runner.begin();
    else runner.stop();
  }, [values, start, write, note]);

  useEffect(() => {
    // 切断・エラーになったら、自動ログインは続けない。
    if (status === "closed" || status === "error") loginRef.current?.stop();
  }, [status]);

  useEffect(
    () => () => {
      loginRef.current?.stop();
    },
    [],
  );

  useEffect(() => {
    // StrictMode の二重実行で接続が重複しないようにする。
    if (startedRef.current || deferStart) return;
    startedRef.current = true;
    void launch();
    onSecretsConsumed(tabId);
  }, [launch, tabId, onSecretsConsumed, deferStart]);

  useEffect(() => {
    onStatusChange(tabId, status);
  }, [tabId, status, onStatusChange]);

  /** このペインへ送る（ローカルエコーを含む）。同時入力は含まない。 */
  const sendDirect = useCallback(
    (data: string) => {
      if (localEcho) {
        termRef.current?.write(new TextEncoder().encode(echoFor(data)));
      }
      write(data).catch((e: unknown) =>
        console.error("送信に失敗しました:", e),
      );
    },
    [write, localEcho],
  );
  /** キー入力・貼り付け。同時入力がオンなら、ほかのペインにも送る。 */
  const onInput = useCallback(
    (data: string) => {
      sendDirect(data);
      onBroadcast?.(data);
    },
    [sendDirect, onBroadcast],
  );
  // スニペットや同時入力など、端末の外からの入力は、同時入力へ再び回さずに送る（ループ防止）。
  useEffect(() => registerPaneInput(tabId, sendDirect), [tabId, sendDirect]);
  // コマンドパレットなど、ペインの外からの操作（最新の処理を呼ぶ）。
  const saveScreenRef = useRef(saveScreenText);
  useEffect(() => {
    saveScreenRef.current = saveScreenText;
  });
  useEffect(
    () =>
      registerPaneActions(tabId, { exportText: () => saveScreenRef.current() }),
    [tabId],
  );

  const onResize = useCallback(
    (cols: number, rows: number) => {
      resize(cols, rows).catch((e: unknown) =>
        console.error("リサイズに失敗しました:", e),
      );
    },
    [resize],
  );

  /** パスワード認証のSSHは、消去済みのパスワードを入力し直す必要がある。 */
  const needsSecret = isSecretMissing(values);

  const reconnect = useCallback(() => {
    if (needsSecret) {
      onEditAndReconnect(tabId);
      return;
    }
    // 初回の接続（復元したタブ）では区切り線を出さない。
    if (status !== "idle") {
      termRef.current?.write(
        new TextEncoder().encode("\r\n--- 再接続 ---\r\n"),
      );
    }
    void launch();
    onSecretsConsumed(tabId);
  }, [
    needsSecret,
    onEditAndReconnect,
    onSecretsConsumed,
    tabId,
    launch,
    status,
  ]);

  const auto = useAutoReconnect({
    enabled: autoReconnect.enabled,
    delaySeconds: autoReconnect.delaySeconds,
    maxAttempts: autoReconnect.maxAttempts,
    status,
    canReconnect: !needsSecret,
    onReconnect: reconnect,
  });
  const maxLabel =
    autoReconnect.maxAttempts === 0 ? "∞" : String(autoReconnect.maxAttempts);

  return (
    <div className="relative h-full w-full">
      <div className="absolute right-3 top-2 z-10 flex items-center gap-2">
        {values.type === "serial" && (
          <SerialControls
            key={sessionId ?? "none"}
            sessionId={status === "connected" ? sessionId : null}
          />
        )}
        {onToggleTimestamps && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="タイムスタンプ表示"
            aria-pressed={showTimestamps}
            title="各行に時刻を表示（右端）"
            className={
              showTimestamps ? "bg-sky-500/20 text-sky-300" : undefined
            }
            onClick={onToggleTimestamps}
          >
            <Clock className="h-4 w-4" />
          </Button>
        )}
        {values.type === "ssh" && status === "connected" && sessionId && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="ファイル転送（SFTP）"
            title="ファイル転送（SFTP）"
            onClick={() => setSftpOpen(true)}
          >
            <FolderOpen className="h-4 w-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label="検索（⌘F）"
          title="検索（⌘F）"
          onClick={() => setSearchOpen(true)}
        >
          <Search className="h-4 w-4" />
        </Button>
        {supportsEcho && (
          <EchoControl
            mode={echoMode}
            effective={localEcho}
            onChange={setEchoMode}
          />
        )}
        <LogControl
          sessionId={status === "connected" ? sessionId : null}
          title={title}
        />
      </div>
      {values.type === "ssh" && sessionId && (
        <SftpDialog
          open={sftpOpen && status === "connected"}
          onOpenChange={setSftpOpen}
          sessionId={sessionId}
          title={title}
        />
      )}
      {saveNotice && (
        <div
          role="status"
          className="absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-3 bg-neutral-800/95 px-3 py-1 text-xs text-neutral-200"
        >
          <span className="break-all">{saveNotice}</span>
          <button
            className="shrink-0 underline"
            onClick={() => setSaveNotice(null)}
          >
            閉じる
          </button>
        </div>
      )}
      {bellFlash && (
        <div
          aria-hidden
          data-testid="bell-flash"
          className="pointer-events-none absolute inset-0 z-10 bg-white/10 ring-2 ring-inset ring-sky-400/60"
        />
      )}
      {searchOpen && (
        <SearchBar
          onFind={(term, options, direction, incremental) =>
            termRef.current?.find(term, options, direction, incremental) ??
            false
          }
          onClear={() => termRef.current?.clearSearch()}
          onClose={closeSearch}
        />
      )}
      <TerminalView
        ref={termRef}
        active={active}
        appearance={appearance}
        highlightRules={highlightRules}
        showTimestamps={showTimestamps}
        onBell={onBell}
        onInput={onInput}
        onResize={onResize}
        onContextMenu={({ x, y }) =>
          setMenu({
            x,
            y,
            items: buildMenuItems(termRef.current?.hasSelection() ?? false),
          })
        }
      />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => {
            setMenu(null);
            termRef.current?.focus();
          }}
        />
      )}
      {status === "idle" && deferStart && (
        <div
          role="status"
          className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 bg-neutral-900/90 px-3 py-2 text-sm text-neutral-200"
        >
          <span>前回のタブです（未接続）</span>
          <Button size="sm" onClick={reconnect}>
            接続
          </Button>
        </div>
      )}
      {(status === "error" || status === "closed") && (
        <div
          role="status"
          className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 bg-neutral-900/90 px-3 py-2 text-sm text-neutral-200"
        >
          <span>
            {status === "error"
              ? `接続エラー: ${error ?? "不明なエラー"}`
              : "セッションが終了しました"}
          </span>
          <span className="flex items-center gap-2">
            {autoReconnect.enabled && status === "error" && (
              <AutoReconnectNotice
                needsSecret={needsSecret}
                remaining={auto.remaining}
                attempt={auto.attempt}
                maxLabel={maxLabel}
                maxAttempts={autoReconnect.maxAttempts}
                exhausted={auto.exhausted}
                onCancel={auto.cancel}
              />
            )}
            <Button size="sm" onClick={reconnect}>
              再接続
            </Button>
          </span>
        </div>
      )}
    </div>
  );
}

/** 自動再接続の状況（カウントダウン・上限・再接続できない理由）の表示。 */
function AutoReconnectNotice({
  needsSecret,
  remaining,
  attempt,
  maxLabel,
  maxAttempts,
  exhausted,
  onCancel,
}: {
  needsSecret: boolean;
  remaining: number | null;
  attempt: number;
  maxLabel: string;
  maxAttempts: number;
  exhausted: boolean;
  onCancel: () => void;
}) {
  if (needsSecret) {
    return (
      <span className="text-amber-300">
        パスワード認証のため、自動再接続できません
      </span>
    );
  }
  if (exhausted) {
    return (
      <span className="text-amber-300">
        上限（{maxAttempts}回）に達したため、自動再接続を止めました
      </span>
    );
  }
  if (remaining === null) return null;
  return (
    <span className="flex items-center gap-2 text-sky-300">
      {remaining}秒後に自動再接続します（{attempt + 1}/{maxLabel}回目）
      <Button
        size="sm"
        variant="outline"
        aria-label="自動再接続をキャンセル"
        onClick={onCancel}
      >
        キャンセル
      </Button>
    </span>
  );
}

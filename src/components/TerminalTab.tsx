import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAutoReconnect } from "../hooks/useAutoReconnect";
import { useTerminalSession } from "../hooks/useTerminalSession";
import {
  isSecretMissing,
  toStartRequest,
  type ConnectionValues,
} from "../lib/connection-schema";
import { LoginRunner, parseLoginScript } from "../lib/auto-login";
import { registerPaneInput } from "../lib/pane-input";
import { echoFor, isLocalEchoOn, type EchoMode } from "../lib/local-echo";
import type { Appearance, AutoReconnect } from "../lib/settings";
import { copyText, pasteText } from "../lib/clipboard";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { EchoControl } from "./EchoControl";
import { SearchBar } from "./SearchBar";
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
  onSplit,
  onClosePane,
}: Props) {
  const termRef = useRef<TerminalHandle>(null);
  const startedRef = useRef(false);

  /** 自動ログイン（Telnet / シリアルで、スクリプトがあるとき）。 */
  const loginRef = useRef<LoginRunner | null>(null);
  const decoderRef = useRef<TextDecoder | null>(null);

  const onData = useCallback((data: Uint8Array) => {
    termRef.current?.write(data);
    const runner = loginRef.current;
    if (runner && !runner.done) {
      // 出力が届いた時点で、セッションは確立している。
      runner.begin();
      decoderRef.current ??= new TextDecoder();
      runner.feed(decoderRef.current.decode(data, { stream: true }));
    }
  }, []);
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

  const onInput = useCallback(
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
  // スニペットなど、端末の外からの入力もキー入力と同じ経路で送る。
  useEffect(() => registerPaneInput(tabId, onInput), [tabId, onInput]);

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

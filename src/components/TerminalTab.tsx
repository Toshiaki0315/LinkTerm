import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTerminalSession } from "../hooks/useTerminalSession";
import {
  toStartRequest,
  type ConnectionValues,
} from "../lib/connection-schema";
import { echoFor, isLocalEchoOn, type EchoMode } from "../lib/local-echo";
import type { Appearance } from "../lib/settings";
import { copyText, pasteText } from "../lib/clipboard";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { EchoControl } from "./EchoControl";
import { SearchBar } from "./SearchBar";
import { LogControl } from "./LogControl";
import { SerialControls } from "./SerialControls";
import { Button } from "./ui/button";
import { TerminalView, type TerminalHandle } from "./TerminalView";
import type { SessionStatus } from "../hooks/useTerminalSession";

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
  /** 増えたら検索バーを開く（⌘F）。 */
  findSignal?: number;
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
  findSignal = 0,
}: Props) {
  const termRef = useRef<TerminalHandle>(null);
  const startedRef = useRef(false);

  const onData = useCallback(
    (data: Uint8Array) => termRef.current?.write(data),
    [],
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
  ];

  const closeSearch = () => {
    setSearchOpen(false);
    termRef.current?.clearSearch();
    termRef.current?.focus();
  };

  useEffect(() => {
    // StrictMode の二重実行で接続が重複しないようにする。
    if (startedRef.current) return;
    startedRef.current = true;
    void start(
      toStartRequest(values, termRef.current?.size() ?? { cols: 80, rows: 24 }),
    );
    onSecretsConsumed(tabId);
  }, [start, values, tabId, onSecretsConsumed]);

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
  const onResize = useCallback(
    (cols: number, rows: number) => {
      resize(cols, rows).catch((e: unknown) =>
        console.error("リサイズに失敗しました:", e),
      );
    },
    [resize],
  );

  /** パスワード認証のSSHは、消去済みのパスワードを入力し直す必要がある。 */
  const needsSecret =
    values.type === "ssh" &&
    values.authKind === "password" &&
    values.password === "";

  const reconnect = useCallback(() => {
    if (needsSecret) {
      onEditAndReconnect(tabId);
      return;
    }
    termRef.current?.write(new TextEncoder().encode("\r\n--- 再接続 ---\r\n"));
    void start(
      toStartRequest(values, termRef.current?.size() ?? { cols: 80, rows: 24 }),
    );
  }, [needsSecret, onEditAndReconnect, tabId, start, values]);

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
          <Button size="sm" onClick={reconnect}>
            再接続
          </Button>
        </div>
      )}
    </div>
  );
}

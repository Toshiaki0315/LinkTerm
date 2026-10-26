import { useCallback, useEffect, useRef } from "react";
import { useTerminalSession } from "../hooks/useTerminalSession";
import {
  toStartRequest,
  type ConnectionValues,
} from "../lib/connection-schema";
import { LogControl } from "./LogControl";
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
}: Props) {
  const termRef = useRef<TerminalHandle>(null);
  const startedRef = useRef(false);

  const onData = useCallback(
    (data: Uint8Array) => termRef.current?.write(data),
    [],
  );
  const { status, sessionId, error, start, write, resize } = useTerminalSession(
    {
      onData,
    },
  );

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
      write(data).catch((e: unknown) =>
        console.error("送信に失敗しました:", e),
      );
    },
    [write],
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
      <LogControl
        sessionId={status === "connected" ? sessionId : null}
        title={title}
      />
      <TerminalView
        ref={termRef}
        active={active}
        onInput={onInput}
        onResize={onResize}
      />
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

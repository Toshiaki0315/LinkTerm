import { useCallback, useEffect, useRef } from "react";
import { useTerminalSession } from "../hooks/useTerminalSession";
import {
  toStartRequest,
  type ConnectionValues,
} from "../lib/connection-schema";
import { LogControl } from "./LogControl";
import { TerminalView, type TerminalHandle } from "./TerminalView";
import type { SessionStatus } from "../hooks/useTerminalSession";

interface Props {
  tabId: string;
  title: string;
  values: ConnectionValues;
  active: boolean;
  onStatusChange: (id: string, status: SessionStatus) => void;
}

/** 1タブ = 1セッション。xterm とセッションをここで結び付ける。 */
export function TerminalTab({
  tabId,
  title,
  values,
  active,
  onStatusChange,
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
  }, [start, values]);

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
          className="absolute inset-x-0 bottom-0 bg-neutral-900/90 px-3 py-2 text-sm text-neutral-200"
        >
          {status === "error"
            ? `接続エラー: ${error ?? "不明なエラー"}`
            : "セッションが終了しました"}
        </div>
      )}
    </div>
  );
}

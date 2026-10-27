import { useCallback, useEffect, useRef, useState } from "react";
import {
  closeSession,
  onTerminalClosed,
  onTerminalData,
  onTerminalEcho,
  resizeSession,
  startSession,
  writeToSession,
  type StartRequest,
} from "../lib/terminal-api";

export type SessionStatus =
  "idle" | "connecting" | "connected" | "closed" | "error";

export interface UseTerminalSessionOptions {
  /** セッションからの生バイト列。エンコーディング変換は呼び出し側（描画層）で行う。 */
  onData: (data: Uint8Array) => void;
}

/** start 完了前に届いたイベントを保持する上限（暴走防止）。 */
const MAX_EARLY_CHUNKS = 1024;

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export function useTerminalSession({ onData }: UseTerminalSessionOptions) {
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 接続先がエコーしているか。判定できない（未接続・シリアル等）間は `null`。 */
  const [remoteEcho, setRemoteEcho] = useState<boolean | null>(null);

  const idRef = useRef<string | null>(null);
  const startingRef = useRef(false);
  const mountedRef = useRef(true);
  /** バックエンド側でセッションが既に終了しているか（二重closeの防止）。 */
  const endedRef = useRef(false);
  const onDataRef = useRef(onData);
  const earlyData = useRef(new Map<string, Uint8Array[]>());
  const earlyClosed = useRef(new Map<string, string | null>());
  const earlyEcho = useRef(new Map<string, boolean>());

  useEffect(() => {
    onDataRef.current = onData;
  }, [onData]);

  const applyClosed = useCallback((reason: string | null) => {
    endedRef.current = true;
    setStatus(reason ? "error" : "closed");
    setError(reason);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const id = idRef.current;
      if (id && !endedRef.current) {
        endedRef.current = true;
        closeSession(id).catch((e: unknown) =>
          console.error(`セッション ${id} の終了に失敗しました:`, e),
        );
      }
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const register = (p: Promise<() => void>) => {
      p.then((un) => (disposed ? un() : unlisteners.push(un))).catch(
        (e: unknown) => {
          setStatus("error");
          setError(errorMessage(e));
        },
      );
    };

    register(
      onTerminalData((id, data) => {
        if (id === idRef.current) {
          onDataRef.current(data);
        } else if (startingRef.current) {
          const chunks = earlyData.current.get(id) ?? [];
          if (chunks.length < MAX_EARLY_CHUNKS) chunks.push(data);
          earlyData.current.set(id, chunks);
        }
      }),
    );
    register(
      onTerminalClosed((id, reason) => {
        if (id === idRef.current) {
          applyClosed(reason);
        } else if (startingRef.current) {
          earlyClosed.current.set(id, reason);
        }
      }),
    );

    register(
      onTerminalEcho((id, echo) => {
        if (id === idRef.current) {
          setRemoteEcho(echo);
        } else if (startingRef.current) {
          earlyEcho.current.set(id, echo);
        }
      }),
    );

    return () => {
      disposed = true;
      unlisteners.forEach((un) => un());
    };
  }, [applyClosed]);

  const start = useCallback(
    async (request: StartRequest) => {
      setStatus("connecting");
      setError(null);
      setRemoteEcho(null);
      startingRef.current = true;
      try {
        const id = await startSession(request);
        if (!mountedRef.current) {
          // 接続中にタブが閉じられた場合、確立したセッションを残さない。
          await closeSession(id);
          return;
        }
        idRef.current = id;
        endedRef.current = false;
        setSessionId(id);
        setStatus("connected");
        for (const chunk of earlyData.current.get(id) ?? []) {
          onDataRef.current(chunk);
        }
        if (earlyEcho.current.has(id)) {
          setRemoteEcho(earlyEcho.current.get(id) ?? null);
        }
        if (earlyClosed.current.has(id)) {
          applyClosed(earlyClosed.current.get(id) ?? null);
        }
      } catch (e) {
        setStatus("error");
        setError(errorMessage(e));
      } finally {
        startingRef.current = false;
        earlyData.current.clear();
        earlyClosed.current.clear();
        earlyEcho.current.clear();
      }
    },
    [applyClosed],
  );

  const write = useCallback(async (data: string) => {
    if (idRef.current) await writeToSession(idRef.current, data);
  }, []);

  const resize = useCallback(async (cols: number, rows: number) => {
    if (idRef.current) await resizeSession(idRef.current, cols, rows);
  }, []);

  const close = useCallback(async () => {
    const id = idRef.current;
    if (!id) return;
    endedRef.current = true;
    await closeSession(id);
    setStatus("closed");
  }, []);

  return {
    status,
    sessionId,
    error,
    remoteEcho,
    start,
    write,
    resize,
    close,
  };
}

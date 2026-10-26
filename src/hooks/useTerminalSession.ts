import { useCallback, useEffect, useRef, useState } from "react";
import {
  closeSession,
  onTerminalClosed,
  onTerminalData,
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

  const idRef = useRef<string | null>(null);
  const startingRef = useRef(false);
  const onDataRef = useRef(onData);
  const earlyData = useRef(new Map<string, Uint8Array[]>());
  const earlyClosed = useRef(new Map<string, string | null>());

  useEffect(() => {
    onDataRef.current = onData;
  }, [onData]);

  const applyClosed = useCallback((reason: string | null) => {
    setStatus(reason ? "error" : "closed");
    setError(reason);
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

    return () => {
      disposed = true;
      unlisteners.forEach((un) => un());
    };
  }, [applyClosed]);

  const start = useCallback(
    async (request: StartRequest) => {
      setStatus("connecting");
      setError(null);
      startingRef.current = true;
      try {
        const id = await startSession(request);
        idRef.current = id;
        setSessionId(id);
        setStatus("connected");
        for (const chunk of earlyData.current.get(id) ?? []) {
          onDataRef.current(chunk);
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
    await closeSession(id);
    setStatus("closed");
  }, []);

  return { status, sessionId, error, start, write, resize, close };
}

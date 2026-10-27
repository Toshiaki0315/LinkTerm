import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionStatus } from "./useTerminalSession";

/** この時間つながり続けたら、安定して接続できたとみなし、試行回数を数え直す。 */
export const STABLE_CONNECTION_MS = 10_000;

interface Options {
  enabled: boolean;
  /** 切断から再接続までの待ち時間（秒）。 */
  delaySeconds: number;
  /** 連続して試す回数。0 は無制限。 */
  maxAttempts: number;
  status: SessionStatus;
  /** 自動で再接続できる接続か（パスワードの再入力が要るものは不可）。 */
  canReconnect: boolean;
  onReconnect: () => void;
}

/**
 * 異常な切断（`error`）のあとで、一定時間待って自動的に再接続する。
 *
 * 正常な終了（`closed`。`exit` など）では再接続しない。
 */
export function useAutoReconnect({
  enabled,
  delaySeconds,
  maxAttempts,
  status,
  canReconnect,
  onReconnect,
}: Options) {
  const [attempt, setAttempt] = useState(0);
  const [cancelled, setCancelled] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const elapsedRef = useRef(0);
  const onReconnectRef = useRef(onReconnect);

  useEffect(() => {
    onReconnectRef.current = onReconnect;
  }, [onReconnect]);

  const exhaustedByLimit = maxAttempts > 0 && attempt >= maxAttempts;
  const armed =
    enabled &&
    status === "error" &&
    canReconnect &&
    !cancelled &&
    !exhaustedByLimit;

  // 切断が始まった・終わったタイミングで、経過時間とキャンセルを初期化する。
  const [prevArmed, setPrevArmed] = useState(false);
  if (armed !== prevArmed) {
    setPrevArmed(armed);
    setElapsed(0);
  }
  const [prevStatus, setPrevStatus] = useState(status);
  if (status !== prevStatus) {
    setPrevStatus(status);
    if (status !== "error") setCancelled(false);
  }

  useEffect(() => {
    if (!armed) return;
    elapsedRef.current = 0;
    const timer = setInterval(() => {
      elapsedRef.current += 1;
      setElapsed(elapsedRef.current);
      if (elapsedRef.current >= delaySeconds) {
        clearInterval(timer);
        setAttempt((a) => a + 1);
        onReconnectRef.current();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [armed, delaySeconds]);

  useEffect(() => {
    if (status !== "connected") return;
    const timer = setTimeout(() => setAttempt(0), STABLE_CONNECTION_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const cancel = useCallback(() => setCancelled(true), []);

  return {
    /** 次の再接続までの秒数。待っていないときは `null`。 */
    remaining: armed ? Math.max(0, delaySeconds - elapsed) : null,
    /** 連続して再接続を試した回数。 */
    attempt,
    /** 上限の回数に達して、自動再接続をやめた。 */
    exhausted: enabled && status === "error" && exhaustedByLimit,
    cancel,
  };
}

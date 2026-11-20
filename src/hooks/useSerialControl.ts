import { useCallback, useState } from "react";
import {
  sendBreak,
  setControlSignal,
  setDisplayMode,
  type ControlSignal,
} from "../lib/terminal-api";

const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

const INITIAL_SIGNALS: Record<ControlSignal, boolean> = {
  dtr: true,
  rts: true,
};

/**
 * シリアル用の操作: DTR / RTS、ブレーク送信、16進表示。画面は持たず、状態と操作だけを返す。
 *
 * 制御信号の現在値は読み取れないため、ポートを開いた直後の状態（オン）から、
 * 最後に設定した値を表示する。セッションが変わったら（再接続）初期値に戻す。
 */
export function useSerialControl(sessionId: string | null) {
  const [signals, setSignals] = useState(INITIAL_SIGNALS);
  const [hex, setHex] = useState(false);
  const [breaking, setBreaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seenSession, setSeenSession] = useState(sessionId);
  if (sessionId !== seenSession) {
    // セッションが変わった。描画中の状態更新は、値が変わったときの1回だけ。
    setSeenSession(sessionId);
    setSignals(INITIAL_SIGNALS);
    setHex(false);
    setBreaking(false);
    setError(null);
  }
  const disabled = sessionId === null;

  const toggleSignal = useCallback(
    async (signal: ControlSignal) => {
      if (!sessionId) return;
      const next = !signals[signal];
      setError(null);
      try {
        await setControlSignal(sessionId, signal, next);
        setSignals((s) => ({ ...s, [signal]: next }));
      } catch (e) {
        setError(
          `${signal.toUpperCase()} を設定できません: ${errorMessage(e)}`,
        );
      }
    },
    [sessionId, signals],
  );

  const doBreak = useCallback(async () => {
    if (!sessionId) return;
    setError(null);
    setBreaking(true);
    try {
      await sendBreak(sessionId);
    } catch (e) {
      setError(`ブレークを送信できません: ${errorMessage(e)}`);
    } finally {
      setBreaking(false);
    }
  }, [sessionId]);

  const toggleHex = useCallback(async () => {
    if (!sessionId) return;
    const next = !hex;
    setError(null);
    try {
      await setDisplayMode(sessionId, next ? "hex" : "text");
      setHex(next);
    } catch (e) {
      setError(`表示を切り替えられません: ${errorMessage(e)}`);
    }
  }, [sessionId, hex]);

  const clearError = useCallback(() => setError(null), []);

  return {
    signals,
    hex,
    breaking,
    error,
    disabled,
    toggleSignal,
    doBreak,
    toggleHex,
    clearError,
  };
}

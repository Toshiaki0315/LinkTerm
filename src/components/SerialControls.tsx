import { useState } from "react";
import {
  sendBreak,
  setControlSignal,
  setDisplayMode,
  type ControlSignal,
} from "../lib/terminal-api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

interface Props {
  /** 接続確立後のセッションID。未確立なら操作できない。 */
  sessionId: string | null;
}

const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

/**
 * シリアル用の操作: DTR / RTS、ブレーク送信、16進表示。
 *
 * 制御信号の現在値は読み取れないため、ポートを開いた直後の状態（オン）から、
 * 最後に設定した値を表示する。セッションが変わったら（再接続）親が `key` で作り直す。
 */
export function SerialControls({ sessionId }: Props) {
  const [signals, setSignals] = useState<Record<ControlSignal, boolean>>({
    dtr: true,
    rts: true,
  });
  const [hex, setHex] = useState(false);
  const [breaking, setBreaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = sessionId === null;

  const toggleSignal = async (signal: ControlSignal) => {
    if (!sessionId) return;
    const next = !signals[signal];
    setError(null);
    try {
      await setControlSignal(sessionId, signal, next);
      setSignals((s) => ({ ...s, [signal]: next }));
    } catch (e) {
      setError(`${signal.toUpperCase()} を設定できません: ${errorMessage(e)}`);
    }
  };

  const doBreak = async () => {
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
  };

  const toggleHex = async () => {
    if (!sessionId) return;
    const next = !hex;
    setError(null);
    try {
      await setDisplayMode(sessionId, next ? "hex" : "text");
      setHex(next);
    } catch (e) {
      setError(`表示を切り替えられません: ${errorMessage(e)}`);
    }
  };

  const toggleClass = (on: boolean) =>
    cn(on && "bg-emerald-900/50 text-emerald-200");

  return (
    <div className="flex items-center gap-1">
      {error && (
        <p
          role="alert"
          className="max-w-72 rounded bg-red-900/80 px-2 py-1 text-xs"
        >
          {error}
        </p>
      )}
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={signals.dtr}
        disabled={disabled}
        className={toggleClass(signals.dtr)}
        title="Data Terminal Ready"
        onClick={() => void toggleSignal("dtr")}
      >
        DTR
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={signals.rts}
        disabled={disabled}
        className={toggleClass(signals.rts)}
        title="Request To Send"
        onClick={() => void toggleSignal("rts")}
      >
        RTS
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled || breaking}
        title="ブレーク信号を送ります（約0.25秒）"
        onClick={() => void doBreak()}
      >
        ブレーク送信
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={hex}
        disabled={disabled}
        className={toggleClass(hex)}
        title="受信データを16進ダンプで表示します"
        onClick={() => void toggleHex()}
      >
        HEX表示
      </Button>
    </div>
  );
}

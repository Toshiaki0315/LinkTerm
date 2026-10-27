import { useEffect, useRef, useState } from "react";
import { Circle, Square } from "lucide-react";
import {
  defaultLogPath,
  onLogError,
  startSessionLog,
  stopSessionLog,
  type LogConfig,
} from "../lib/terminal-api";
import { LogDialog } from "./LogDialog";
import { Button } from "./ui/button";

interface Props {
  /** 接続確立後のセッションID。未確立なら操作できない。 */
  sessionId: string | null;
  title: string;
}

const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

/** セッションログの開始・停止ボタン。 */
export function LogControl({ sessionId, title }: Props) {
  const [logging, setLogging] = useState(false);
  const [dialogPath, setDialogPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 開始コマンドの応答待ちの間に、失敗イベントが届いたか。 */
  const failedWhileStarting = useRef(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onLogError((id, message) => {
      if (id !== sessionId) return;
      failedWhileStarting.current = true;
      setLogging(false);
      setError(`ログの書き込みに失敗したため記録を停止しました: ${message}`);
    })
      .then((un) => (disposed ? un() : (unlisten = un)))
      .catch((e: unknown) =>
        console.error("ログエラーの購読に失敗しました:", e),
      );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [sessionId]);

  const openDialog = async () => {
    setError(null);
    let path = "";
    try {
      path = await defaultLogPath(title);
    } catch (e) {
      // 既定パスが取れなくても手入力で開始できる。
      console.error("既定のログパスを取得できません:", e);
    }
    setDialogPath(path);
  };

  const stop = async () => {
    if (!sessionId) return;
    try {
      await stopSessionLog(sessionId);
      setLogging(false);
    } catch (e) {
      setError(`ログを停止できません: ${errorMessage(e)}`);
    }
  };

  const start = async (config: LogConfig) => {
    if (!sessionId) throw new Error("セッションが確立していません");
    failedWhileStarting.current = false;
    await startSessionLog(sessionId, config);
    // 応答より先に失敗イベントが届いていたら、停止表示を上書きしない。
    if (!failedWhileStarting.current) setLogging(true);
  };

  return (
    <div className="flex items-center gap-2">
      {error && (
        <p
          role="alert"
          className="max-w-96 rounded bg-red-900/80 px-2 py-1 text-xs"
        >
          {error}
        </p>
      )}
      {logging ? (
        <Button
          variant="outline"
          size="sm"
          aria-label="ログ記録を停止"
          onClick={() => void stop()}
        >
          <Square className="h-3 w-3 fill-red-500 text-red-500" />
          記録中
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          aria-label="ログ記録"
          disabled={!sessionId}
          onClick={() => void openDialog()}
        >
          <Circle className="h-3 w-3" />
          ログ
        </Button>
      )}
      {dialogPath !== null && (
        <LogDialog
          open
          onOpenChange={(open) => !open && setDialogPath(null)}
          defaultPath={dialogPath}
          onSubmit={start}
        />
      )}
    </div>
  );
}

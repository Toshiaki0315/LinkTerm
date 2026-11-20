import { useCallback, useEffect, useRef, useState } from "react";
import {
  defaultLogPath,
  onLogError,
  startSessionLog,
  stopSessionLog,
  type LogConfig,
} from "../lib/terminal-api";

const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

interface Options {
  /** 接続確立後のセッションID。未確立なら操作できない。 */
  sessionId: string | null;
  title: string;
}

/** セッションログの開始・停止。画面（ボタン・メニュー）は持たず、状態と操作だけを返す。 */
export function useLogControl({ sessionId, title }: Options) {
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

  const openDialog = useCallback(async () => {
    setError(null);
    let path = "";
    try {
      path = await defaultLogPath(title);
    } catch (e) {
      // 既定パスが取れなくても手入力で開始できる。
      console.error("既定のログパスを取得できません:", e);
    }
    setDialogPath(path);
  }, [title]);

  const closeDialog = useCallback(() => setDialogPath(null), []);
  const clearError = useCallback(() => setError(null), []);

  const stop = useCallback(async () => {
    if (!sessionId) return;
    try {
      await stopSessionLog(sessionId);
      setLogging(false);
    } catch (e) {
      setError(`ログを停止できません: ${errorMessage(e)}`);
    }
  }, [sessionId]);

  /** 開始する。失敗は呼び出し元（ダイアログ）へ返し、そこで表示する。 */
  const start = useCallback(
    async (config: LogConfig) => {
      if (!sessionId) throw new Error("セッションが確立していません");
      failedWhileStarting.current = false;
      await startSessionLog(sessionId, config);
      // 応答より先に失敗イベントが届いていたら、停止表示を上書きしない。
      if (!failedWhileStarting.current) setLogging(true);
    },
    [sessionId],
  );

  return {
    logging,
    dialogPath,
    error,
    openDialog,
    closeDialog,
    clearError,
    start,
    stop,
  };
}

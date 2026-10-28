/**
 * ペインへの入力口の登録簿。スニペットなど、端末の外から文字を送るときに使う。
 * 入力口はローカルエコーも含む、キー入力と同じ経路（`TerminalTab` の入力処理）。
 */
const inputs = new Map<string, (data: string) => void>();

/** 登録する。戻り値で解除する（同じ ID を別の登録が上書きしていたら解除しない）。 */
export function registerPaneInput(
  paneId: string,
  send: (data: string) => void,
): () => void {
  inputs.set(paneId, send);
  return () => {
    if (inputs.get(paneId) === send) inputs.delete(paneId);
  };
}

/** ペインへ送る。ペインがなければ `false`。 */
export function sendToPane(paneId: string, data: string): boolean {
  const send = inputs.get(paneId);
  if (!send) return false;
  send(data);
  return true;
}

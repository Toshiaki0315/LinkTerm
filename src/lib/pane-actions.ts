/**
 * ペインの操作の登録簿。コマンドパレットなど、ペインの外から、そのペインの操作を呼ぶときに使う。
 */
export interface PaneActions {
  /** 画面の内容をテキストファイルとして保存する。 */
  exportText: () => void;
}

const actions = new Map<string, PaneActions>();

/** 登録する。戻り値で解除する（同じ ID を別の登録が上書きしていたら解除しない）。 */
export function registerPaneActions(
  paneId: string,
  value: PaneActions,
): () => void {
  actions.set(paneId, value);
  return () => {
    if (actions.get(paneId) === value) actions.delete(paneId);
  };
}

/** ペインの操作を呼ぶ。ペインがなければ `false`。 */
export function runPaneAction(
  paneId: string,
  name: keyof PaneActions,
): boolean {
  const target = actions.get(paneId);
  if (!target) return false;
  target[name]();
  return true;
}

/**
 * ペインの操作の登録簿。コマンドパレットなど、ペインの外から、そのペインの操作を呼ぶときに使う。
 */
export interface PaneActions {
  /** 画面の内容をテキストファイルとして保存する。 */
  exportText: () => void;
  /** 文字列を貼り付ける（キー入力と同じ経路。ブラケットペーストに対応）。 */
  paste: (text: string) => void;
  /** マクロを実行する。 */
  runMacro: (macro: { name: string; text: string }) => void;
  /** 実行中のマクロを止める。 */
  stopMacro: () => void;
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
export function runPaneAction(paneId: string, name: "exportText"): boolean {
  const target = actions.get(paneId);
  if (!target) return false;
  target[name]();
  return true;
}

/** ペインへ文字列を貼り付ける。ペインがなければ `false`。 */
export function pasteToPane(paneId: string, text: string): boolean {
  const target = actions.get(paneId);
  if (!target) return false;
  target.paste(text);
  return true;
}

/** ペインでマクロを実行する。ペインがなければ `false`。 */
export function runMacroOnPane(
  paneId: string,
  macro: { name: string; text: string },
): boolean {
  const target = actions.get(paneId);
  if (!target) return false;
  target.runMacro(macro);
  return true;
}

/** ペインで実行中のマクロを止める。ペインがなければ `false`。 */
export function stopMacroOnPane(paneId: string): boolean {
  const target = actions.get(paneId);
  if (!target) return false;
  target.stopMacro();
  return true;
}

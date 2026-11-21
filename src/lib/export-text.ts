import { saveScreenText } from "./terminal-api";
import { defaultExportName } from "./screen-text";

/**
 * テキストを、保存ダイアログで選んだ場所へ保存する。保存したパスを返す（キャンセルなら `null`）。
 * ダイアログはバックエンドが開く（画面は保存先のパスを指定できない）。
 */
export async function exportText(text: string): Promise<string | null> {
  return saveScreenText(text, defaultExportName());
}

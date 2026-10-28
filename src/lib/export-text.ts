import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { defaultExportName } from "./screen-text";

/**
 * テキストを、保存ダイアログで選んだ場所へ保存する。保存したパスを返す（キャンセルなら `null`）。
 */
export async function exportText(text: string): Promise<string | null> {
  const path = await save({
    defaultPath: defaultExportName(),
    filters: [{ name: "テキスト", extensions: ["txt"] }],
  });
  if (path === null) return null;
  await invoke<void>("save_text_file", { path, content: text });
  return path;
}

import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

/** テキストをクリップボードへコピーする。空文字は何もしない（クリップボードを空にしない）。 */
export async function copyText(text: string): Promise<void> {
  if (text === "") return;
  await writeText(text);
}

/** クリップボードのテキストを読む。空・テキスト以外のときは空文字。 */
export async function pasteText(): Promise<string> {
  try {
    return (await readText()) ?? "";
  } catch {
    // クリップボードが空、または画像など、テキスト以外が入っている。
    return "";
  }
}

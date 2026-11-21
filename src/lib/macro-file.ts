import { open } from "@tauri-apps/plugin-dialog";
import { baseNameOf } from "./macros";
import { readMacroFile } from "./terminal-api";

/**
 * `.ttl` ファイルを選んで読む。キャンセルなら `null`。
 * 名前は、ファイル名から拡張子を除いたもの。
 */
export async function pickMacroFile(): Promise<{
  name: string;
  text: string;
} | null> {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [
      { name: "Tera Term マクロ", extensions: ["ttl"] },
      { name: "すべてのファイル", extensions: ["*"] },
    ],
  });
  if (picked === null) return null;
  const path = Array.isArray(picked) ? picked[0] : picked;
  const text = await readMacroFile(path);
  return { name: baseNameOf(path), text };
}

import { pickMacroFile as pick } from "./terminal-api";

/**
 * `.ttl` ファイルを選んで読む。キャンセルなら `null`。
 * ファイルダイアログはバックエンドが開く（画面は読む場所を指定できない）。
 */
export const pickMacroFile = (): Promise<{
  name: string;
  text: string;
} | null> => pick();

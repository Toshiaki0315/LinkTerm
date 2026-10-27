import { openUrl } from "@tauri-apps/plugin-opener";

/** ターミナルの出力に含まれるURLのうち、外部のアプリで開いてよいもの（http / https）。 */
export function isOpenableUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname !== ""
    );
  } catch {
    return false;
  }
}

/** URLを OS の既定のアプリ（ブラウザ）で開く。http / https 以外は開かない。 */
export async function openExternalUrl(url: string): Promise<void> {
  if (!isOpenableUrl(url)) {
    throw new Error(`このURLは開けません: ${url}`);
  }
  await openUrl(url.trim());
}

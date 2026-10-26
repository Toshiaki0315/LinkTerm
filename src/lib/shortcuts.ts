export type ShortcutAction =
  | { type: "new" }
  | { type: "close" }
  | { type: "select"; index: number | "last" }
  | { type: "next" }
  | { type: "previous" };

export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * キーイベントをアプリのショートカットに対応付ける。
 *
 * ⌘ を伴うものだけを扱う。Ctrl 単独や修飾キーなしの入力はターミナルへ渡すため `null` を返す。
 */
export function shortcutFor(event: KeyEventLike): ShortcutAction | null {
  if (!event.metaKey || event.ctrlKey || event.altKey) return null;
  const key = event.key.toLowerCase();

  if (event.shiftKey) {
    if (key === "]" || key === "}") return { type: "next" };
    if (key === "[" || key === "{") return { type: "previous" };
    return null;
  }
  if (key === "t") return { type: "new" };
  if (key === "w") return { type: "close" };
  if (/^[1-9]$/.test(key)) {
    return { type: "select", index: key === "9" ? "last" : Number(key) - 1 };
  }
  return null;
}

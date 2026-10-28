export type ShortcutAction =
  | { type: "new" }
  | { type: "close" }
  | { type: "find" }
  | { type: "select"; index: number | "last" }
  | { type: "next" }
  | { type: "previous" }
  /** 画面を左右・上下に分割する（⌘D / ⌘⇧D）。 */
  | { type: "split"; dir: "row" | "column" }
  /** 分割したペインの間を移動する（⌘] / ⌘[）。 */
  | { type: "nextPane" }
  /** 同時入力のオン・オフ（⌘⇧I）。 */
  | { type: "broadcast" }
  | { type: "previousPane" };

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
    if (key === "d") return { type: "split", dir: "column" };
    if (key === "i") return { type: "broadcast" };
    return null;
  }
  if (key === "t") return { type: "new" };
  if (key === "w") return { type: "close" };
  if (key === "f") return { type: "find" };
  if (key === "d") return { type: "split", dir: "row" };
  if (key === "]") return { type: "nextPane" };
  if (key === "[") return { type: "previousPane" };
  if (/^[1-9]$/.test(key)) {
    return { type: "select", index: key === "9" ? "last" : Number(key) - 1 };
  }
  return null;
}

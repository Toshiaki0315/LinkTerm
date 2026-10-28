export type ShortcutAction =
  | { type: "new" }
  | { type: "close" }
  | { type: "find" }
  | { type: "select"; index: number | "last" }
  | { type: "next" }
  | { type: "previous" }
  /** 画面を左右・上下に分割する。 */
  | { type: "split"; dir: "row" | "column" }
  /** 分割したペインの間を移動する。 */
  | { type: "nextPane" }
  | { type: "previousPane" }
  /** 同時入力のオン・オフ。 */
  | { type: "broadcast" }
  /** コマンドパレットを開く。 */
  | { type: "palette" };

/** 割り当てを変えられる操作。 */
export const SHORTCUT_DEFS = [
  { id: "new", label: "新しい接続", binding: "Cmd+t", action: { type: "new" } },
  {
    id: "close",
    label: "タブ／ペインを閉じる",
    binding: "Cmd+w",
    action: { type: "close" },
  },
  {
    id: "find",
    label: "画面内を検索",
    binding: "Cmd+f",
    action: { type: "find" },
  },
  {
    id: "next-tab",
    label: "次のタブ",
    binding: "Cmd+Shift+]",
    action: { type: "next" },
  },
  {
    id: "previous-tab",
    label: "前のタブ",
    binding: "Cmd+Shift+[",
    action: { type: "previous" },
  },
  {
    id: "split-right",
    label: "右に分割",
    binding: "Cmd+d",
    action: { type: "split", dir: "row" },
  },
  {
    id: "split-down",
    label: "下に分割",
    binding: "Cmd+Shift+d",
    action: { type: "split", dir: "column" },
  },
  {
    id: "next-pane",
    label: "次のペインへ",
    binding: "Cmd+]",
    action: { type: "nextPane" },
  },
  {
    id: "previous-pane",
    label: "前のペインへ",
    binding: "Cmd+[",
    action: { type: "previousPane" },
  },
  {
    id: "broadcast",
    label: "同時入力のオン・オフ",
    binding: "Cmd+Shift+i",
    action: { type: "broadcast" },
  },
  {
    id: "palette",
    label: "コマンドパレット",
    binding: "Cmd+Shift+p",
    action: { type: "palette" },
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  binding: string;
  action: ShortcutAction;
}>;

export type ShortcutId = (typeof SHORTCUT_DEFS)[number]["id"];
/** 操作の ID → キーの組み合わせ（`Cmd+Shift+P` の形）。 */
export type Bindings = Record<ShortcutId, string>;

export const DEFAULT_BINDINGS = Object.fromEntries(
  SHORTCUT_DEFS.map((d) => [d.id, d.binding]),
) as Bindings;

export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Shift を押したときに変わる記号を、元のキーに戻す。 */
const UNSHIFTED: Record<string, string> = {
  "}": "]",
  "{": "[",
  "<": ",",
  ">": ".",
  "?": "/",
  ":": ";",
  '"': "'",
  "|": "\\",
  _: "-",
  "~": "`",
  "+": "=",
};

/** 名前のあるキー（表示用の記号）。 */
const KEY_LABELS: Record<string, string> = {
  enter: "↩",
  tab: "⇥",
  escape: "⎋",
  backspace: "⌫",
  delete: "⌦",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  " ": "Space",
};

const MODIFIER_KEYS = new Set(["meta", "control", "alt", "shift", "capslock"]);

/**
 * キーイベントを、キーの組み合わせ（`Cmd+Shift+P`）にする。
 * ⌘ を伴わない、Ctrl / Option を伴う、修飾キーだけの入力は `null`（ターミナルのキーなので扱わない）。
 */
export function bindingFromEvent(event: KeyEventLike): string | null {
  if (!event.metaKey || event.ctrlKey || event.altKey) return null;
  let key =
    event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();
  if (MODIFIER_KEYS.has(key)) return null;
  if (event.shiftKey && UNSHIFTED[key]) key = UNSHIFTED[key];
  return `Cmd+${event.shiftKey ? "Shift+" : ""}${key}`;
}

/** キーの組み合わせを、画面に出す形（⌘⇧P）にする。 */
export function formatBinding(binding: string): string {
  const parts = binding.split("+");
  // 末尾が空なら、キーが `+` そのもの。
  const key = parts.pop() || "+";
  let out = "";
  if (parts.includes("Ctrl")) out += "⌃";
  if (parts.includes("Alt")) out += "⌥";
  if (parts.includes("Shift")) out += "⇧";
  if (parts.includes("Cmd")) out += "⌘";
  const lower = key.toLowerCase();
  return (
    out + (KEY_LABELS[lower] ?? (key.length === 1 ? key.toUpperCase() : key))
  );
}

/** ほかの用途で使われているため、割り当てられないキー。 */
const RESERVED = new Set([
  "Cmd+c",
  "Cmd+v",
  "Cmd+x",
  "Cmd+a",
  "Cmd+z",
  "Cmd+Shift+z",
  "Cmd+q",
  "Cmd+h",
  "Cmd+m",
  "Cmd+,",
]);

const isTabSelect = (binding: string) => /^Cmd\+[1-9]$/.test(binding);

/**
 * 割り当てられるか。問題があれば理由、なければ `null`。
 * `current` は、いまの割り当て（自分以外の操作との重複を調べる）。
 */
export function validateBinding(
  id: ShortcutId,
  binding: string,
  current: Bindings,
): string | null {
  if (!/^Cmd\+(Shift\+)?[^+\s]+$|^Cmd\+(Shift\+)?\+$/.test(binding))
    return "⌘ を含むキーの組み合わせにしてください";
  if (RESERVED.has(binding))
    return `${formatBinding(binding)} は、システムや編集（コピー・貼り付けなど）で使われています`;
  if (isTabSelect(binding))
    return `${formatBinding(binding)} は、番号でタブを選ぶために使われています`;
  const other = SHORTCUT_DEFS.find(
    (d) => d.id !== id && current[d.id] === binding,
  );
  if (other)
    return `${formatBinding(binding)} は「${other.label}」に割り当て済みです`;
  return null;
}

/**
 * 保存済みの割り当て（初期値から変えたもの）を、初期値と合わせる。
 * 未知の操作・不正な値・重複する値は無視し、初期値のままにする。
 */
export function resolveBindings(
  overrides: ReadonlyArray<{ id: string; binding: string }>,
): Bindings {
  const result: Bindings = { ...DEFAULT_BINDINGS };
  for (const { id, binding } of overrides) {
    const def = SHORTCUT_DEFS.find((d) => d.id === id);
    if (!def) continue;
    if (validateBinding(def.id, binding, result) === null) {
      result[def.id] = binding;
    }
  }
  return result;
}

/** 初期値から変えたものだけを、保存する形にする。 */
export function overridesOf(
  bindings: Bindings,
): Array<{ id: string; binding: string }> {
  return SHORTCUT_DEFS.filter((d) => bindings[d.id] !== d.binding).map((d) => ({
    id: d.id,
    binding: bindings[d.id],
  }));
}

/**
 * キーイベントをアプリのショートカットに対応付ける。
 *
 * ⌘ を伴うものだけを扱う。Ctrl 単独や修飾キーなしの入力はターミナルへ渡すため `null` を返す。
 * ⌘1〜9（タブの番号選択）は固定。
 */
export function shortcutFor(
  event: KeyEventLike,
  bindings: Bindings = DEFAULT_BINDINGS,
): ShortcutAction | null {
  const binding = bindingFromEvent(event);
  if (binding === null) return null;
  if (isTabSelect(binding)) {
    const digit = binding.slice(-1);
    return {
      type: "select",
      index: digit === "9" ? "last" : Number(digit) - 1,
    };
  }
  const def = SHORTCUT_DEFS.find((d) => bindings[d.id] === binding);
  return def ? def.action : null;
}

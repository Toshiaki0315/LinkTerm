import type { ITheme } from "@xterm/xterm";

export const THEME_IDS = [
  "dark",
  "light",
  "solarized-dark",
  "solarized-light",
  "dracula",
  "monokai",
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export interface TerminalTheme {
  label: string;
  /** 端末の外側の余白にも使う背景色（`xterm.background` と同じ）。 */
  background: string;
  foreground: string;
  /** xterm.js に渡す配色。 */
  xterm: ITheme;
}

const SOLARIZED_ANSI = {
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#002b36",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

function define(
  label: string,
  xterm: Required<Pick<ITheme, "background" | "foreground">> & ITheme,
): TerminalTheme {
  return {
    label,
    background: xterm.background,
    foreground: xterm.foreground,
    xterm,
  };
}

export const THEMES: Record<ThemeId, TerminalTheme> = {
  dark: define("ダーク", {
    background: "#000000",
    foreground: "#e5e5e5",
    cursor: "#e5e5e5",
    cursorAccent: "#000000",
    selectionBackground: "#3a4a63",
    black: "#000000",
    red: "#cd3131",
    green: "#0dbc79",
    yellow: "#e5e510",
    blue: "#2472c8",
    magenta: "#bc3fbc",
    cyan: "#11a8cd",
    white: "#e5e5e5",
    brightBlack: "#666666",
    brightRed: "#f14c4c",
    brightGreen: "#23d18b",
    brightYellow: "#f5f543",
    brightBlue: "#3b8eea",
    brightMagenta: "#d670d6",
    brightCyan: "#29b8db",
    brightWhite: "#ffffff",
  }),
  light: define("ライト", {
    background: "#ffffff",
    foreground: "#1f1f1f",
    cursor: "#1f1f1f",
    cursorAccent: "#ffffff",
    selectionBackground: "#b5d5ff",
    black: "#000000",
    red: "#c91b00",
    green: "#00a000",
    yellow: "#9a8f00",
    blue: "#0225c7",
    magenta: "#c930c7",
    cyan: "#0094a0",
    white: "#c7c7c7",
    brightBlack: "#686868",
    brightRed: "#e0463c",
    brightGreen: "#1fae2c",
    brightYellow: "#b3a500",
    brightBlue: "#4a56e6",
    brightMagenta: "#d34fd0",
    brightCyan: "#1fa5b0",
    brightWhite: "#ffffff",
  }),
  "solarized-dark": define("Solarized ダーク", {
    ...SOLARIZED_ANSI,
    background: "#002b36",
    foreground: "#93a1a1",
    cursor: "#93a1a1",
    cursorAccent: "#002b36",
    selectionBackground: "#0b4a5a",
  }),
  "solarized-light": define("Solarized ライト", {
    ...SOLARIZED_ANSI,
    background: "#fdf6e3",
    foreground: "#586e75",
    cursor: "#586e75",
    cursorAccent: "#fdf6e3",
    selectionBackground: "#e6dfc8",
  }),
  dracula: define("Dracula", {
    background: "#282a36",
    foreground: "#f8f8f2",
    cursor: "#f8f8f2",
    cursorAccent: "#282a36",
    selectionBackground: "#44475a",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  }),
  monokai: define("Monokai", {
    background: "#272822",
    foreground: "#f8f8f2",
    cursor: "#f8f8f0",
    cursorAccent: "#272822",
    selectionBackground: "#49483e",
    black: "#272822",
    red: "#f92672",
    green: "#a6e22e",
    yellow: "#f4bf75",
    blue: "#66d9ef",
    magenta: "#ae81ff",
    cyan: "#a1efe4",
    white: "#f8f8f2",
    brightBlack: "#75715e",
    brightRed: "#f92672",
    brightGreen: "#a6e22e",
    brightYellow: "#f4bf75",
    brightBlue: "#66d9ef",
    brightMagenta: "#ae81ff",
    brightCyan: "#a1efe4",
    brightWhite: "#f9f8f5",
  }),
};

/** ID から配色を引く。不明・未指定ならダーク。 */
export function themeFor(id: ThemeId | undefined): TerminalTheme {
  return (id && THEMES[id]) || THEMES.dark;
}

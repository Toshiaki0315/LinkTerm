import { describe, expect, it } from "vitest";
import { THEME_IDS, THEMES, themeFor, withOpacity } from "./themes";

const HEX = /^#[0-9a-f]{6}$/i;

function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const ANSI = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

describe("配色テーマ", () => {
  it("6種類（ダーク・ライト・Solarized ダーク/ライト・Dracula・Monokai）がある", () => {
    expect(THEME_IDS).toEqual([
      "dark",
      "light",
      "solarized-dark",
      "solarized-light",
      "dracula",
      "monokai",
    ]);
  });

  it.each(THEME_IDS)(
    "%s: 日本語の名前と、16色・前景・背景・カーソル・選択色がそろっている",
    (id) => {
      const theme = THEMES[id];
      expect(theme.label.length).toBeGreaterThan(0);
      for (const key of [
        "background",
        "foreground",
        "cursor",
        "selectionBackground",
        ...ANSI,
      ] as const) {
        expect(theme.xterm[key], `${id}.${key}`).toMatch(HEX);
      }
      expect(theme.xterm.background).toBe(theme.background);
    },
  );

  it.each(THEME_IDS)(
    "%s: 文字色と背景色のコントラストが十分（4.5:1 以上）",
    (id) => {
      const { foreground, background } = THEMES[id].xterm;
      expect(contrast(foreground!, background!)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("ライト系は明るい背景、ダーク系は暗い背景", () => {
    for (const id of ["light", "solarized-light"] as const) {
      expect(luminance(THEMES[id].background)).toBeGreaterThan(0.5);
    }
    for (const id of [
      "dark",
      "solarized-dark",
      "dracula",
      "monokai",
    ] as const) {
      expect(luminance(THEMES[id].background)).toBeLessThan(0.2);
    }
  });

  it("themeFor は ID から定義を返し、不明な ID はダークにする", () => {
    expect(themeFor("dracula")).toBe(THEMES.dracula);
    expect(themeFor(undefined)).toBe(THEMES.dark);
    expect(themeFor("neon" as never)).toBe(THEMES.dark);
  });
});

describe("withOpacity", () => {
  it("#rrggbb / #rgb と不透明度（%）から、rgba を作る", () => {
    expect(withOpacity("#002b36", 100)).toBe("rgba(0, 43, 54, 1)");
    expect(withOpacity("#002b36", 50)).toBe("rgba(0, 43, 54, 0.5)");
    expect(withOpacity("#fff", 80)).toBe("rgba(255, 255, 255, 0.8)");
    expect(withOpacity("#FDF6E3", 30)).toBe("rgba(253, 246, 227, 0.3)");
  });

  it("範囲外は収め、色として読めなければ元の値をそのまま返す", () => {
    expect(withOpacity("#000000", 0)).toBe("rgba(0, 0, 0, 0.3)");
    expect(withOpacity("#000000", 500)).toBe("rgba(0, 0, 0, 1)");
    expect(withOpacity("not-a-color", 50)).toBe("not-a-color");
  });

  it("すべてのテーマの背景色を変換できる", () => {
    for (const id of THEME_IDS) {
      expect(withOpacity(THEMES[id].background, 70)).toMatch(/^rgba\(/);
    }
  });
});

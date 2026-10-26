import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  settingsSchema,
} from "./settings";

describe("settingsSchema", () => {
  it("既定値は有効で、Rust側の既定値と同じ", () => {
    expect(settingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true);
    expect(DEFAULT_SETTINGS).toEqual({
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      scrollback: 10000,
      cursorBlink: true,
      startup: { kind: "none" },
    });
  });

  it("フォントサイズは範囲内の整数", () => {
    expect(FONT_SIZE_MIN).toBe(8);
    expect(FONT_SIZE_MAX).toBe(72);
    for (const ok of [8, 13, 72]) {
      expect(
        settingsSchema.safeParse({ ...DEFAULT_SETTINGS, fontSize: ok }).success,
      ).toBe(true);
    }
    for (const bad of [7, 73, 12.5, Number.NaN]) {
      expect(
        settingsSchema.safeParse({ ...DEFAULT_SETTINGS, fontSize: bad })
          .success,
      ).toBe(false);
    }
  });

  it("スクロールバックは0〜100000の整数", () => {
    expect(
      settingsSchema.safeParse({ ...DEFAULT_SETTINGS, scrollback: 0 }).success,
    ).toBe(true);
    expect(
      settingsSchema.safeParse({ ...DEFAULT_SETTINGS, scrollback: 100000 })
        .success,
    ).toBe(true);
    expect(
      settingsSchema.safeParse({ ...DEFAULT_SETTINGS, scrollback: 100001 })
        .success,
    ).toBe(false);
    expect(
      settingsSchema.safeParse({ ...DEFAULT_SETTINGS, scrollback: -1 }).success,
    ).toBe(false);
  });

  it("フォント指定は空・長すぎ・CSSを壊す文字を拒否し、前後の空白は除く", () => {
    for (const bad of [
      "",
      "   ",
      "a".repeat(201),
      "Menlo; color: red",
      "a{b}",
      "<x>",
      "a\u0000b",
    ]) {
      expect(
        settingsSchema.safeParse({ ...DEFAULT_SETTINGS, fontFamily: bad })
          .success,
      ).toBe(false);
    }
    const parsed = settingsSchema.parse({
      ...DEFAULT_SETTINGS,
      fontFamily: "  SF Mono, Menlo  ",
    });
    expect(parsed.fontFamily).toBe("SF Mono, Menlo");
    expect(
      settingsSchema.safeParse({
        ...DEFAULT_SETTINGS,
        fontFamily: "ヒラギノ角ゴ ProN, monospace",
      }).success,
    ).toBe(true);
  });

  it("起動時の指定: none / local / profile（profile は ID 必須）", () => {
    for (const startup of [
      { kind: "none" },
      { kind: "local" },
      { kind: "profile", profileId: "p1" },
    ]) {
      expect(
        settingsSchema.safeParse({ ...DEFAULT_SETTINGS, startup }).success,
      ).toBe(true);
    }
    for (const startup of [
      { kind: "profile", profileId: "" },
      { kind: "profile" },
      { kind: "ssh" },
    ]) {
      expect(
        settingsSchema.safeParse({ ...DEFAULT_SETTINGS, startup }).success,
      ).toBe(false);
    }
  });
});

import { z } from "zod";
import { THEME_IDS } from "./themes";

// 範囲・既定値は Rust 側（src-tauri/src/settings.rs）と揃える。Rust 側の検証が正。
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 72;
export const SCROLLBACK_MAX = 100_000;
export const FONT_FAMILY_MAX_CHARS = 200;
export const PROFILE_ID_MAX_CHARS = 100;
export const RECONNECT_DELAY_MAX_SECONDS = 3600;
export const RECONNECT_ATTEMPTS_MAX = 1000;

/** CSS の font-family を壊す・宣言を区切る文字。 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_FONT_CHARS = /[\u0000-\u001f\u007f;{}<>\\]/;

const startupSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("local") }),
  z.object({ kind: z.literal("restore") }),
  z.object({
    kind: z.literal("profile"),
    profileId: z
      .string()
      .trim()
      .min(1, "起動時に開く接続を選択してください")
      .max(PROFILE_ID_MAX_CHARS),
  }),
]);

export const fontFamilySchema = z
  .string()
  .trim()
  .min(1, "フォントを入力してください")
  .max(
    FONT_FAMILY_MAX_CHARS,
    `フォントは${FONT_FAMILY_MAX_CHARS}文字以内で入力してください`,
  )
  .refine((v) => !FORBIDDEN_FONT_CHARS.test(v), "使えない文字が含まれています");

export const fontSizeSchema = z
  .number(
    `フォントサイズは${FONT_SIZE_MIN}〜${FONT_SIZE_MAX}の整数で入力してください`,
  )
  .int(
    `フォントサイズは${FONT_SIZE_MIN}〜${FONT_SIZE_MAX}の整数で入力してください`,
  )
  .min(
    FONT_SIZE_MIN,
    `フォントサイズは${FONT_SIZE_MIN}〜${FONT_SIZE_MAX}の整数で入力してください`,
  )
  .max(
    FONT_SIZE_MAX,
    `フォントサイズは${FONT_SIZE_MIN}〜${FONT_SIZE_MAX}の整数で入力してください`,
  );

export const scrollbackSchema = z
  .number(`スクロールバックは0〜${SCROLLBACK_MAX}行で入力してください`)
  .int(`スクロールバックは0〜${SCROLLBACK_MAX}行で入力してください`)
  .min(0, `スクロールバックは0〜${SCROLLBACK_MAX}行で入力してください`)
  .max(
    SCROLLBACK_MAX,
    `スクロールバックは0〜${SCROLLBACK_MAX}行で入力してください`,
  );

export const autoReconnectSchema = z.object({
  enabled: z.boolean(),
  delaySeconds: z
    .number(
      `待ち時間は1〜${RECONNECT_DELAY_MAX_SECONDS}秒の整数で入力してください`,
    )
    .int(
      `待ち時間は1〜${RECONNECT_DELAY_MAX_SECONDS}秒の整数で入力してください`,
    )
    .min(
      1,
      `待ち時間は1〜${RECONNECT_DELAY_MAX_SECONDS}秒の整数で入力してください`,
    )
    .max(
      RECONNECT_DELAY_MAX_SECONDS,
      `待ち時間は1〜${RECONNECT_DELAY_MAX_SECONDS}秒の整数で入力してください`,
    ),
  maxAttempts: z
    .number(
      `回数は0〜${RECONNECT_ATTEMPTS_MAX}の整数で入力してください（0は無制限）`,
    )
    .int(
      `回数は0〜${RECONNECT_ATTEMPTS_MAX}の整数で入力してください（0は無制限）`,
    )
    .min(
      0,
      `回数は0〜${RECONNECT_ATTEMPTS_MAX}の整数で入力してください（0は無制限）`,
    )
    .max(
      RECONNECT_ATTEMPTS_MAX,
      `回数は0〜${RECONNECT_ATTEMPTS_MAX}の整数で入力してください（0は無制限）`,
    ),
});

export const CURSOR_STYLES = ["block", "underline", "bar"] as const;
export const BACKSPACE_KEYS = ["del", "bs"] as const;

export type AutoReconnect = z.infer<typeof autoReconnectSchema>;

export const settingsSchema = z.object({
  fontFamily: fontFamilySchema,
  fontSize: fontSizeSchema,
  scrollback: scrollbackSchema,
  cursorBlink: z.boolean(),
  cursorStyle: z.enum(CURSOR_STYLES),
  backspaceKey: z.enum(BACKSPACE_KEYS),
  optionIsMeta: z.boolean(),
  theme: z.enum(THEME_IDS),
  copyOnSelect: z.boolean(),
  autoReconnect: autoReconnectSchema,
  startup: startupSchema,
});

export type Settings = z.infer<typeof settingsSchema>;
export type Startup = Settings["startup"];

/** どのフォントを選んでも末尾に付ける代替フォント（日本語などの字形は、ここへフォールバックする）。 */
export const FONT_FALLBACK_STACK = 'Menlo, Monaco, "Courier New", monospace';

/** 選んだフォント名から、設定に保存する font-family の指定を作る。 */
export const fontStackFor = (family: string) =>
  `"${family}", ${FONT_FALLBACK_STACK}`;

/** `fontStackFor` で作った指定からフォント名を取り出す。標準や手書きの指定は `null`。 */
export function familyFromStack(stack: string): string | null {
  const match = /^"([^"]+)", /.exec(stack);
  return match && fontStackFor(match[1]) === stack ? match[1] : null;
}

export const DEFAULT_SETTINGS: Settings = {
  fontFamily: FONT_FALLBACK_STACK,
  fontSize: 13,
  scrollback: 10_000,
  cursorBlink: true,
  cursorStyle: "block",
  backspaceKey: "del",
  optionIsMeta: false,
  theme: "dark",
  copyOnSelect: false,
  autoReconnect: { enabled: false, delaySeconds: 5, maxAttempts: 5 },
  startup: { kind: "none" },
};

/** ターミナルの見た目に関わる設定。 */
export type Appearance = Pick<
  Settings,
  | "fontFamily"
  | "fontSize"
  | "scrollback"
  | "cursorBlink"
  | "cursorStyle"
  | "backspaceKey"
  | "optionIsMeta"
  | "theme"
  | "copyOnSelect"
>;

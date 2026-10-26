import { z } from "zod";

// 範囲・既定値は Rust 側（src-tauri/src/settings.rs）と揃える。Rust 側の検証が正。
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 72;
export const SCROLLBACK_MAX = 100_000;
export const FONT_FAMILY_MAX_CHARS = 200;
export const PROFILE_ID_MAX_CHARS = 100;

/** CSS の font-family を壊す・宣言を区切る文字。 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_FONT_CHARS = /[\u0000-\u001f\u007f;{}<>\\]/;

const startupSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("local") }),
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

export const settingsSchema = z.object({
  fontFamily: fontFamilySchema,
  fontSize: fontSizeSchema,
  scrollback: scrollbackSchema,
  cursorBlink: z.boolean(),
  startup: startupSchema,
});

export type Settings = z.infer<typeof settingsSchema>;
export type Startup = Settings["startup"];

export const DEFAULT_SETTINGS: Settings = {
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  fontSize: 13,
  scrollback: 10_000,
  cursorBlink: true,
  startup: { kind: "none" },
};

/** ターミナルの見た目に関わる設定。 */
export type Appearance = Pick<
  Settings,
  "fontFamily" | "fontSize" | "scrollback" | "cursorBlink"
>;

/** フォント指定の入力候補（macOS に標準で入っている等幅フォント）。 */
export const FONT_SUGGESTIONS = [
  'Menlo, Monaco, "Courier New", monospace',
  "SF Mono, Menlo, monospace",
  "Monaco, monospace",
  "Osaka-Mono, monospace",
  "Courier New, monospace",
  "Andale Mono, monospace",
];

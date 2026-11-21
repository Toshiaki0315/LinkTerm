/**
 * 自動の補正（先頭の大文字化・綴りの修正・綴りの検査）を止める入力欄の指定。
 * ホスト名・ユーザー名・パス・コマンド・スクリプトなどは、入れたとおりに保つ必要がある。
 * （macOS の WebView は、指定がないと、文頭を自動で大文字にすることがある。）
 */
export const PLAIN_TEXT_PROPS = {
  autoCapitalize: "off",
  autoCorrect: "off",
  spellCheck: false,
} as const;

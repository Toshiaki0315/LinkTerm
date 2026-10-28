/** コマンドパレットの項目。 */
export interface PaletteCommand {
  id: string;
  title: string;
  /** 右側に出す補足（ショートカットなど）。 */
  hint?: string;
  /** 検索にだけ使う語（別名・英語名など）。 */
  keywords?: string;
  /** 項目のグループ名（検索にも使う）。 */
  group: string;
  run: () => void;
}

/** 全角・半角・大文字小文字の違いを無視して比べる。 */
const normalize = (text: string) => text.normalize("NFKC").toLowerCase();

/**
 * 項目の点数。すべての語が含まれていなければ `null`。小さいほど上位。
 * 語が、題名の先頭 → 単語の先頭 → 題名の途中 → その他（グループ・別名）の順に高く評価する。
 */
function score(command: PaletteCommand, tokens: string[]): number | null {
  const title = normalize(command.title);
  const rest = normalize(`${command.group} ${command.keywords ?? ""}`);
  let total = 0;
  for (const token of tokens) {
    const at = title.indexOf(token);
    if (at === 0) total += 0;
    else if (at > 0 && /[\s:：/（(「・\-_.]/.test(title[at - 1])) total += 1;
    else if (at > 0) total += 2 + at / 1000;
    else if (rest.includes(token)) total += 5;
    else return null;
  }
  return total;
}

/**
 * 入力した語（空白区切り）で項目を絞り込み、近い順に並べる。空の入力はすべて（元の並び）。
 * 点数が同じなら元の並びを保つ。
 */
export function filterCommands(
  commands: PaletteCommand[],
  query: string,
): PaletteCommand[] {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return commands;
  return commands
    .map((command, index) => ({ command, index, s: score(command, tokens) }))
    .filter(
      (x): x is { command: PaletteCommand; index: number; s: number } =>
        x.s !== null,
    )
    .sort((a, b) => a.s - b.s || a.index - b.index)
    .map((x) => x.command);
}

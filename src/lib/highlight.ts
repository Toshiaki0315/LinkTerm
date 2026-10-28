import { tabColorHex, type TabColorId } from "./tab-colors";

/** ハイライト規則。Rust 側（src-tauri/src/highlights.rs）の検証が正。 */
export interface HighlightRule {
  id: string;
  /** 見つけたい文字列（`regex` が真なら正規表現）。 */
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  color: TabColorId;
  /** 見つかったとき、通知する。 */
  notify: boolean;
}

export const MAX_RULES = 50;
export const MAX_PATTERN_CHARS = 200;
/** 1行で照合する最大の長さ（正規表現の暴走を抑える）。 */
export const MAX_LINE_CHARS = 2000;
/** 1行で付ける強調の最大数。 */
export const MAX_MATCHES_PER_LINE = 50;
/** 通知のために、前の出力から持ち越す文字数（分割して届いた語を見つける）。 */
const CARRY_CHARS = MAX_PATTERN_CHARS;

export const newRule = (id: string): HighlightRule => ({
  id,
  pattern: "",
  regex: false,
  caseSensitive: false,
  color: "red",
  notify: false,
});

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface CompiledRule {
  rule: HighlightRule;
  re: RegExp;
}

/** 規則の入力を検証する。問題がなければ `null`。 */
export function validateRule(rule: HighlightRule): string | null {
  if (rule.pattern === "") return "文字列を入力してください";
  if ([...rule.pattern].length > MAX_PATTERN_CHARS)
    return `文字列は${MAX_PATTERN_CHARS}文字以内で入力してください`;
  if (rule.regex) {
    try {
      const re = new RegExp(rule.pattern, "u");
      // 空の文字列に一致する式は、すべての位置に一致してしまう。
      if (re.test("")) return "空の文字列に一致する正規表現は使えません";
    } catch (e) {
      return `正規表現が正しくありません: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return null;
}

/** 規則を照合用に準備する。正しくない規則は除く。 */
export function compileRules(rules: HighlightRule[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  for (const rule of rules) {
    if (validateRule(rule) !== null) continue;
    const source = rule.regex ? rule.pattern : escapeRegExp(rule.pattern);
    try {
      compiled.push({
        rule,
        re: new RegExp(source, rule.caseSensitive ? "gu" : "giu"),
      });
    } catch {
      // 検証を通っても作れない場合は使わない。
    }
  }
  return compiled;
}

export interface Match {
  start: number;
  end: number;
  rule: HighlightRule;
}

/** 1行の中の一致を、左から順に求める。重なるときは、先に一致した（規則の並びが前の）ものを優先する。 */
export function findMatches(text: string, rules: CompiledRule[]): Match[] {
  if (rules.length === 0 || text === "") return [];
  const line =
    text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS) : text;
  const found: Match[] = [];
  for (const { rule, re } of rules) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      found.push({ start: m.index, end: m.index + m[0].length, rule });
      if (found.length >= MAX_MATCHES_PER_LINE * rules.length) break;
    }
  }
  // 規則の順（先が優先）→位置の順に並べ、重なるものを捨てる。
  const order = new Map(rules.map((r, i) => [r.rule.id, i]));
  found.sort(
    (a, b) =>
      a.start - b.start ||
      (order.get(a.rule.id) ?? 0) - (order.get(b.rule.id) ?? 0) ||
      b.end - a.end,
  );
  const result: Match[] = [];
  let lastEnd = -1;
  for (const m of found) {
    if (m.start < lastEnd) continue;
    result.push(m);
    lastEnd = m.end;
    if (result.length >= MAX_MATCHES_PER_LINE) break;
  }
  return result;
}

/** 端末の1セル。 */
export interface Cell {
  chars: string;
  width: number;
}

/**
 * セルの並びから、行の文字列と、各文字（UTF-16 の位置）が置かれた列を求める。
 * 全角文字は 2 列、その続きのセル（幅 0）は文字を持たない。空のセルは空白として扱う。
 */
export function lineFromCells(cells: Cell[]): {
  text: string;
  columns: number[];
} {
  let text = "";
  const columns: number[] = [];
  cells.forEach((cell, col) => {
    if (cell.width === 0) return;
    const chars = cell.chars === "" ? " " : cell.chars;
    for (let i = 0; i < chars.length; i += 1) columns.push(col);
    text += chars;
  });
  // 終端の位置（`end` を列に直すため）。
  columns.push(cells.length);
  return { text, columns };
}

/** 一致の範囲を、端末の列の範囲（開始列・幅）にする。 */
export function toColumns(
  match: { start: number; end: number },
  columns: number[],
): { x: number; width: number } {
  const x = columns[match.start] ?? 0;
  const endCol = columns[match.end] ?? columns[columns.length - 1] ?? x;
  return { x, width: Math.max(1, endCol - x) };
}

/** ハイライト用の色（背景と、読みやすい文字色）。 */
export function highlightColors(color: TabColorId): {
  background: string;
  foreground: string;
} {
  const background = tabColorHex(color) ?? "#eab308";
  // 明るい色は黒、濃い色は白の文字にする。
  const light = ["yellow", "green", "orange", "pink", "gray"].includes(color);
  return { background, foreground: light ? "#000000" : "#ffffff" };
}

/**
 * 受信した出力から、通知する規則に一致するものを探す。
 * 前の出力の末尾を持ち越し、分割して届いた語も見つける（同じ一致は二度報告しない）。
 */
export class OutputMatcher {
  private carry = "";
  private compiled: CompiledRule[];

  constructor(rules: HighlightRule[]) {
    this.compiled = compileRules(rules.filter((r) => r.notify));
  }

  /** 新しく届いた文字列に一致した規則（重複なし）。 */
  feed(text: string): HighlightRule[] {
    const combined = this.carry + text;
    const boundary = this.carry.length;
    this.carry = combined.slice(-CARRY_CHARS);
    const hits = new Map<string, HighlightRule>();
    // 持ち越し分だけで完結する一致は、すでに報告済み。新しい文字列に終わりがかかるものだけを数える。
    let offset = 0;
    for (const line of combined.split(/\r\n|\r|\n/)) {
      const lineEnd = offset + line.length;
      if (lineEnd > boundary) {
        for (const m of findMatches(line, this.compiled)) {
          if (offset + m.end > boundary) hits.set(m.rule.id, m.rule);
        }
      }
      // 改行コード分（最大 2）を足す。厳密でなくても、境界の判定に支障はない。
      offset = lineEnd + 1;
    }
    return [...hits.values()];
  }
}

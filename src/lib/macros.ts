import { MAX_SOURCE_CHARS } from "./ttl/parser";
import { parseProgram, type ParseIssue } from "./ttl/parser";

/** 保存するマクロ。Rust 側（src-tauri/src/macros.rs）の検証が正。 */
export interface Macro {
  id: string;
  name: string;
  /** スクリプト本文（Tera Term の TTL 互換）。 */
  text: string;
}

export const MAX_MACROS = 100;
export const MAX_NAME_CHARS = 60;
export const MAX_TEXT_CHARS = MAX_SOURCE_CHARS;

export const newMacro = (id: string): Macro => ({ id, name: "", text: "" });

/** スクリプトの文法を調べる。問題があれば、行番号つきですべて返す。 */
export function checkMacroSource(text: string): ParseIssue[] {
  const result = parseProgram(text);
  return result.ok ? [] : result.errors;
}

/** 入力内容を検証する。問題がなければ `null`。 */
export function validateMacro(m: Macro): string | null {
  if (m.name.trim() === "") return "名前を入力してください";
  if ([...m.name.trim()].length > MAX_NAME_CHARS)
    return `名前は${MAX_NAME_CHARS}文字以内で入力してください`;
  if (m.text.trim() === "") return "スクリプトを入力してください";
  if ([...m.text].length > MAX_TEXT_CHARS)
    return `スクリプトは${MAX_TEXT_CHARS}文字以内で入力してください`;
  const [first] = checkMacroSource(m.text);
  if (first) return `${first.line}行目: ${first.message}`;
  return null;
}

/** ファイルのパスから、拡張子を除いたファイル名を取り出す。 */
export function baseNameOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

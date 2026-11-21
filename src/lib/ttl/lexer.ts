import { TtlError } from "./errors";

export type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "id"; v: string; lower: string }
  | { t: "op"; v: string };

/** 長いものから順に照合する演算子。 */
const OPERATORS = [
  ">>>",
  "<<",
  ">>",
  "<=",
  ">=",
  "==",
  "<>",
  "!=",
  "&&",
  "||",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "&",
  "|",
  "^",
  "~",
  "!",
  "<",
  ">",
  "=",
  "(",
  ")",
  "[",
  "]",
];

const isDigit = (c: string) => c >= "0" && c <= "9";
const isHex = (c: string) => /[0-9a-fA-F]/.test(c);
const isIdStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdPart = (c: string) => /[A-Za-z0-9_]/.test(c);

/** 32 ビット符号つき整数に折り返す。 */
export const toInt32 = (n: number): number => n | 0;

/**
 * 1行を字句に分ける。`;` から行末まではコメント。
 * 文字列（'…' / "…"）と文字コード（#13、#$0D）は、空白なしで隣り合っていれば1つの文字列になる。
 */
export function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = [];
  /** 直前が文字列（または文字コード）で、空白を挟まずに続いているか。 */
  let glue = false;
  const pushStr = (s: string) => {
    const last = tokens[tokens.length - 1];
    if (glue && last?.t === "str") last.v += s;
    else tokens.push({ t: "str", v: s });
    glue = true;
  };
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      glue = false;
      i += 1;
      continue;
    }
    if (c === ";") break;
    if (c === "'" || c === '"') {
      const end = line.indexOf(c, i + 1);
      if (end < 0) throw new TtlError("文字列が閉じていません");
      pushStr(line.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (c === "#") {
      let j = i + 1;
      let code: number;
      if (line[j] === "$") {
        j += 1;
        const start = j;
        while (j < line.length && isHex(line[j])) j += 1;
        if (j === start) throw new TtlError("文字コードが正しくありません: #$");
        code = parseInt(line.slice(start, j), 16);
      } else {
        const start = j;
        while (j < line.length && isDigit(line[j])) j += 1;
        if (j === start) throw new TtlError("文字コードが正しくありません: #");
        code = parseInt(line.slice(start, j), 10);
      }
      if (!(code >= 0 && code <= 0x10ffff)) {
        throw new TtlError(`文字コードが範囲外です: ${code}`);
      }
      pushStr(String.fromCodePoint(code));
      i = j;
      continue;
    }
    glue = false;
    if (c === "$") {
      let j = i + 1;
      while (j < line.length && isHex(line[j])) j += 1;
      if (j === i + 1) throw new TtlError("16進数が正しくありません: $");
      tokens.push({
        t: "num",
        v: toInt32(parseInt(line.slice(i + 1, j), 16)),
      });
      i = j;
      continue;
    }
    if (isDigit(c)) {
      let j = i;
      while (j < line.length && isDigit(line[j])) j += 1;
      const n = Number(line.slice(i, j));
      if (n > 2147483647) {
        throw new TtlError(`数値が大きすぎます: ${line.slice(i, j)}`);
      }
      tokens.push({ t: "num", v: n });
      i = j;
      continue;
    }
    if (isIdStart(c)) {
      let j = i;
      while (j < line.length && isIdPart(line[j])) j += 1;
      const v = line.slice(i, j);
      tokens.push({ t: "id", v, lower: v.toLowerCase() });
      i = j;
      continue;
    }
    const op = OPERATORS.find((o) => line.startsWith(o, i));
    if (op) {
      tokens.push({ t: "op", v: op });
      i += op.length;
      continue;
    }
    throw new TtlError(`使えない文字です: ${c}`);
  }
  return tokens;
}

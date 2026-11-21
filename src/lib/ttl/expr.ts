import { TtlError } from "./errors";
import { toInt32, type Token } from "./lexer";

export type Value = number | string;

export type Expr =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "var"; name: string }
  | { k: "un"; op: string; e: Expr }
  | { k: "bin"; op: string; l: Expr; r: Expr };

/** 変数の読み出し。値のない変数は例外にする。 */
export interface Env {
  get(name: string): Value;
}

/**
 * 二項演算子の優先順位（大きいほど先に結合する）。
 * Tera Term の式と同じ並び: 乗除 > 加減 > シフト > & > ^ > | > 比較 > 等号 > && > ||。
 */
const PRECEDENCE: Record<string, number> = {
  "*": 90,
  "/": 90,
  "%": 90,
  "+": 80,
  "-": 80,
  "<<": 70,
  ">>": 70,
  ">>>": 70,
  "&": 60,
  and: 60,
  "^": 50,
  xor: 50,
  "|": 40,
  or: 40,
  "<": 30,
  ">": 30,
  "<=": 30,
  ">=": 30,
  "=": 20,
  "==": 20,
  "<>": 20,
  "!=": 20,
  "&&": 10,
  "||": 5,
};
const UNARY_PRECEDENCE = 100;

/** 二項演算子の記号（`and` などの語は、小文字にそろえる）。 */
function binaryOp(token: Token | undefined): string | null {
  if (!token) return null;
  if (token.t === "op") return token.v in PRECEDENCE ? token.v : null;
  if (token.t === "id") return token.lower in PRECEDENCE ? token.lower : null;
  return null;
}

/** 式を解析する。演算子で続かなくなった位置で止まり、続く位置（`pos`）を返す。 */
export function parseExpr(
  tokens: Token[],
  start: number,
): { expr: Expr; pos: number } {
  let pos = start;

  const primary = (): Expr => {
    const tok = tokens[pos];
    if (!tok) throw new TtlError("式が必要です");
    if (tok.t === "num") {
      pos += 1;
      return { k: "num", v: tok.v };
    }
    if (tok.t === "str") {
      pos += 1;
      return { k: "str", v: tok.v };
    }
    if (tok.t === "op" && tok.v === "(") {
      pos += 1;
      const inner = expression(0);
      const close = tokens[pos];
      if (!close || close.t !== "op" || close.v !== ")") {
        throw new TtlError("括弧が閉じていません");
      }
      pos += 1;
      return inner;
    }
    if (tok.t === "op" && ["-", "+", "!", "~"].includes(tok.v)) {
      pos += 1;
      return { k: "un", op: tok.v, e: expression(UNARY_PRECEDENCE) };
    }
    if (tok.t === "id" && tok.lower === "not") {
      pos += 1;
      return { k: "un", op: "~", e: expression(UNARY_PRECEDENCE) };
    }
    if (tok.t === "id") {
      pos += 1;
      return { k: "var", name: tok.lower };
    }
    throw new TtlError("式が必要です");
  };

  const expression = (minPrecedence: number): Expr => {
    let left = primary();
    for (;;) {
      const op = binaryOp(tokens[pos]);
      if (op === null) break;
      const precedence = PRECEDENCE[op];
      if (precedence <= minPrecedence) break;
      pos += 1;
      const right = expression(precedence);
      left = { k: "bin", op, l: left, r: right };
    }
    return left;
  };

  const expr = expression(0);
  return { expr, pos };
}

const typeName = (v: Value) => (typeof v === "number" ? "整数" : "文字列");

function requireInts(op: string, l: Value, r: Value): [number, number] {
  if (typeof l !== "number" || typeof r !== "number") {
    throw new TtlError(
      `型が合いません: ${typeName(l)} ${op} ${typeName(r)}（${op} は整数どうしだけ）`,
    );
  }
  return [l, r];
}

/** 式を評価する。整数は 32 ビット符号つきで折り返す。 */
export function evalExpr(expr: Expr, env: Env): Value {
  switch (expr.k) {
    case "num":
    case "str":
      return expr.v;
    case "var":
      return env.get(expr.name);
    case "un": {
      const v = evalExpr(expr.e, env);
      if (typeof v !== "number") {
        throw new TtlError(`型が合いません: ${expr.op} は整数だけ`);
      }
      switch (expr.op) {
        case "-":
          return toInt32(-v);
        case "+":
          return v;
        case "!":
          return v === 0 ? 1 : 0;
        default:
          return ~v;
      }
    }
    case "bin": {
      const l = evalExpr(expr.l, env);
      const r = evalExpr(expr.r, env);
      return evalBinary(expr.op, l, r);
    }
  }
}

function evalBinary(op: string, l: Value, r: Value): Value {
  switch (op) {
    case "+":
      if (typeof l === "string" && typeof r === "string") return l + r;
      return toInt32(requireInts(op, l, r).reduce((a, b) => a + b));
    case "-": {
      const [a, b] = requireInts(op, l, r);
      return toInt32(a - b);
    }
    case "*": {
      const [a, b] = requireInts(op, l, r);
      return Math.imul(a, b);
    }
    case "/": {
      const [a, b] = requireInts(op, l, r);
      if (b === 0) throw new TtlError("0 で割れません");
      return toInt32(Math.trunc(a / b));
    }
    case "%": {
      const [a, b] = requireInts(op, l, r);
      if (b === 0) throw new TtlError("0 で割れません");
      return toInt32(a % b);
    }
    case "<<": {
      const [a, b] = requireInts(op, l, r);
      return a << (b & 31);
    }
    case ">>": {
      const [a, b] = requireInts(op, l, r);
      return a >> (b & 31);
    }
    case ">>>": {
      const [a, b] = requireInts(op, l, r);
      return (a >>> (b & 31)) | 0;
    }
    case "&":
    case "and": {
      const [a, b] = requireInts(op, l, r);
      return a & b;
    }
    case "|":
    case "or": {
      const [a, b] = requireInts(op, l, r);
      return a | b;
    }
    case "^":
    case "xor": {
      const [a, b] = requireInts(op, l, r);
      return a ^ b;
    }
    case "&&": {
      const [a, b] = requireInts(op, l, r);
      return a !== 0 && b !== 0 ? 1 : 0;
    }
    case "||": {
      const [a, b] = requireInts(op, l, r);
      return a !== 0 || b !== 0 ? 1 : 0;
    }
    default:
      return compare(op, l, r);
  }
}

function compare(op: string, l: Value, r: Value): number {
  if (typeof l !== typeof r) {
    throw new TtlError(
      `型が合いません: ${typeName(l)} ${op} ${typeName(r)}（比較は同じ型どうしだけ）`,
    );
  }
  const c = l < r ? -1 : l > r ? 1 : 0;
  switch (op) {
    case "<":
      return c < 0 ? 1 : 0;
    case ">":
      return c > 0 ? 1 : 0;
    case "<=":
      return c <= 0 ? 1 : 0;
    case ">=":
      return c >= 0 ? 1 : 0;
    case "=":
    case "==":
      return c === 0 ? 1 : 0;
    default:
      return c !== 0 ? 1 : 0;
  }
}

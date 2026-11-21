import { describe, expect, it } from "vitest";
import { TtlError } from "./errors";
import { evalExpr, parseExpr, type Value } from "./expr";
import { tokenizeLine } from "./lexer";

const vars: Record<string, Value> = { a: 7, b: 2, s: "abc", t: "abd" };
const env = {
  get: (name: string) => {
    if (!(name in vars)) throw new TtlError(`変数 ${name} に値がありません`);
    return vars[name];
  },
};
const ev = (src: string): Value => {
  const tokens = tokenizeLine(src);
  const { expr, pos } = parseExpr(tokens, 0);
  expect(pos).toBe(tokens.length);
  return evalExpr(expr, env);
};

describe("式の評価", () => {
  it("四則演算・剰余（整数。割り算は 0 方向へ丸める）", () => {
    expect(ev("1 + 2 * 3")).toBe(7);
    expect(ev("(1 + 2) * 3")).toBe(9);
    expect(ev("7 / 2")).toBe(3);
    expect(ev("-7 / 2")).toBe(-3);
    expect(ev("-7 % 3")).toBe(-1);
    expect(ev("a - b")).toBe(5);
    expect(ev("10 - 3 - 2")).toBe(5);
  });

  it("0 で割るとエラー", () => {
    expect(() => ev("1 / 0")).toThrow("0 で割れません");
    expect(() => ev("1 % 0")).toThrow("0 で割れません");
  });

  it("32 ビットで折り返す", () => {
    expect(ev("2147483647 + 1")).toBe(-2147483648);
    expect(ev("65536 * 65536")).toBe(0);
    expect(ev("-2147483647 - 2")).toBe(2147483647);
  });

  it("ビット演算とシフト（and / or / xor / not は & | ^ ~ と同じ）", () => {
    expect(ev("12 & 10")).toBe(8);
    expect(ev("12 | 10")).toBe(14);
    expect(ev("12 ^ 10")).toBe(6);
    expect(ev("12 and 10")).toBe(8);
    expect(ev("12 or 10")).toBe(14);
    expect(ev("12 xor 10")).toBe(6);
    expect(ev("~0")).toBe(-1);
    expect(ev("not 0")).toBe(-1);
    expect(ev("1 << 4")).toBe(16);
    expect(ev("-16 >> 2")).toBe(-4);
    expect(ev("-16 >>> 28")).toBe(15);
  });

  it("比較と論理（結果は 1 / 0）", () => {
    expect(ev("a > b")).toBe(1);
    expect(ev("a < b")).toBe(0);
    expect(ev("a >= 7")).toBe(1);
    expect(ev("a <= 6")).toBe(0);
    expect(ev("a = 7")).toBe(1);
    expect(ev("a == 7")).toBe(1);
    expect(ev("a <> 7")).toBe(0);
    expect(ev("a != 8")).toBe(1);
    expect(ev("(a > 1) && (b > 1)")).toBe(1);
    expect(ev("(a > 1) && (b > 5)")).toBe(0);
    expect(ev("(a > 100) || (b > 1)")).toBe(1);
    expect(ev("!0")).toBe(1);
    expect(ev("!5")).toBe(0);
  });

  it("優先順位: 比較は && より先、&& は || より先、ビット演算は比較より先", () => {
    expect(ev("1 = 1 && 2 = 2")).toBe(1);
    expect(ev("0 || 1 && 0")).toBe(0);
    expect(ev("1 || 0 && 0")).toBe(1);
    expect(ev("6 & 3 = 2")).toBe(1);
    expect(ev("1 + 2 << 1")).toBe(6);
    expect(ev("-2 * 3")).toBe(-6);
  });

  it("文字列: 連結と比較", () => {
    expect(ev("'ab' + 'cd'")).toBe("abcd");
    expect(ev("s + #13")).toBe("abc\r");
    expect(ev("s = 'abc'")).toBe(1);
    expect(ev("s < t")).toBe(1);
    expect(ev("s <> t")).toBe(1);
    expect(ev("t > s")).toBe(1);
  });

  it("型が合わない演算はエラー", () => {
    expect(() => ev("'a' + 1")).toThrow("型");
    expect(() => ev("'a' * 2")).toThrow("型");
    expect(() => ev("1 = 'a'")).toThrow("型");
    expect(() => ev("-'a'")).toThrow("型");
    expect(() => ev("!'a'")).toThrow("型");
  });

  it("値のない変数はエラー（変数名つき）", () => {
    expect(() => ev("zzz + 1")).toThrow("zzz");
  });

  it("変数名の大文字小文字は区別しない", () => {
    expect(ev("A + B")).toBe(9);
  });
});

describe("式の解析", () => {
  it("演算子で続かない所で止まる（コマンドの引数を空白で区切るため）", () => {
    const tokens = tokenizeLine("'a' 13 b");
    const first = parseExpr(tokens, 0);
    expect(first.pos).toBe(1);
    const second = parseExpr(tokens, first.pos);
    expect(second.pos).toBe(2);
    expect(evalExpr(second.expr, env)).toBe(13);
  });

  it("括弧が閉じていない・式がない場合はエラー", () => {
    expect(() => parseExpr(tokenizeLine("(1 + 2"), 0)).toThrow("閉じ");
    expect(() => parseExpr(tokenizeLine("1 +"), 0)).toThrow("式");
    expect(() => parseExpr(tokenizeLine(")"), 0)).toThrow("式");
    expect(() => parseExpr([], 0)).toThrow("式");
  });
});

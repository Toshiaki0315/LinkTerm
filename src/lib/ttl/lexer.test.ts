import { describe, expect, it } from "vitest";
import { TtlError } from "./errors";
import { tokenizeLine } from "./lexer";

describe("tokenizeLine", () => {
  it("識別子・数値・記号に分ける。識別子は小文字化した名前も持つ（TTL は大文字小文字を区別しない）", () => {
    expect(tokenizeLine("Result = 1 + foo_2")).toEqual([
      { t: "id", v: "Result", lower: "result" },
      { t: "op", v: "=" },
      { t: "num", v: 1 },
      { t: "op", v: "+" },
      { t: "id", v: "foo_2", lower: "foo_2" },
    ]);
  });

  it("文字列は '…' でも \"…\" でもよい。中に別の種類の引用符を含められる（エスケープはない）", () => {
    expect(tokenizeLine(`'a"b' "c'd"`)).toEqual([
      { t: "str", v: 'a"b' },
      { t: "str", v: "c'd" },
    ]);
  });

  it("文字コード #13 と、隣り合う文字列は1つにつながる（空白があれば別）", () => {
    expect(tokenizeLine("'ab'#13#10'c'")).toEqual([{ t: "str", v: "ab\r\nc" }]);
    expect(tokenizeLine("#65 #66")).toEqual([
      { t: "str", v: "A" },
      { t: "str", v: "B" },
    ]);
    expect(tokenizeLine("#$41")).toEqual([{ t: "str", v: "A" }]);
  });

  it("16進数は $FF。32ビットの整数に収まらない 10 進数・16 進数は扱いが違う（16 進は折り返し、10 進はエラー）", () => {
    expect(tokenizeLine("$FF $ffffffff")).toEqual([
      { t: "num", v: 255 },
      { t: "num", v: -1 },
    ]);
    expect(() => tokenizeLine("99999999999")).toThrow(TtlError);
  });

  it("コメント（; 以降）を無視する。文字列の中の ; は文字", () => {
    expect(tokenizeLine("send 'a;b' ; 説明")).toEqual([
      { t: "id", v: "send", lower: "send" },
      { t: "str", v: "a;b" },
    ]);
    expect(tokenizeLine("; ぜんぶコメント")).toEqual([]);
    expect(tokenizeLine("   ")).toEqual([]);
  });

  it("2文字・3文字の演算子を最長一致で取る", () => {
    const ops = (s: string) =>
      tokenizeLine(s)
        .filter((t) => t.t === "op")
        .map((t) => (t as { v: string }).v);
    expect(ops("a >>> b << c >> d <= e >= f == g <> h != i && j || k")).toEqual(
      [">>>", "<<", ">>", "<=", ">=", "==", "<>", "!=", "&&", "||"],
    );
    expect(ops("a += 1")).toEqual(["+="]);
    expect(ops("a = (1 + 2) * 3 - 4 / 5 % 6 & 7 | 8 ^ 9 ~ ! < >")).toEqual([
      "=",
      "(",
      "+",
      ")",
      "*",
      "-",
      "/",
      "%",
      "&",
      "|",
      "^",
      "~",
      "!",
      "<",
      ">",
    ]);
  });

  it("閉じていない文字列・未対応の文字は、エラー（位置の情報つき）", () => {
    expect(() => tokenizeLine("send 'abc")).toThrow("閉じていません");
    expect(() => tokenizeLine("a = @")).toThrow("使えない文字");
  });

  it("不正な文字コード（範囲外・数字がない）はエラー", () => {
    expect(() => tokenizeLine("#")).toThrow(TtlError);
    expect(() => tokenizeLine("#99999999")).toThrow(TtlError);
  });
});

import { describe, expect, it } from "vitest";
import {
  compileRules,
  findMatches,
  highlightColors,
  lineFromCells,
  newRule,
  OutputMatcher,
  toColumns,
  validateRule,
  type HighlightRule,
} from "./highlight";

const rule = (over: Partial<HighlightRule> = {}): HighlightRule => ({
  ...newRule(over.id ?? "r"),
  pattern: "ERROR",
  ...over,
});

describe("validateRule", () => {
  it("空・長すぎる・不正な正規表現・空に一致する正規表現を拒否する", () => {
    expect(validateRule(rule())).toBeNull();
    expect(validateRule(rule({ pattern: "" }))).toMatch(/文字列/);
    expect(validateRule(rule({ pattern: "a".repeat(201) }))).toMatch(/200/);
    expect(validateRule(rule({ regex: true, pattern: "(" }))).toMatch(
      /正規表現/,
    );
    expect(validateRule(rule({ regex: true, pattern: "a*" }))).toMatch(/空の/);
    expect(validateRule(rule({ regex: true, pattern: "err(or)?" }))).toBeNull();
    // 正規表現でなければ、記号もそのままの文字。
    expect(validateRule(rule({ pattern: "(" }))).toBeNull();
  });
});

describe("findMatches", () => {
  it("大文字小文字を区別しない（既定）。区別する指定もできる", () => {
    const loose = compileRules([rule({ pattern: "error" })]);
    expect(findMatches("An ERROR and an Error", loose)).toHaveLength(2);
    const strict = compileRules([
      rule({ pattern: "ERROR", caseSensitive: true }),
    ]);
    expect(findMatches("An ERROR and an Error", strict)).toEqual([
      { start: 3, end: 8, rule: strict[0].rule },
    ]);
  });

  it("文字列は記号をそのまま探す。正規表現は式として扱う", () => {
    const plain = compileRules([rule({ pattern: "a.b(c)" })]);
    expect(findMatches("a.b(c) axb(c)", plain)).toHaveLength(1);
    const re = compileRules([rule({ regex: true, pattern: "\\d{3}" })]);
    expect(
      findMatches("id 123 and 45 and 678", re).map((m) => m.start),
    ).toEqual([3, 18]);
  });

  it("重なるときは、規則の並びが前のものを優先し、左から順に返す", () => {
    const rules = compileRules([
      rule({ id: "a", pattern: "fatal error" }),
      rule({ id: "b", pattern: "error" }),
    ]);
    const m = findMatches("a fatal error here, error", rules);
    expect(m.map((x) => [x.rule.id, x.start, x.end])).toEqual([
      ["a", 2, 13],
      ["b", 20, 25],
    ]);
  });

  it("壊れた規則は無視し、行が長すぎれば先頭だけ見る。何もなければ空", () => {
    const rules = compileRules([
      rule({ id: "bad", regex: true, pattern: "(" }),
      rule({ id: "ok", pattern: "x" }),
    ]);
    expect(rules).toHaveLength(1);
    expect(findMatches("", rules)).toEqual([]);
    expect(findMatches("x", [])).toEqual([]);
    expect(findMatches("a".repeat(5000) + "x", rules)).toEqual([]);
  });

  it("1行に付ける強調は50個まで", () => {
    const rules = compileRules([rule({ pattern: "x" })]);
    expect(findMatches("x".repeat(200), rules)).toHaveLength(50);
  });
});

describe("lineFromCells / toColumns", () => {
  const cell = (chars: string, width = 1) => ({ chars, width });

  it("全角文字は2列、続きのセルは文字を持たない。空のセルは空白", () => {
    // "A日B" → A(0) 日(1,2) B(3) 空(4)
    const { text, columns } = lineFromCells([
      cell("A"),
      cell("日", 2),
      cell("", 0),
      cell("B"),
      cell(""),
    ]);
    expect(text).toBe("A日B ");
    expect(columns).toEqual([0, 1, 3, 4, 5]);
    // "日B" に一致 → 開始列 1、幅 3（日=2 + B=1）
    expect(toColumns({ start: 1, end: 3 }, columns)).toEqual({
      x: 1,
      width: 3,
    });
  });

  it("サロゲートペアの文字は、列を2文字分で共有する", () => {
    const { text, columns } = lineFromCells([
      cell("😀", 2),
      cell("", 0),
      cell("x"),
    ]);
    expect(text).toBe("😀x");
    expect(columns).toEqual([0, 0, 2, 3]);
    expect(toColumns({ start: 0, end: 2 }, columns)).toEqual({
      x: 0,
      width: 2,
    });
    expect(toColumns({ start: 2, end: 3 }, columns)).toEqual({
      x: 2,
      width: 1,
    });
  });
});

describe("highlightColors", () => {
  it("背景色と読みやすい文字色を返す", () => {
    expect(highlightColors("yellow").foreground).toBe("#000000");
    expect(highlightColors("blue").foreground).toBe("#ffffff");
    expect(highlightColors("red").background).toBe("#ef4444");
  });
});

describe("OutputMatcher", () => {
  const notifyRule = (over: Partial<HighlightRule> = {}) =>
    rule({ notify: true, ...over });

  it("通知する規則だけを見て、一致した規則を返す（重複なし）", () => {
    const m = new OutputMatcher([
      notifyRule({ id: "n", pattern: "done" }),
      rule({ id: "quiet", pattern: "ERROR", notify: false }),
    ]);
    expect(m.feed("ERROR happened\n")).toEqual([]);
    expect(m.feed("build done, done\n").map((r) => r.id)).toEqual(["n"]);
  });

  it("分割して届いた語も見つけ、同じ一致を二度報告しない", () => {
    const m = new OutputMatcher([notifyRule({ id: "n", pattern: "complete" })]);
    expect(m.feed("job comp")).toEqual([]);
    expect(m.feed("lete\n").map((r) => r.id)).toEqual(["n"]);
    expect(m.feed("next line\n")).toEqual([]);
  });

  it("行をまたいで一致させない", () => {
    const m = new OutputMatcher([notifyRule({ pattern: "ab" })]);
    expect(m.feed("a\r\nb\n")).toEqual([]);
  });

  it("改行が続けて届いても、新しい行の一致を見逃さない", () => {
    const m = new OutputMatcher([notifyRule({ id: "n", pattern: "FAIL" })]);
    m.feed("ok\r\n");
    expect(m.feed("\r\nFAIL: x\r\n").map((r) => r.id)).toEqual(["n"]);
  });

  it("通知する規則がなければ何も返さない", () => {
    expect(new OutputMatcher([]).feed("anything")).toEqual([]);
  });
});

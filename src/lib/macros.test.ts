import { describe, expect, it } from "vitest";
import {
  MAX_NAME_CHARS,
  baseNameOf,
  checkMacroSource,
  newMacro,
  validateMacro,
} from "./macros";

const macro = (over = {}) => ({
  id: "m1",
  name: "ログイン",
  text: "wait 'login:'\nsendln 'admin'",
  ...over,
});

describe("validateMacro", () => {
  it("問題がなければ null", () => {
    expect(validateMacro(macro())).toBeNull();
  });

  it("名前が空・長すぎるとエラー", () => {
    expect(validateMacro(macro({ name: "  " }))).toContain("名前");
    expect(
      validateMacro(macro({ name: "あ".repeat(MAX_NAME_CHARS + 1) })),
    ).toContain("名前");
  });

  it("本文が空・長すぎるとエラー", () => {
    expect(validateMacro(macro({ text: " \n" }))).toContain("スクリプト");
    expect(validateMacro(macro({ text: "a".repeat(100_001) }))).toContain(
      "スクリプト",
    );
  });

  it("文法のエラーは、最初の1件を行番号つきで返す", () => {
    const msg = validateMacro(macro({ text: "send 'a'\nfrobnicate" }));
    expect(msg).toContain("2行目");
    expect(msg).toContain("frobnicate");
  });
});

describe("checkMacroSource", () => {
  it("エラーを、行番号とメッセージで返す（すべて）", () => {
    const issues = checkMacroSource("send 'abc\na = @\nsend 'ok'");
    expect(issues.map((i) => i.line)).toEqual([1, 2]);
  });

  it("問題がなければ空", () => {
    expect(checkMacroSource("sendln 'ls'")).toEqual([]);
    expect(checkMacroSource("")).toEqual([]);
  });
});

describe("newMacro / baseNameOf", () => {
  it("新しいマクロは、名前も本文も空", () => {
    expect(newMacro("x")).toEqual({ id: "x", name: "", text: "" });
  });

  it("ファイルのパスから、拡張子を除いた名前を作る", () => {
    expect(baseNameOf("/Users/me/scripts/login.ttl")).toBe("login");
    expect(baseNameOf("/a/b/some.name.ttl")).toBe("some.name");
    expect(baseNameOf("noext")).toBe("noext");
    expect(baseNameOf("/a/b/")).toBe("");
  });
});

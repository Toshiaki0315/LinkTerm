import { describe, expect, it } from "vitest";
import {
  bufferToText,
  defaultExportName,
  type TextBuffer,
} from "./screen-text";

/** 行の配列（`[文字列, 折り返しの続きか]`）から、偽のバッファを作る。 */
const buf = (rows: Array<[string, boolean?]>): TextBuffer => ({
  length: rows.length,
  getLine: (y) =>
    rows[y]
      ? {
          isWrapped: Boolean(rows[y][1]),
          translateToString: (trim) =>
            trim ? rows[y][0].trimEnd() : rows[y][0],
        }
      : undefined,
});

describe("bufferToText", () => {
  it("行を改行でつなぎ、各行の右端の空白と、末尾の空行を除く", () => {
    expect(bufferToText(buf([["a   "], ["b"], ["   "], [""]]))).toBe("a\nb\n");
  });

  it("折り返された行は、1行につなぐ", () => {
    expect(
      bufferToText(buf([["abcde"], ["fgh", true], ["ijk", true], ["next"]])),
    ).toBe("abcdefghijk\nnext\n");
  });

  it("途中の空行は残す。何もなければ空文字", () => {
    expect(bufferToText(buf([["a"], [""], ["b"]]))).toBe("a\n\nb\n");
    expect(bufferToText(buf([[""], ["  "]]))).toBe("");
    expect(bufferToText(buf([]))).toBe("");
  });
});

describe("defaultExportName", () => {
  it("terminal-日付-時刻.txt", () => {
    expect(defaultExportName(new Date(2024, 0, 2, 3, 4, 5))).toBe(
      "terminal-20240102-030405.txt",
    );
  });
});

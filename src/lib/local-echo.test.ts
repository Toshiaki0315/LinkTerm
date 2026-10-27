import { describe, expect, it } from "vitest";
import { echoFor, isLocalEchoOn } from "./local-echo";

describe("echoFor（キー入力のローカル表示）", () => {
  it("印字できる文字はそのまま表示する（日本語も）", () => {
    expect(echoFor("abc 123")).toBe("abc 123");
    expect(echoFor("日本語")).toBe("日本語");
  });

  it("Enter（CR）は改行（CRLF）として表示する", () => {
    expect(echoFor("ls\r")).toBe("ls\r\n");
    expect(echoFor("\r")).toBe("\r\n");
  });

  it("バックスペース（DEL / BS）は1文字を消す", () => {
    expect(echoFor("\x7f")).toBe("\b \b");
    expect(echoFor("\b")).toBe("\b \b");
    expect(echoFor("ab\x7f")).toBe("ab\b \b");
  });

  it("エスケープシーケンス（矢印キー等）や制御文字は表示しない", () => {
    expect(echoFor("\x1b[A")).toBe("");
    expect(echoFor("\x1b[1;5C")).toBe("");
    expect(echoFor("\x1bOP")).toBe("");
    expect(echoFor("\x03")).toBe("");
    expect(echoFor("\t")).toBe("\t");
  });

  it("貼り付けた複数行も、改行ごとに CRLF にする", () => {
    expect(echoFor("a\r\nb\nc")).toBe("a\r\nb\r\nc");
  });

  it("空文字は空", () => {
    expect(echoFor("")).toBe("");
  });
});

describe("isLocalEchoOn", () => {
  it("オン／オフは常にその指定どおり", () => {
    for (const remote of [null, true, false]) {
      expect(isLocalEchoOn("on", remote)).toBe(true);
      expect(isLocalEchoOn("off", remote)).toBe(false);
    }
  });

  it("自動: 接続先がエコーしていなければオン、していればオフ、判定できなければオフ", () => {
    expect(isLocalEchoOn("auto", false)).toBe(true);
    expect(isLocalEchoOn("auto", true)).toBe(false);
    expect(isLocalEchoOn("auto", null)).toBe(false);
  });
});

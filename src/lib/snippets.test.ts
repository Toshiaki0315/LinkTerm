import { describe, expect, it, vi } from "vitest";
import { newSnippet, runSnippet, snippetSteps, type Snippet } from "./snippets";

const sn = (over: Partial<Snippet> = {}): Snippet => ({
  ...newSnippet("a"),
  name: "n",
  text: "ls\npwd",
  ...over,
});

describe("snippetSteps", () => {
  it("1行ずつ Enter を付けて送り、行の間に待ち時間を置く", () => {
    expect(snippetSteps(sn({ lineDelayMs: 300 }))).toEqual([
      { data: "ls\r", delayMs: 300 },
      { data: "pwd\r", delayMs: 0 },
    ]);
  });

  it("Enter なしなら最後の行だけ Enter を付けない", () => {
    expect(snippetSteps(sn({ sendEnter: false }))).toEqual([
      { data: "ls\r", delayMs: 0 },
      { data: "pwd", delayMs: 0 },
    ]);
  });

  it("改行コードの違い（CRLF / CR）と末尾の改行を吸収する。途中の空行は Enter だけ送る", () => {
    expect(
      snippetSteps(sn({ text: "a\r\n\r\nb\n" })).map((s) => s.data),
    ).toEqual(["a\r", "\r", "b\r"]);
    expect(snippetSteps(sn({ text: "a\rb" })).map((s) => s.data)).toEqual([
      "a\r",
      "b\r",
    ]);
  });

  it("1行だけでもよい", () => {
    expect(snippetSteps(sn({ text: "reboot" }))).toEqual([
      { data: "reboot\r", delayMs: 0 },
    ]);
  });
});

describe("runSnippet", () => {
  it("順に送り、待ち時間だけ待つ", async () => {
    const calls: string[] = [];
    const send = vi.fn(async (d: string) => {
      calls.push(`send:${d}`);
      return true;
    });
    const sleep = vi.fn(async (ms: number) => {
      calls.push(`sleep:${ms}`);
    });
    await expect(
      runSnippet(sn({ lineDelayMs: 50 }), send, sleep),
    ).resolves.toBe(true);
    expect(calls).toEqual(["send:ls\r", "sleep:50", "send:pwd\r"]);
  });

  it("待ち時間が 0 なら待たない", async () => {
    const sleep = vi.fn(async () => {});
    await runSnippet(sn(), async () => true, sleep);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("送り先がなくなったら、残りを送らず中断する", async () => {
    const send = vi.fn(async () => false);
    await expect(runSnippet(sn(), send, async () => {})).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

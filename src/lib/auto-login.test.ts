import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LoginRunner,
  MAX_LOGIN_STEPS,
  parseLoginScript,
  scriptUsesPassword,
  stripTerminalControls,
} from "./auto-login";

describe("parseLoginScript", () => {
  it("「待つ文字列 => 送る文字列」を1行1手順で読む。空行とコメントは無視する", () => {
    const r = parseLoginScript(
      "# ルーターへログイン\nlogin: => admin\n\nPassword: => {password}\n",
    );
    expect(r).toEqual({
      ok: true,
      steps: [
        { wait: "login:", send: "admin" },
        { wait: "Password:", send: "{password}" },
      ],
    });
  });

  it("待つ文字列が空なら待たずに送る。送る文字列が空なら Enter だけ", () => {
    expect(parseLoginScript("=> hello\nPress any key =>")).toEqual({
      ok: true,
      steps: [
        { wait: null, send: "hello" },
        { wait: "Press any key", send: "" },
      ],
    });
  });

  it("区切りのない行は、行番号つきのエラー", () => {
    const r = parseLoginScript("ok => x\nbad line");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("2行目");
  });

  it("長すぎる項目と手順の数の上限はエラー", () => {
    expect(parseLoginScript(`${"a".repeat(201)} => x`).ok).toBe(false);
    const many = Array.from({ length: MAX_LOGIN_STEPS + 1 }, () => "a => b");
    expect(parseLoginScript(many.join("\n")).ok).toBe(false);
    expect(parseLoginScript(many.slice(0, MAX_LOGIN_STEPS).join("\n")).ok).toBe(
      true,
    );
  });

  it("空のスクリプトは手順なし", () => {
    expect(parseLoginScript("  \n# だけ")).toEqual({ ok: true, steps: [] });
  });
});

describe("scriptUsesPassword", () => {
  it("{password} を送る手順があるときだけ true", () => {
    expect(scriptUsesPassword("Password: => {password}")).toBe(true);
    expect(scriptUsesPassword("login: => admin")).toBe(false);
    expect(scriptUsesPassword("不正な行")).toBe(false);
  });
});

describe("stripTerminalControls", () => {
  it("色などのエスケープシーケンスと制御文字を除き、改行は残す", () => {
    expect(
      stripTerminalControls("\u001b[1;32mlogin:\u001b[0m \r\n\u0007"),
    ).toBe("login: \n");
    expect(stripTerminalControls("\u001b]0;title\u0007Password:")).toBe(
      "Password:",
    );
  });
});

describe("LoginRunner", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function make(
    script: string,
    over: { password?: string; timeoutMs?: number; begin?: boolean } = {},
  ) {
    const parsed = parseLoginScript(script);
    if (!parsed.ok) throw new Error(parsed.error);
    const sent: string[] = [];
    const onDone = vi.fn();
    const onTimeout = vi.fn();
    const runner = new LoginRunner({
      steps: parsed.steps,
      password: over.password ?? "pw",
      send: (d) => sent.push(d),
      onDone,
      onTimeout,
      timeoutMs: over.timeoutMs,
    });
    if (over.begin !== false) runner.begin();
    return { runner, sent, onDone, onTimeout };
  }

  it("出力に待つ文字列が出たら送り、次の手順は新しく出た出力を待つ", () => {
    const { runner, sent, onDone } = make(
      "login: => admin\nPassword: => {password}",
    );
    runner.feed("Welcome\r\nlogin: ");
    expect(sent).toEqual(["admin\r"]);
    runner.feed("admin\r\nPassword: ");
    expect(sent).toEqual(["admin\r", "pw\r"]);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(runner.done).toBe(true);
  });

  it("文字列が分割して届いても見つける", () => {
    const { runner, sent } = make("login: => root");
    runner.feed("log");
    runner.feed("in");
    expect(sent).toEqual([]);
    runner.feed(": ");
    expect(sent).toEqual(["root\r"]);
  });

  it("同じ文字列が最初の出力に混ざっていても、一致の後ろだけを次の手順に使う", () => {
    const { runner, sent } = make("login: => a\nlogin: => b");
    runner.feed("login: login: ");
    expect(sent).toEqual(["a\r", "b\r"]);
  });

  it("待たない手順は、すぐに送る（作った時点で）", () => {
    const { sent, onDone } = make("=> hello\n=> world");
    expect(sent).toEqual(["hello\r", "world\r"]);
    expect(onDone).toHaveBeenCalled();
  });

  it("色付きのプロンプトでも一致する", () => {
    const { runner, sent } = make("Password: => {password}");
    runner.feed("\u001b[1mPassword:\u001b[0m ");
    expect(sent).toEqual(["pw\r"]);
  });

  it("パスワードに特殊文字や {password} を含んでも、そのまま送る", () => {
    const { runner, sent } = make("P: => {password}", {
      password: "a$&{password}b",
    });
    runner.feed("P:");
    expect(sent).toEqual(["a$&{password}b\r"]);
  });

  it("待っても来なければ時間切れを通知し、それ以降は送らない", () => {
    const { runner, sent, onTimeout, onDone } = make("login: => a", {
      timeoutMs: 1000,
    });
    vi.advanceTimersByTime(999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledWith("login:");
    runner.feed("login:");
    expect(sent).toEqual([]);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("途中の出力でタイマーを延長しない（手順ごとの上限）", () => {
    const { runner, onTimeout } = make("login: => a", { timeoutMs: 1000 });
    vi.advanceTimersByTime(600);
    runner.feed("noise");
    vi.advanceTimersByTime(400);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("中断すると送らず、時間切れも通知しない", () => {
    const { runner, sent, onTimeout } = make("login: => a", { timeoutMs: 100 });
    runner.stop();
    runner.feed("login:");
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([]);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("始める前に届いた出力も、始めた時点で照合する。何も送らず待ち続けることもない", () => {
    const { runner, sent, onTimeout } = make("login: => a", {
      begin: false,
      timeoutMs: 100,
    });
    runner.feed("login: ");
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([]);
    expect(onTimeout).not.toHaveBeenCalled();
    runner.begin();
    runner.begin();
    expect(sent).toEqual(["a\r"]);
  });

  it("手順が空なら、始めてすぐ完了する", () => {
    const { onDone } = make("# なし");
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseProgram } from "./parser";
import { TtlRunner, type TtlHost, type RunResult } from "./runner";

interface Fake {
  host: TtlHost;
  sent: string[];
  displayed: string[];
  messages: Array<{ message: string; title: string }>;
  yesno: boolean[];
  inputs: Array<string | null>;
  passwords: Array<string | null>;
  inputPrompts: Array<{ message: string; title: string; def: string }>;
  breaks: number;
  disconnected: number;
  connected: boolean;
}

function fake(over: Partial<TtlHost> = {}): Fake {
  const f: Fake = {
    sent: [],
    displayed: [],
    messages: [],
    yesno: [],
    inputs: [],
    passwords: [],
    inputPrompts: [],
    breaks: 0,
    disconnected: 0,
    connected: true,
    host: undefined as unknown as TtlHost,
  };
  f.host = {
    send: (d) => void f.sent.push(d),
    sendBreak: async () => void (f.breaks += 1),
    display: (t) => void f.displayed.push(t),
    messagebox: async (message, title) =>
      void f.messages.push({ message, title }),
    yesnobox: async () => f.yesno.shift() ?? false,
    inputbox: async (message, title, def) => {
      f.inputPrompts.push({ message, title, def });
      return f.inputs.shift() ?? null;
    },
    passwordbox: async () => f.passwords.shift() ?? null,
    disconnect: () => void (f.disconnected += 1),
    isConnected: () => f.connected,
    now: () => new Date(2024, 0, 2, 3, 4, 5),
    random: (max) => Math.min(3, max - 1),
    ...over,
  };
  return f;
}

function make(src: string, f = fake()) {
  const parsed = parseProgram(src);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const runner = new TtlRunner(parsed.program, f.host);
  return { runner, f };
}

async function run(
  src: string,
  f = fake(),
): Promise<{ result: RunResult; f: Fake }> {
  const { runner } = make(src, f);
  const result = await runner.run();
  return { result, f };
}

describe("TtlRunner: 基本", () => {
  it("send は引数を順に送る（整数は文字コード）。sendln は最後に改行（Enter）を付ける", async () => {
    const { result, f } = await run("send 'ab' 13 #65\nsendln 'ls'\nsendln");
    expect(result).toEqual({ status: "done" });
    expect(f.sent.join("")).toBe("ab\rAls\r\r");
  });

  it("変数と代入。+= などの複合代入。inc / dec", async () => {
    const { f } = await run(
      "a = 1\na += 4\na *= 3\na -= 5\na /= 2\na %= 3\ninc a\ninc a\ndec a\ns = 'x'\ns += 'y'\nsend s\nsend a",
    );
    // a: 1→5→15→10→5→2→3→4→3
    expect(f.sent.join("")).toBe("xy\u0003");
  });

  it("値のない変数を使うと、行番号つきのエラー", async () => {
    const { result } = await run("send zzz");
    expect(result).toMatchObject({ status: "error", line: 1 });
    expect((result as { message: string }).message).toContain("zzz");
  });

  it("end で終わる。end のあとは実行しない", async () => {
    const { result, f } = await run("send 'a'\nend\nsend 'b'");
    expect(result.status).toBe("done");
    expect(f.sent.join("")).toBe("a");
  });

  it("exit でも終わる", async () => {
    const { f } = await run("send 'a'\nexit\nsend 'b'");
    expect(f.sent.join("")).toBe("a");
  });
});

describe("TtlRunner: 制御構造", () => {
  it("if / elseif / else", async () => {
    const script = (n: number) =>
      `a = ${n}\nif a = 1 then\nsend 'one'\nelseif a = 2 then\nsend 'two'\nelse\nsend 'other'\nendif`;
    expect((await run(script(1))).f.sent.join("")).toBe("one");
    expect((await run(script(2))).f.sent.join("")).toBe("two");
    expect((await run(script(9))).f.sent.join("")).toBe("other");
  });

  it("elseif を複数。最初に真になった枝だけ実行する", async () => {
    const src =
      "a = 3\nif a = 1 then\nsend 'a'\nelseif a >= 2 then\nsend 'b'\nelseif a >= 3 then\nsend 'c'\nendif";
    expect((await run(src)).f.sent.join("")).toBe("b");
  });

  it("1行の if", async () => {
    const { f } = await run("if 1 then send 'a'\nif 0 then send 'b'\nsend 'c'");
    expect(f.sent.join("")).toBe("ac");
  });

  it("入れ子の if", async () => {
    const src =
      "a = 1\nb = 2\nif a = 1 then\nif b = 3 then\nsend 'x'\nelse\nsend 'y'\nendif\nsend 'z'\nendif";
    expect((await run(src)).f.sent.join("")).toBe("yz");
  });

  it("while / endwhile", async () => {
    const { f } = await run("i = 0\nwhile i < 3\nsend 'x'\ninc i\nendwhile");
    expect(f.sent.join("")).toBe("xxx");
  });

  it("until / enduntil（条件が偽の間、繰り返す）", async () => {
    const { f } = await run("i = 0\nuntil i = 2\nsend 'x'\ninc i\nenduntil");
    expect(f.sent.join("")).toBe("xx");
  });

  it("do-loop: 先頭の判定・末尾の判定・判定なし", async () => {
    const a = await run("i = 0\ndo while i < 2\nsend 'a'\ninc i\nloop");
    expect(a.f.sent.join("")).toBe("aa");
    const b = await run("i = 5\ndo\nsend 'b'\ninc i\nloop while i < 3");
    expect(b.f.sent.join("")).toBe("b");
    const c = await run("i = 0\ndo\nsend 'c'\ninc i\nloop until i = 3");
    expect(c.f.sent.join("")).toBe("ccc");
    const d = await run("i = 0\ndo\ninc i\nif i = 4 then break\nloop\nsend i");
    expect(d.f.sent.join("")).toBe("\u0004");
  });

  it("for / next（増える向きも減る向きも。終わりの値を含む）", async () => {
    const up = await run("for i 1 3\nsend i\nnext");
    expect(up.f.sent.join("")).toBe("\u0001\u0002\u0003");
    const down = await run("for i 3 1\nsend i\nnext");
    expect(down.f.sent.join("")).toBe("\u0003\u0002\u0001");
    const once = await run("for i 5 5\nsend i\nnext");
    expect(once.f.sent.join("")).toBe("\u0005");
  });

  it("for の入れ子", async () => {
    const { f } = await run("for i 1 2\nfor j 1 2\nsend 'x'\nnext\nnext");
    expect(f.sent.join("")).toBe("xxxx");
  });

  it("break / continue", async () => {
    const a = await run("for i 1 5\nif i = 3 then break\nsend i\nnext");
    expect(a.f.sent.join("")).toBe("\u0001\u0002");
    const b = await run("for i 1 4\nif i = 2 then continue\nsend i\nnext");
    expect(b.f.sent.join("")).toBe("\u0001\u0003\u0004");
    const c = await run(
      "i = 0\nwhile i < 4\ninc i\nif i = 2 then continue\nsend i\nendwhile",
    );
    expect(c.f.sent.join("")).toBe("\u0001\u0003\u0004");
    const d = await run(
      "i = 0\ndo\ninc i\nif i = 2 then continue\nsend i\nloop while i < 3",
    );
    expect(d.f.sent.join("")).toBe("\u0001\u0003");
  });

  it("break は、外側のループを続けたまま、内側だけ抜ける", async () => {
    const { f } = await run(
      "for i 1 2\nfor j 1 5\nif j = 2 then break\nsend 'x'\nnext\nsend 'y'\nnext",
    );
    expect(f.sent.join("")).toBe("xyxy");
  });

  it("goto とラベル", async () => {
    const { f } = await run("goto skip\nsend 'a'\n:skip\nsend 'b'");
    expect(f.sent.join("")).toBe("b");
  });

  it("call / return（サブルーチン。入れ子も）", async () => {
    const { f } = await run(
      "call one\nsend 'z'\nend\n:one\nsend 'a'\ncall two\nsend 'c'\nreturn\n:two\nsend 'b'\nreturn",
    );
    expect(f.sent.join("")).toBe("abcz");
  });

  it("call のないところの return はエラー", async () => {
    const { result } = await run("return");
    expect(result).toMatchObject({ status: "error", line: 1 });
  });

  it("goto でループを抜けても、そのあと動く", async () => {
    const { f } = await run(
      "for i 1 3\nif i = 2 then goto out\nsend 'a'\nnext\n:out\nfor k 1 2\nsend 'k'\nnext",
    );
    expect(f.sent.join("")).toBe("akk");
  });
});

describe("TtlRunner: 文字列と数値の命令", () => {
  const out = async (src: string) => (await run(src)).f.sent.join("");

  it("strlen / strconcat / strcopy / strinsert / strremove / strreplace", async () => {
    expect(await out("strlen 'hello'\nsend result")).toBe("\u0005");
    expect(await out("s = 'ab'\nstrconcat s 'cd'\nsend s")).toBe("abcd");
    expect(await out("strcopy 'abcdef' 2 3 s\nsend s")).toBe("bcd");
    expect(await out("s = 'abef'\nstrinsert s 3 'cd'\nsend s")).toBe("abcdef");
    expect(await out("s = 'abcdef'\nstrremove s 2 3\nsend s")).toBe("aef");
    expect(await out("s = 'a1b22c'\nstrreplace s 1 '[0-9]+' '#'\nsend s")).toBe(
      "a#b22c",
    );
  });

  it("strscan（1から数える。なければ 0）/ strmatch / strcompare", async () => {
    expect(await out("strscan 'abcabc' 'ca'\nsend result")).toBe("\u0003");
    expect(await out("strscan 'abc' 'zz'\nsend result")).toBe("\u0000");
    expect(await out("strmatch 'abc123' '[0-9]+'\nsend result")).toBe("\u0004");
    expect(await out("strmatch 'abc' '[0-9]+'\nsend result")).toBe("\u0000");
    expect(await out("strcompare 'a' 'b'\nsend result + 10")).toBe("\u0009");
    expect(await out("strcompare 'b' 'b'\nsend result")).toBe("\u0000");
    expect(await out("strcompare 'c' 'b'\nsend result")).toBe("\u0001");
  });

  it("strtrim / tolower / toupper / int2str / str2int / code2str / str2code", async () => {
    expect(await out("s = '  ab  '\nstrtrim s ' '\nsend s")).toBe("ab");
    expect(await out("tolower s 'AbC'\nsend s")).toBe("abc");
    expect(await out("toupper s 'AbC'\nsend s")).toBe("ABC");
    expect(await out("int2str s 123\nsend s")).toBe("123");
    expect(await out("str2int n '42'\nsend n")).toBe("*");
    expect(await out("code2str s 65\nsend s")).toBe("A");
    expect(await out("str2code n 'A'\nsend n")).toBe("A");
  });

  it("str2int が数値でなければ、result を 0 にする（成功は 1）", async () => {
    expect(await out("str2int n '12'\nsend result")).toBe("\u0001");
    expect(await out("str2int n 'x'\nsend result")).toBe("\u0000");
  });

  it("strspecial: \\n や \\xHH を文字にする", async () => {
    expect(await out("s = 'a\\x41\\n'\nstrspecial s\nsend s")).toBe("aA\n");
  });

  it("sprintf（%d %s %x %c %% と幅・0 埋め）。結果は inputstr に入る", async () => {
    expect(
      await out("sprintf '%d-%s-%02d-%x' 5 'ab' 7 255\nsend inputstr"),
    ).toBe("5-ab-07-ff");
    expect(await out("sprintf '%c%%' 65\nsend inputstr")).toBe("A%");
    expect(await out("sprintf '%5d|%-5d|' 42 42\nsend inputstr")).toBe(
      "   42|42   |",
    );
  });

  it("getdate / gettime（書式つき）", async () => {
    expect(await out("getdate s\nsend s")).toBe("2024-01-02");
    expect(await out("gettime s\nsend s")).toBe("03:04:05");
    expect(await out("getdate s '%Y/%m/%d'\nsend s")).toBe("2024/01/02");
    expect(await out("gettime s '%H%M'\nsend s")).toBe("0304");
  });

  it("random", async () => {
    expect(await out("random n 10\nsend n")).toBe("\u0003");
  });

  it("引数の型が違うとエラー（命令名・行番号つき）", async () => {
    const { result } = await run("strlen 5");
    expect(result).toMatchObject({ status: "error", line: 1 });
    expect((result as { message: string }).message).toContain("strlen");
  });
});

describe("TtlRunner: 受信を待つ", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const flush = () => vi.advanceTimersByTimeAsync(0);

  it("wait: 出力にその文字列が出るまで待ち、見つかったら続きを実行する。result は一致した番号", async () => {
    const { runner, f } = make(
      "wait 'login:' 'Password:'\nsend result\nsendln 'admin'",
    );
    const done = runner.run();
    await flush();
    expect(f.sent).toEqual([]);
    runner.feed("Welcome\nPassw");
    await flush();
    expect(f.sent).toEqual([]);
    runner.feed("ord: ");
    await flush();
    await done;
    expect(f.sent.join("")).toBe("\u0002admin\r");
  });

  it("wait: すでに受信済み（待つ前に届いていた）の出力でも一致する", async () => {
    const { runner, f } = make("pause 1\nwait 'ready'\nsend 'ok'");
    runner.feed("system ready\n");
    const done = runner.run();
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(f.sent.join("")).toBe("ok");
  });

  it("wait: 一致した所までを捨て、次の wait は、それ以降の出力から探す", async () => {
    const { runner, f } = make("wait 'a'\nwait 'a'\nsend 'done'");
    runner.feed("a");
    const done = runner.run();
    await flush();
    expect(f.sent).toEqual([]);
    runner.feed("..a");
    await flush();
    await done;
    expect(f.sent.join("")).toBe("done");
  });

  it("wait: timeout（秒）を超えたら result を 0 にして続ける。0 なら無期限", async () => {
    const { runner, f } = make("timeout = 5\nwait 'x'\nsend result");
    const done = runner.run();
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    await done;
    expect(f.sent.join("")).toBe("\u0000");
  });

  it("画面制御用の文字（エスケープシーケンス・CR）は取り除いて照合する", async () => {
    const { runner, f } = make("wait 'login:'\nsend 'ok'");
    const done = runner.run();
    runner.feed("\u001b[1mlog\u001b[0min:\r");
    await flush();
    await done;
    expect(f.sent.join("")).toBe("ok");
  });

  it("waitln: 1行の中で照合する（行をまたがない）", async () => {
    const { runner, f } = make("timeout = 1\nwaitln 'ab'\nsend result");
    const done = runner.run();
    runner.feed("a\nb\n");
    await flush();
    await vi.advanceTimersByTimeAsync(1100);
    await done;
    expect(f.sent.join("")).toBe("\u0000");
    const second = make("waitln 'ab'\nsend result");
    const done2 = second.runner.run();
    second.runner.feed("xx ab yy\n");
    await flush();
    await done2;
    expect(second.f.sent.join("")).toBe("\u0001");
  });

  it("waitregex: 正規表現で待つ。matchstr と groupmatchstr1.. に結果が入る", async () => {
    const { runner, f } = make(
      "waitregex '([a-z]+)@([a-z]+)'\nsend matchstr\nsend ' '\nsend groupmatchstr1\nsend ' '\nsend groupmatchstr2\nsend result",
    );
    const done = runner.run();
    runner.feed("mail: bob@example ok");
    await flush();
    await done;
    expect(f.sent.join("")).toBe("bob@example bob example\u0001");
  });

  it("waitregex が時間切れなら result は 0", async () => {
    const { runner, f } = make("timeout = 1\nwaitregex 'zzz'\nsend result");
    const done = runner.run();
    await vi.advanceTimersByTimeAsync(1100);
    await done;
    expect(f.sent.join("")).toBe("\u0000");
  });

  it("不正な正規表現はエラー", async () => {
    const { runner } = make("waitregex '(('");
    const result = await runner.run();
    expect(result).toMatchObject({ status: "error", line: 1 });
  });

  it("recvln: 次の1行を inputstr に入れる（改行は含めない）", async () => {
    const { runner, f } = make("recvln\nsend inputstr\nsend result");
    runner.feed("hello\nworld\n");
    const done = runner.run();
    await flush();
    await done;
    expect(f.sent.join("")).toBe("hello\u0001");
  });

  it("flushrecv: 受信済みの出力を捨てる", async () => {
    const { runner, f } = make(
      "flushrecv\ntimeout = 1\nwait 'old'\nsend result",
    );
    runner.feed("old data");
    const done = runner.run();
    await vi.advanceTimersByTimeAsync(1100);
    await done;
    expect(f.sent.join("")).toBe("\u0000");
  });

  it("pause（秒）/ mpause（ミリ秒）", async () => {
    const { runner, f } = make("pause 2\nsend 'a'\nmpause 500\nsend 'b'");
    const done = runner.run();
    await vi.advanceTimersByTimeAsync(1999);
    expect(f.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(f.sent.join("")).toBe("a");
    await vi.advanceTimersByTimeAsync(500);
    await done;
    expect(f.sent.join("")).toBe("ab");
  });

  it("受信のバッファは、大きくなりすぎない（古い所から捨てる）", async () => {
    const { runner, f } = make("wait 'END'\nsend 'ok'");
    const done = runner.run();
    for (let i = 0; i < 40; i++) runner.feed("x".repeat(10_000));
    runner.feed("END");
    await flush();
    await done;
    expect(f.sent.join("")).toBe("ok");
  });
});

describe("TtlRunner: ダイアログ・接続", () => {
  it("messagebox / yesnobox（result は 1 = はい / 0 = いいえ）", async () => {
    const f = fake();
    f.yesno = [true, false];
    await run(
      "messagebox 'こんにちは' 'タイトル'\nyesnobox 'ok?' 't'\nsend result\nyesnobox 'ok?' 't'\nsend result",
      f,
    );
    expect(f.messages).toEqual([{ message: "こんにちは", title: "タイトル" }]);
    expect(f.sent.join("")).toBe("\u0001\u0000");
  });

  it("inputbox / passwordbox: 入力は inputstr。キャンセルなら空", async () => {
    const f = fake();
    f.inputs = ["alice", null];
    f.passwords = ["s3cret"];
    await run(
      "inputbox 'name?' 'ログイン' 'bob'\nsend inputstr\ninputbox 'x' 'y'\nstrlen inputstr\nsend result\npasswordbox 'pw' 't'\nsend inputstr",
      f,
    );
    expect(f.inputPrompts[0]).toEqual({
      message: "name?",
      title: "ログイン",
      def: "bob",
    });
    expect(f.sent.join("")).toBe("alice\u0000s3cret");
  });

  it("sendbreak / dispstr / testlink / disconnect", async () => {
    const f = fake();
    await run(
      "sendbreak\ndispstr 'a' 'b'\ntestlink\nsend result\ndisconnect\nclosett",
      f,
    );
    expect(f.breaks).toBe(1);
    expect(f.displayed.join("")).toBe("ab");
    expect(f.sent.join("")).toBe("\u0002");
    expect(f.disconnected).toBe(2);
    const g = fake();
    g.connected = false;
    await run("testlink\nsend result", g);
    expect(g.sent.join("")).toBe("\u0000");
  });

  it("画面操作の命令（bringupbox など）は読み飛ばす", async () => {
    const { result, f } = await run(
      "bringupbox\nshowtt 1\nsetdlgpos 1 2\nsetsync 1\nsetexitcode 3\nsend 'a'",
    );
    expect(result.status).toBe("done");
    expect(f.sent.join("")).toBe("a");
  });
});

describe("TtlRunner: 停止・上限・エラー", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stop(): 待ちの途中でも止まる（stopped）", async () => {
    const { runner, f } = make("wait 'never'\nsend 'x'");
    const done = runner.run();
    await vi.advanceTimersByTimeAsync(10);
    runner.stop();
    expect(await done).toEqual({ status: "stopped" });
    expect(f.sent).toEqual([]);
  });

  it("stop(): pause の途中でも、ダイアログの待ちでも止まる", async () => {
    const a = make("pause 100\nsend 'x'");
    const doneA = a.runner.run();
    await vi.advanceTimersByTimeAsync(10);
    a.runner.stop();
    expect(await doneA).toEqual({ status: "stopped" });

    const f = fake({ messagebox: () => new Promise(() => {}) });
    const b = make("messagebox 'm' 't'\nsend 'x'", f);
    const doneB = b.runner.run();
    await vi.advanceTimersByTimeAsync(10);
    b.runner.stop();
    expect(await doneB).toEqual({ status: "stopped" });
    expect(f.sent).toEqual([]);
  });

  it("無限ループも、stop() で止められる（実行を明け渡しながら進む）", async () => {
    // 実際の時間で動かす（偽の時計だと、明け渡しの待ちが終わらない）。
    vi.useRealTimers();
    const { runner } = make("while 1\nn = 0\nendwhile");
    const done = runner.run();
    setTimeout(() => runner.stop(), 30);
    expect(await done).toEqual({ status: "stopped" });
  });

  it("実行する命令の数に上限がある（暴走を止める）", async () => {
    const { runner } = make("while 1\nn = 0\nendwhile");
    const done = runner.run({ maxSteps: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await done;
    expect(result).toMatchObject({ status: "error" });
    expect((result as { message: string }).message).toContain("上限");
  });

  it("実行時のエラーは、行番号とメッセージを返す", async () => {
    const { runner } = make("a = 1\nb = a / 0");
    expect(await runner.run()).toMatchObject({ status: "error", line: 2 });
  });

  it("実行中に、いまの行番号を知らせる（画面の表示用）", async () => {
    const lines: number[] = [];
    const { runner } = make("send 'a'\nsend 'b'\nsend 'c'");
    await runner.run({ onLine: (n) => lines.push(n) });
    expect(lines).toEqual([1, 2, 3]);
  });

  it("run() は2回目を呼べない", async () => {
    const { runner } = make("send 'a'");
    await runner.run();
    await expect(runner.run()).rejects.toThrow();
  });
});

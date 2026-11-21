import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fake, make, run } from "./test-support";

const out = async (src: string) => (await run(src)).f.sent.join("");
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("受信を待つ命令（Tera Term の仕様）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("wait: 空の文字列は、どの1文字にも一致する", async () => {
    const { runner, f } = make("wait ''\nsend result\nsend 'ok'");
    const done = runner.run();
    await flush();
    expect(f.sent).toEqual([]);
    runner.feed("x");
    await flush();
    await done;
    expect(f.sent.join("")).toBe("\u0001ok");
  });

  it("waitln: 複数の文字列のどれか。番号が result、行が inputstr", async () => {
    const { runner, f } = make(
      "waitln 'AAA' 'BBB'\nsend result\nsend inputstr",
    );
    const done = runner.run();
    runner.feed("hello\nxx BBB yy\n");
    await flush();
    await done;
    expect(f.sent.join("")).toBe("\u0002xx BBB yy");
  });

  it("waitln: 改行までそろっていない行には、一致しない", async () => {
    const { runner, f } = make("timeout = 1\nwaitln 'login'\nsend result");
    const done = runner.run();
    runner.feed("login: ");
    await vi.advanceTimersByTimeAsync(1100);
    await done;
    expect(f.sent.join("")).toBe("\u0000");
  });

  it("waitregex: 複数の正規表現（番号が result）。1行ずつ照合し、行が inputstr に入る", async () => {
    const { runner, f } = make(
      "waitregex 'zzz' 'id=([0-9]+)'\nsend result\nsend groupmatchstr1\nsend inputstr",
    );
    const done = runner.run();
    runner.feed("nothing\nuser id=42 ok\n");
    await flush();
    await done;
    expect(f.sent.join("")).toBe("\u000242user id=42 ok");
  });

  it("waitn: 指定した文字数がそろうまで待つ。inputstr に先頭の511文字まで入る", async () => {
    const { runner, f } = make("waitn 5\nsend result\nsend inputstr");
    const done = runner.run();
    runner.feed("ab");
    await flush();
    expect(f.sent).toEqual([]);
    runner.feed("cdef");
    await flush();
    await done;
    expect(f.sent.join("")).toBe("\u0001abcdef");
  });

  it("waitn: 時間切れなら result は 0", async () => {
    const { runner, f } = make("timeout = 1\nwaitn 10\nsend result");
    const done = runner.run();
    runner.feed("abc");
    await vi.advanceTimersByTimeAsync(1100);
    await done;
    expect(f.sent.join("")).toBe("\u0000");
  });

  it("waitrecv: len 文字の塊の pos（1から）に、その文字列があれば一致。塊を inputstr に入れる", async () => {
    const { runner, f } = make(
      "waitrecv 'def' 9 4\nsend result\nsend inputstr",
    );
    const done = runner.run();
    runner.feed("abcdefghi");
    await flush();
    await done;
    expect(f.sent.join("")).toBe("\u0001abcdefghi");
  });

  it("waitrecv: 位置が合わない塊は、捨てて、次の塊を調べる", async () => {
    const { runner, f } = make(
      "waitrecv 'def' 9 4\nsend result\nsend inputstr",
    );
    const done = runner.run();
    runner.feed("abcxxxghi");
    await flush();
    expect(f.sent).toEqual([]);
    runner.feed("123def789");
    await flush();
    await done;
    expect(f.sent.join("")).toBe("\u0001123def789");
  });

  it("waitrecv: 時間切れのとき、足りない塊の中に一致があれば result は -1（塊を inputstr に）、なければ 0", async () => {
    const a = make(
      "timeout = 1\nwaitrecv 'def' 9 4\nsprintf2 r '%d' result\nsend r\nsend '|'\nsend inputstr",
    );
    const doneA = a.runner.run();
    a.runner.feed("abcdefgh");
    await vi.advanceTimersByTimeAsync(1100);
    await doneA;
    expect(a.f.sent.join("")).toBe("-1|abcdefgh");

    const b = make("timeout = 1\nwaitrecv 'def' 9 4\nsend result");
    const doneB = b.runner.run();
    b.runner.feed("abcxxxgh");
    await vi.advanceTimersByTimeAsync(1100);
    await doneB;
    expect(b.f.sent.join("")).toBe("\u0000");
  });

  it("wait4all: このペインの出力を、wait と同じように待つ", async () => {
    const { runner, f } = make("wait4all 'a' 'b'\nsend result");
    const done = runner.run();
    runner.feed("b");
    await flush();
    await done;
    expect(f.sent.join("")).toBe("\u0002");
  });
});

describe("文字列の命令（Tera Term の仕様）", () => {
  it("strsplit: 1文字の区切りで groupmatchstr1〜9 に分け、個数を result に入れる", async () => {
    expect(
      await out(
        "strsplit 'a,b,c' ','\nsend result groupmatchstr1 groupmatchstr2 groupmatchstr3 groupmatchstr4",
      ),
    ).toBe("\u0003abc");
  });

  it("strsplit: 個数を指定すると、残りは最後の groupmatchstr にまとめる。余った groupmatchstr は空", async () => {
    expect(
      await out(
        "strsplit 'a,b,c,d' ',' 2\nsend result groupmatchstr1 '|' groupmatchstr2 '|' groupmatchstr3",
      ),
    ).toBe("\u0002a|b,c,d|");
  });

  it("strsplit: 個数を指定しないで10個以上に分かれると、groupmatchstr9 だけが値を持ち、result は 10", async () => {
    expect(
      await out(
        "strsplit 'a,b,c,d,e,f,g,h,i,j,k' ','\nsend result groupmatchstr1 groupmatchstr9",
      ),
    ).toBe("\u000aai");
  });

  it("strsplit: 区切りが1文字でなければエラー。個数は 9 まで", async () => {
    expect((await run("strsplit 'a,b' ',,'")).result.status).toBe("error");
    expect((await run("strsplit 'a,b' ''")).result.status).toBe("error");
    expect((await run("strsplit 'a,b' ',' 10")).result.status).toBe("error");
  });

  it("strjoin: groupmatchstr1〜（個数）を区切りでつないで、文字列変数に入れる", async () => {
    expect(
      await out(
        "groupmatchstr1 = 'x'\ngroupmatchstr2 = 'y'\ngroupmatchstr3 = 'z'\nstrjoin s '-' 3\nsend s",
      ),
    ).toBe("x-y-z");
    expect(await out("strsplit 'a b c' ' '\nstrjoin s '+'\nsend s")).toBe(
      "a+b+c",
    );
  });

  it("strreplace: result（1 = 置換、0 = 一致なし）と matchstr。groupmatchstr は消える", async () => {
    expect(
      await out(
        "groupmatchstr1 = 'old'\ns = 'a1b22c'\nstrreplace s 1 '[0-9]+' '#'\nsend s result matchstr groupmatchstr1",
      ),
    ).toBe("a#b22c\u00011");
    expect(
      await out("s = 'abc'\nstrreplace s 1 'zzz' '#'\nsend s result"),
    ).toBe("abc\u0000");
  });

  it("strreplace: 正規表現が不正なら result は -1（エラーにしない）", async () => {
    expect(
      await out("s = 'abc'\nstrreplace s 1 '((' '#'\nsend result + 50"),
    ).toBe("1");
  });

  it("strmatch: matchstr と groupmatchstr1〜9 に入れる。一致しなければ、それまでの値を保つ", async () => {
    expect(
      await out(
        "strmatch 'id=42;name=bob' '([a-z]+)=([0-9]+)'\nsend result matchstr groupmatchstr1 groupmatchstr2",
      ),
    ).toBe("\u0001id=42id42");
    expect(
      await out(
        "matchstr = 'old'\nstrmatch 'abc' '[0-9]'\nsend result matchstr",
      ),
    ).toBe("\u0000old");
  });

  it("str2int: 10進・0x・$ の16進を読む。先頭の数字だけでもよい。読めなければ result は 0", async () => {
    expect(await out("str2int n '123'\nsend n")).toBe("{");
    expect(await out("str2int n '0x7b'\nsend n")).toBe("{");
    expect(await out("str2int n '$7b'\nsend n")).toBe("{");
    expect(await out("str2int n '123abc'\nsend n result")).toBe("{\u0001");
    expect(await out("str2int n 'abc'\nsend result")).toBe("\u0000");
    expect(await out("str2int n '-5'\nsend n + 10")).toBe("\u0005");
  });

  it("strspecial: \\\\ \\n \\t を文字にする。2つ目の引数があれば、その結果を変数に入れる", async () => {
    expect(await out("s = 'a\\nb\\tc\\\\d'\nstrspecial s\nsend s")).toBe(
      "a\nb\tc\\d",
    );
    expect(await out("strspecial s 'x\\ny'\nsend s")).toBe("x\ny");
  });

  it("sprintf2: 書式で作った文字列を、指定した変数に入れる。result は 0（成功）", async () => {
    expect(await out("sprintf2 s '%d-%s-%02X' 5 'ab' 255\nsend s result")).toBe(
      "5-ab-FF\u0000",
    );
  });

  it("sprintf2: 書式が足りない・引数が合わない・書式がないときの result", async () => {
    expect(await out("sprintf2 s 'plain'\nsend result")).toBe("\u0001");
    expect(await out("sprintf2 s '%d' 'x'\nsend result")).toBe("\u0003");
    expect(await out("sprintf2 s '%d %d' 1\nsend result")).toBe("\u0003");
  });

  it("sprintf2: o u e 系以外の指定子（%o %u %c %i %+d %#x）と精度", async () => {
    expect(
      await out("sprintf2 s '%o %u %c %i %+d %#x' 8 7 65 3 4 255\nsend s"),
    ).toBe("10 7 A 3 +4 0xff");
    expect(await out("sprintf2 s '%.3s|%5.2s|' 'abcdef' 'xyz'\nsend s")).toBe(
      "abc|   xy|",
    );
  });

  it("getdate / gettime: 書式を指定したら result は 0。書式が不正なら 2。時間帯は受け取る", async () => {
    expect(await out("getdate s '%Y/%m/%d'\nsend s result")).toBe(
      "2024/01/02\u0000",
    );
    const utc = fake({ now: () => new Date(Date.UTC(2024, 0, 2, 3, 4, 5)) });
    await run(
      "gettime s '%H:%M' 'UTC'\ngettime t '%H:%M' 'Asia/Tokyo'\nsend s '|' t result",
      utc,
    );
    expect(utc.sent.join("")).toBe("03:04|12:04\u0000");
    expect(await out("getdate s '%'\nsend result")).toBe("\u0002");
  });

  it("random: 0 以上 max 以下（max を含む）", async () => {
    const f = fake();
    f.host.random = (n) => n - 1;
    await run("random n 10\nsend n + 48", f);
    expect(f.sent.join("")).toBe(":");
  });
});

describe("チェックサム・CRC・ビット回転", () => {
  it("checksum8 / checksum16 / checksum32: 文字のコードの合計（桁で切る）", async () => {
    expect(await out("checksum8 n 'abc'\nsend n")).toBe("&");
    expect(await out("checksum16 n 'abc'\nsend n")).toBe("Ħ");
    expect(await out("checksum32 n 'abc'\nsend n")).toBe("Ħ");
  });

  it("crc32（標準）と crc16（CCITT・反転）", async () => {
    expect(await out("crc32 n '123456789'\nsprintf2 s '%X' n\nsend s")).toBe(
      "CBF43926",
    );
    expect(await out("crc16 n '123456789'\nsprintf2 s '%X' n\nsend s")).toBe(
      "906E",
    );
  });

  it("rotateleft / rotateright（32ビットの回転）", async () => {
    expect(await out("rotateleft n $80000000 4\nsend n")).toBe("\u0008");
    expect(await out("rotateright n 8 4\nsprintf2 s '%X' n\nsend s")).toBe(
      "80000000",
    );
    expect(await out("rotateleft n 1 32\nsend n")).toBe("\u0001");
  });
});

describe("そのほかの命令", () => {
  it("getver / ifdefined / uptime / gethostname", async () => {
    const f = fake();
    await run(
      "getver v\nsend v\nx = 1\nifdefined x\nsend result + 48\nifdefined nope\nsend result + 48\nuptime t\nsend t\ngethostname h\nsend h",
      f,
    );
    expect(f.sent.join("")).toBe("4.108" + "1" + "0" + "〹" + "example.com");
  });

  it("ifdefined: 整数 1・文字列 3・ラベル 4・整数配列 5・文字列配列 6", async () => {
    expect(
      await out(
        ":lbl\nn = 1\ns = 'a'\nintdim ia 1\nstrdim sa 1\nifdefined n\nsend result\nifdefined s\nsend result\nifdefined lbl\nsend result\nifdefined ia\nsend result\nifdefined sa\nsend result",
      ),
    ).toBe("\u0001\u0003\u0004\u0005\u0006");
  });

  it("getver: バージョンを渡すと、result に比較（-1 古い、0 同じ、1 新しい）", async () => {
    expect(await out("getver v '4.108'\nsend result + 50")).toBe("2");
    expect(await out("getver v '4.50'\nsend result + 50")).toBe("3");
    expect(await out("getver v '9.99'\nsend result + 50")).toBe("1");
  });

  it("setecho / setdtr / setrts / enablekeyb / clearscreen / settitle / gettitle / beep / statusbox / closesbox / sendbroadcast", async () => {
    const f = fake();
    await run(
      [
        "setecho 1",
        "setecho 0",
        "setdtr 0",
        "setrts 1",
        "enablekeyb 0",
        "enablekeyb 1",
        "clearscreen 0",
        "clearscreen 1",
        "settitle 'new'",
        "gettitle t",
        "send t",
        "beep",
        "beep 2",
        "show 1",
        "statusbox '処理中' '状態'",
        "closesbox",
        "sendbroadcast 'a' 13",
        "sendlnbroadcast 'b'",
      ].join("\n"),
      f,
    );
    expect(f.echo).toEqual([true, false]);
    expect(f.signals).toEqual([
      { signal: "dtr", on: false },
      { signal: "rts", on: true },
    ]);
    expect(f.keyboard).toEqual([false, true]);
    expect(f.cleared).toEqual([0, 1]);
    expect(f.title).toBe("new");
    expect(f.sent.join("")).toBe("new");
    expect(f.beeps).toEqual([5, 2]);
    expect(f.statuses).toEqual([{ message: "処理中", title: "状態" }]);
    expect(f.statusClosed).toBe(1);
    expect(f.broadcasts).toEqual(["a\r", "b\r"]);
  });

  it("messagebox などの special（3つ目の引数）が 0 以外なら、メッセージの \\n \\t を文字にする", async () => {
    const f = fake();
    await run("messagebox 'a\\nb' 't' 1\nmessagebox 'c\\nd' 't'", f);
    expect(f.messages.map((m) => m.message)).toEqual(["a\nb", "c\\nd"]);
  });

  it("inputbox の4つ目の引数（special）を受け取る", async () => {
    const f = fake();
    f.inputs = ["x"];
    await run("inputbox 'm\\nn' 't' 'def' 1", f);
    expect(f.inputPrompts[0]).toEqual({
      message: "m\nn",
      title: "t",
      def: "def",
    });
  });

  it("regexoption: IGNORECASE などが、strmatch・strreplace・waitregex に効く", async () => {
    expect(await out("strmatch 'ABC' 'abc'\nsend result")).toBe("\u0000");
    expect(
      await out("regexoption 'IGNORECASE'\nstrmatch 'ABC' 'abc'\nsend result"),
    ).toBe("\u0001");
    expect(
      await out("regexoption 'ASIS'\nstrmatch 'a.c' 'a.c'\nsend result"),
    ).toBe("\u0001");
    expect(
      await out("regexoption 'ASIS'\nstrmatch 'abc' 'a.c'\nsend result"),
    ).toBe("\u0000");
  });

  it("regexoption: 知らない指定はエラー", async () => {
    expect((await run("regexoption 'NO_SUCH_OPTION'")).result.status).toBe(
      "error",
    );
  });

  it("setdtr / setrts / enablekeyb などの引数は整数", async () => {
    expect((await run("setdtr 'x'")).result.status).toBe("error");
  });

  it("clearscreen: 0〜2 以外はエラー", async () => {
    expect((await run("clearscreen 3")).result.status).toBe("error");
  });
});

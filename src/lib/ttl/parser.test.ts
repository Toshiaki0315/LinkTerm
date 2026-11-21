import { describe, expect, it } from "vitest";
import { parseProgram, type Program } from "./parser";

const ok = (src: string): Program => {
  const r = parseProgram(src);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.program;
};
const errors = (src: string) => {
  const r = parseProgram(src);
  if (r.ok) throw new Error("エラーになるはず");
  return r.errors;
};
const kinds = (p: Program) => p.stmts.map((s) => s.k);

describe("parseProgram: 文の種類", () => {
  it("空行・コメントだけの行は文にしない。行番号は元のまま", () => {
    const p = ok("; はじめ\n\nsend 'a'\n   \n; おわり\nsendln 'b' ; 注\n");
    expect(kinds(p)).toEqual(["cmd", "cmd"]);
    expect(p.stmts.map((s) => s.line)).toEqual([3, 6]);
  });

  it("代入（= と += -= *= /= %=）", () => {
    const p = ok("a = 1\nB += 2\nc -= 3\nd *= 4\ne /= 5\nf %= 6");
    expect(kinds(p)).toEqual(Array(6).fill("assign"));
    expect(p.stmts.map((s) => (s.k === "assign" ? s.name : ""))).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
    expect(p.stmts.map((s) => (s.k === "assign" ? s.op : ""))).toEqual([
      "=",
      "+=",
      "-=",
      "*=",
      "/=",
      "%=",
    ]);
  });

  it("システム変数への代入もできる（timeout = 10）", () => {
    expect(kinds(ok("timeout = 10"))).toEqual(["assign"]);
  });

  it("コマンド名は大文字小文字を区別しない", () => {
    const p = ok("SendLn 'x'");
    expect(p.stmts[0]).toMatchObject({ k: "cmd", name: "sendln" });
  });

  it("引数は、空白で区切った式。演算子が続けば1つの式", () => {
    const p = ok("send 'a' 13 b + 1");
    const s = p.stmts[0];
    expect(s.k === "cmd" && s.args.length).toBe(3);
  });

  it("変数名を取る引数（出力先）は、式ではなく名前", () => {
    const p = ok("strconcat s 'x'");
    const s = p.stmts[0];
    expect(s.k === "cmd" && s.args[0]).toEqual({ k: "name", name: "s" });
  });
});

describe("parseProgram: 制御構造", () => {
  it("if / elseif / else / endif の飛び先が決まる", () => {
    const p = ok(
      [
        "a = 1",
        "if a = 1 then",
        "send 'one'",
        "elseif a = 2 then",
        "send 'two'",
        "else",
        "send 'other'",
        "endif",
        "end",
      ].join("\n"),
    );
    expect(kinds(p)).toEqual([
      "assign",
      "if",
      "cmd",
      "elseif",
      "cmd",
      "else",
      "cmd",
      "endif",
      "cmd",
    ]);
    const [, iff, , elseif, , els] = p.stmts;
    expect(iff).toMatchObject({ elseTo: 3, endTo: 7 });
    expect(elseif).toMatchObject({ elseTo: 5, endTo: 7 });
    expect(els).toMatchObject({ endTo: 7 });
  });

  it("else のない if は、偽のとき endif へ飛ぶ", () => {
    const p = ok("if 1 then\nsend 'a'\nendif");
    expect(p.stmts[0]).toMatchObject({ k: "if", elseTo: 2, endTo: 2 });
  });

  it("1行の if（then のあとにコマンド）は、endif を要らない", () => {
    const p = ok("if 1 then send 'a'\nsend 'b'");
    expect(kinds(p)).toEqual(["inlineIf", "cmd"]);
    const s = p.stmts[0];
    expect(s.k === "inlineIf" && s.then).toMatchObject({
      k: "cmd",
      name: "send",
    });
  });

  it("1行の if に、代入・goto・break なども書ける", () => {
    expect(() => ok("a = 0\nif 1 then a = 5")).not.toThrow();
    expect(() => ok(":x\nif 1 then goto x")).not.toThrow();
    expect(() => ok("while 1\nif 1 then break\nendwhile")).not.toThrow();
  });

  it("while / until / do-loop / for の対応が決まる", () => {
    const p = ok(
      [
        "while 1",
        "endwhile",
        "until 0",
        "enduntil",
        "do",
        "loop",
        "do while 1",
        "loop until 1",
        "for i 1 3",
        "next",
      ].join("\n"),
    );
    expect(p.stmts[0]).toMatchObject({ k: "while", endTo: 1 });
    expect(p.stmts[1]).toMatchObject({ k: "endwhile", startTo: 0 });
    expect(p.stmts[2]).toMatchObject({ k: "until", endTo: 3 });
    expect(p.stmts[4]).toMatchObject({ k: "do", endTo: 5, test: null });
    expect(p.stmts[5]).toMatchObject({ k: "loop", startTo: 4, test: null });
    expect(p.stmts[6]).toMatchObject({ k: "do", endTo: 7 });
    expect(p.stmts[6].k === "do" && p.stmts[6].test?.kind).toBe("while");
    expect(p.stmts[7].k === "loop" && p.stmts[7].test?.kind).toBe("until");
    expect(p.stmts[8]).toMatchObject({ k: "for", endTo: 9, varName: "i" });
    expect(p.stmts[9]).toMatchObject({ k: "next", startTo: 8 });
  });

  it("break / continue は、いちばん内側のループを指す", () => {
    const p = ok(
      ["while 1", "for i 1 2", "break", "next", "continue", "endwhile"].join(
        "\n",
      ),
    );
    expect(p.stmts[2]).toMatchObject({ k: "break", loopIdx: 1 });
    expect(p.stmts[4]).toMatchObject({ k: "continue", loopIdx: 0 });
  });

  it("ラベルと goto / call / return", () => {
    const p = ok([":top", "call sub", "goto top", ":sub", "return"].join("\n"));
    expect(p.labels.get("top")).toBe(0);
    expect(p.labels.get("sub")).toBe(3);
    expect(p.stmts.map((s) => (s.k === "cmd" ? s.name : s.k))).toEqual([
      "label",
      "call",
      "goto",
      "label",
      "return",
    ]);
  });

  it("ラベルは大文字小文字を区別しない", () => {
    const p = ok(":Top\ngoto TOP");
    expect(p.labels.get("top")).toBe(0);
  });
});

describe("parseProgram: エラー", () => {
  it("対応しない end 系・閉じていないブロックはエラー（行番号つき）", () => {
    expect(errors("endif")[0]).toMatchObject({ line: 1 });
    expect(errors("endwhile")[0].message).toContain("while");
    expect(errors("next")[0].message).toContain("for");
    expect(errors("loop")[0].message).toContain("do");
    expect(errors("if 1 then\nsend 'a'")[0]).toMatchObject({ line: 1 });
    expect(errors("while 1")[0].message).toContain("endwhile");
    expect(errors("for i 1 2")[0].message).toContain("next");
  });

  it("endwhile と enduntil など、種類が違う終わりはエラー", () => {
    expect(errors("while 1\nenduntil").length).toBeGreaterThan(0);
    expect(errors("until 1\nendwhile").length).toBeGreaterThan(0);
  });

  it("else が2つ・else のあとの elseif はエラー", () => {
    expect(errors("if 1 then\nelse\nelse\nendif").length).toBeGreaterThan(0);
    expect(
      errors("if 1 then\nelse\nelseif 1 then\nendif").length,
    ).toBeGreaterThan(0);
  });

  it("ループの外の break / continue はエラー", () => {
    expect(errors("break")[0].message).toContain("ループ");
    expect(errors("continue")[0].message).toContain("ループ");
  });

  it("then のない if・式のない while はエラー", () => {
    expect(errors("if 1\nendif")[0].message).toContain("then");
    expect(errors("while")[0].message).toContain("式");
  });

  it("goto / call の先のラベルがない・ラベルが重複するとエラー", () => {
    expect(errors("goto nowhere")[0].message).toContain("nowhere");
    expect(errors("call nowhere")[0].message).toContain("nowhere");
    expect(errors(":a\n:a")[0].message).toContain("重複");
  });

  it("使えない命令（ファイル・外部コマンドなど）は、使えないと伝える", () => {
    for (const name of [
      "exec 'ls'",
      "include 'a.ttl'",
      "fileopen f 'x' 0",
      "connect 'x'",
      "getenv 'HOME' v",
      "logopen 'a' 0 0",
    ]) {
      expect(errors(name)[0].message).toContain("このアプリでは使えません");
    }
  });

  it("知らない命令は、未対応と伝える（命令名つき）", () => {
    expect(errors("frobnicate 1")[0].message).toContain("frobnicate");
  });

  it("引数の数が合わなければエラー", () => {
    expect(errors("pause")[0].message).toContain("引数");
    expect(errors("pause 1 2")[0].message).toContain("引数");
    expect(errors("strlen")[0].message).toContain("引数");
    expect(errors("wait")[0].message).toContain("引数");
  });

  it("変数名の引数に式を書くとエラー", () => {
    expect(errors("strconcat 'a' 'b'")[0].message).toContain("変数");
    expect(errors("inc 5")[0].message).toContain("変数");
  });

  it("文法のエラー（字句・式）も行番号つきで返す。複数あればすべて返す", () => {
    const e = errors("send 'abc\na = @\nsend (1");
    expect(e.map((x) => x.line)).toEqual([1, 2, 3]);
  });

  it("スクリプトが大きすぎるとエラー", () => {
    const r = parseProgram("send 'a'\n".repeat(30_000));
    expect(r.ok).toBe(false);
  });
});

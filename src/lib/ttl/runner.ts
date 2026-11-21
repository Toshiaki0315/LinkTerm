import { stripTerminalControls } from "../auto-login";
import { TtlError } from "./errors";
import { evalExpr, type Env, type Value } from "./expr";
import type { Arg, Program, Stmt } from "./parser";
import {
  checksum,
  crc16,
  crc32,
  printf,
  rotate32,
  sprintf,
  strftime,
  strspecial,
} from "./strings";

/** マクロが外の世界（端末・画面・接続）とやり取りするための口。 */
export interface TtlHost {
  /** 端末へ送る（Enter を含む）。 */
  send(data: string): void | Promise<void>;
  sendBreak(): Promise<void>;
  /** 画面（端末の表示）に文字を出す（接続先へは送らない）。 */
  display(text: string): void;
  messagebox(message: string, title: string): Promise<void>;
  yesnobox(message: string, title: string): Promise<boolean>;
  /** キャンセルなら `null`。 */
  inputbox(
    message: string,
    title: string,
    initial: string,
  ): Promise<string | null>;
  passwordbox(message: string, title: string): Promise<string | null>;
  /** 一覧から選ぶ。選んだ番号（0 から）。キャンセルなら `null`。 */
  listbox(
    message: string,
    title: string,
    items: string[],
    selected: number,
  ): Promise<number | null>;
  disconnect(): void;
  isConnected(): boolean;
  /** ローカルエコーの入り切り。 */
  setEcho(on: boolean): void;
  /** シリアルの制御信号（DTR / RTS）。シリアル以外は例外にする。 */
  setSignal(signal: "dtr" | "rts", on: boolean): Promise<void>;
  /** ユーザーのキー入力を受け付けるか（マクロの実行中だけ止める用）。 */
  setKeyboardEnabled(enabled: boolean): void;
  /** 画面を消す（0: 画面、1: 画面とスクロールバック）。 */
  clearScreen(kind: 0 | 1): void;
  setTitle(title: string): void;
  getTitle(): string;
  beep(kind: number): void;
  /** 実行中の状態の表示（閉じるまで出し続ける）。 */
  showStatus(message: string, title: string): void;
  closeStatus(): void;
  /** 接続先のホスト名（なければ空）。 */
  hostName(): string;
  /** 起動からの時間（ミリ秒）。 */
  uptimeMs(): number;
  /** すべてのペインへ送る。 */
  broadcast(data: string): void;
  now(): Date;
  /** 0 以上 max 未満の整数。 */
  random(max: number): number;
}

export type RunResult =
  | { status: "done" }
  | { status: "stopped" }
  | { status: "error"; line: number; message: string };

export interface RunOptions {
  /** 実行する命令の数の上限（暴走を止める）。 */
  maxSteps?: number;
  /** 命令を実行するたびに、その行番号を知らせる（画面の表示用）。 */
  onLine?: (line: number) => void;
}

export const DEFAULT_MAX_STEPS = 2_000_000;
/** 受信した文字を貯めておく量の上限。 */
const MAX_BUFFER = 65_536;
/** この数の命令ごとに、ほかの処理（画面・停止の操作）に実行を明け渡す。 */
const YIELD_EVERY = 2_000;
const MAX_REGEX_CHARS = 500;
/** 配列の要素数の上限。 */
const MAX_ARRAY_SIZE = 10_000;
/** `getver` が返す、Tera Term 互換のバージョン。 */
const RUNNING_VERSION = "4.108";
/** `regexoption` が受け付ける指定（動きに効くのは IGNORECASE・MULTILINE・ASIS だけ）。 */
const REGEX_TOKENS = new Set([
  "DEFAULT",
  "RUBY",
  "POSIX_BASIC",
  "POSIX_EXTENDED",
  "EMACS",
  "GREP",
  "GNU_REGEX",
  "JAVA",
  "PERL",
  "PERL_NG",
  "ASCII",
  "UTF8",
  "UTF16_BE",
  "UTF16_LE",
  "UTF32_BE",
  "UTF32_LE",
  "EUC_JP",
  "EUC_TW",
  "EUC_KR",
  "EUC_CN",
  "SJIS",
  "KOI8_R",
  "CP1251",
  "BIG5",
  "GB18030",
  "SINGLELINE",
  "EXTEND",
  "FIND_LONGEST",
  "FIND_NOT_EMPTY",
  "NEGATE_SINGLELINE",
  "DONT_CAPTURE_GROUP",
  "CAPTURE_GROUP",
  "OPTION_NONE",
  "NONE",
]);

/** バージョン（`4.108` のような点区切り）を比べる。a が古ければ -1、同じなら 0、新しければ 1、読めなければ -2。 */
function compareVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  if (pb.some((n) => !Number.isFinite(n))) return -2;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

class StopSignal extends Error {}

const NO_OP_COMMANDS = new Set([
  "bringupbox",
  "showtt",
  "setdlgpos",
  "setsync",
  "setexitcode",
]);

export class TtlRunner {
  private readonly vars = new Map<string, Value>();
  /** `regexoption` で決めた、正規表現の設定。 */
  private regexOptions = { ignoreCase: false, dotAll: false, asis: false };
  /** 配列（intdim / strdim で作る）。添字は 0 から。 */
  private readonly arrays = new Map<
    string,
    { type: "int" | "str"; data: Value[] }
  >();
  private buf = "";
  private started = false;
  private stopped = false;
  private pc = 0;
  private next = 0;
  private enter = false;
  private finished = false;
  private line = 0;
  private callStack: number[] = [];
  private forFrames: Array<{
    pc: number;
    name: string;
    to: number;
    step: number;
  }> = [];
  private onData: (() => void) | null = null;
  private cancelWait: (() => void) | null = null;
  private abortResolve: (() => void) | null = null;
  private readonly aborted = new Promise<void>((resolve) => {
    this.abortResolve = resolve;
  });

  constructor(
    private readonly program: Program,
    private readonly host: TtlHost,
  ) {
    for (const name of ["result", "timeout", "mtimeout"])
      this.vars.set(name, 0);
    for (const name of ["inputstr", "matchstr"]) this.vars.set(name, "");
    for (let i = 1; i <= 9; i++) this.vars.set(`groupmatchstr${i}`, "");
  }

  /** 受け取った出力（端末に表示される文字）を渡す。`wait` などが照合する。 */
  feed(text: string): void {
    this.buf = (this.buf + stripTerminalControls(text)).slice(-MAX_BUFFER);
    this.onData?.();
  }

  /** 止める。待っている途中でも、すぐに止まる。 */
  stop(): void {
    this.stopped = true;
    this.cancelWait?.();
    this.abortResolve?.();
  }

  private readonly env: Env = {
    get: (name) => {
      if (this.arrays.has(name)) {
        throw new TtlError(
          `配列 ${name} には添字が必要です（${name}[0] のように書きます）`,
        );
      }
      const v = this.vars.get(name);
      if (v === undefined) throw new TtlError(`変数 ${name} に値がありません`);
      return v;
    },
    getIndex: (name, index) => this.element(name, index).data[index],
  };

  /** 配列と、範囲を確かめた添字。 */
  private element(
    name: string,
    index: number,
  ): { type: "int" | "str"; data: Value[] } {
    const arr = this.arrays.get(name);
    if (!arr)
      throw new TtlError(
        `配列 ${name} がありません（intdim / strdim で作ります）`,
      );
    if (!Number.isInteger(index) || index < 0 || index >= arr.data.length) {
      throw new TtlError(
        `配列 ${name} の添字が範囲外です: ${index}（0〜${arr.data.length - 1}）`,
      );
    }
    return arr;
  }

  private setElement(name: string, index: number, value: Value): void {
    const arr = this.element(name, index);
    if (typeof value !== (arr.type === "int" ? "number" : "string")) {
      throw new TtlError(
        `配列 ${name} には${arr.type === "int" ? "整数" : "文字列"}だけ入れられます`,
      );
    }
    arr.data[index] = value;
  }

  /** 変数に代入する（配列の名前そのものには代入できない）。 */
  private setVar(name: string, value: Value): void {
    if (this.arrays.has(name)) {
      throw new TtlError(
        `配列 ${name} には代入できません（${name}[0] のように書きます）`,
      );
    }
    this.vars.set(name, value);
  }

  async run(options: RunOptions = {}): Promise<RunResult> {
    if (this.started) throw new Error("マクロは1回しか実行できません");
    this.started = true;
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    const { stmts } = this.program;
    let steps = 0;
    try {
      while (this.pc < stmts.length && !this.finished) {
        if (this.stopped) return { status: "stopped" };
        steps += 1;
        if (steps > maxSteps) {
          throw new TtlError(
            `実行する命令の数が上限（${maxSteps}回）を超えました`,
          );
        }
        if (steps % YIELD_EVERY === 0)
          await new Promise<void>((r) => setTimeout(r, 0));
        if (this.stopped) return { status: "stopped" };
        const stmt = stmts[this.pc];
        this.line = stmt.line;
        options.onLine?.(stmt.line);
        this.next = this.pc + 1;
        await this.exec(stmt);
        this.pc = this.next;
      }
      return this.stopped ? { status: "stopped" } : { status: "done" };
    } catch (e) {
      if (e instanceof StopSignal || this.stopped) return { status: "stopped" };
      if (e instanceof TtlError) {
        return {
          status: "error",
          line: e.line ?? this.line,
          message: e.message,
        };
      }
      return {
        status: "error",
        line: this.line,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // ---- 実行 ----

  private async exec(stmt: Stmt): Promise<void> {
    switch (stmt.k) {
      case "assign":
        this.assign(stmt.name, stmt.op, stmt);
        return;
      case "cmd":
        await this.command(stmt.name, stmt.args);
        return;
      case "label":
      case "endif":
        this.enter = false;
        return;
      case "inlineIf":
        if (this.truth(evalExpr(stmt.cond, this.env), "if"))
          await this.exec(stmt.then);
        return;
      case "if":
        this.enter = false;
        if (!this.truth(evalExpr(stmt.cond, this.env), "if")) {
          this.next = stmt.elseTo;
          this.enter = true;
        }
        return;
      case "elseif":
        if (this.enter) {
          if (this.truth(evalExpr(stmt.cond, this.env), "elseif")) {
            this.enter = false;
          } else {
            this.next = stmt.elseTo;
          }
        } else {
          this.next = stmt.endTo;
        }
        return;
      case "else":
        if (this.enter) this.enter = false;
        else this.next = stmt.endTo;
        return;
      case "while":
        if (!this.truth(evalExpr(stmt.cond, this.env), "while"))
          this.next = stmt.endTo + 1;
        return;
      case "endwhile":
      case "enduntil":
        this.next = stmt.startTo;
        return;
      case "until":
        if (this.truth(evalExpr(stmt.cond, this.env), "until"))
          this.next = stmt.endTo + 1;
        return;
      case "do":
        if (stmt.test) {
          const c = this.truth(evalExpr(stmt.test.cond, this.env), "do");
          if (stmt.test.kind === "while" ? !c : c) this.next = stmt.endTo + 1;
        }
        return;
      case "loop": {
        const start = this.program.stmts[stmt.startTo];
        if (stmt.test) {
          const c = this.truth(evalExpr(stmt.test.cond, this.env), "loop");
          if (stmt.test.kind === "while" ? c : !c) this.next = stmt.startTo + 1;
        } else {
          this.next =
            start.k === "do" && start.test ? stmt.startTo : stmt.startTo + 1;
        }
        return;
      }
      case "for": {
        const from = this.int(evalExpr(stmt.from, this.env), "for");
        const to = this.int(evalExpr(stmt.to, this.env), "for");
        const at = this.forFrames.findIndex((f) => f.pc === this.pc);
        if (at >= 0) this.forFrames.length = at;
        this.forFrames.push({
          pc: this.pc,
          name: stmt.varName,
          to,
          step: from <= to ? 1 : -1,
        });
        this.vars.set(stmt.varName, from);
        return;
      }
      case "next": {
        let at = this.forFrames.length - 1;
        while (at >= 0 && this.forFrames[at].pc !== stmt.startTo) at -= 1;
        if (at < 0)
          throw new TtlError("next に対応する for が実行されていません");
        this.forFrames.length = at + 1;
        const frame = this.forFrames[at];
        const v = this.int(this.env.get(frame.name), "next") + frame.step;
        this.vars.set(frame.name, v);
        if (frame.step > 0 ? v <= frame.to : v >= frame.to) {
          this.next = stmt.startTo + 1;
        } else {
          this.forFrames.length = at;
        }
        return;
      }
      case "break": {
        const loop = this.program.stmts[stmt.loopIdx];
        if (loop.k === "for") this.dropForFrame(stmt.loopIdx);
        this.next = (loop as { endTo: number }).endTo + 1;
        return;
      }
      case "continue": {
        const loop = this.program.stmts[stmt.loopIdx];
        this.next =
          loop.k === "while" || loop.k === "until"
            ? stmt.loopIdx
            : (loop as { endTo: number }).endTo;
        return;
      }
    }
  }

  private dropForFrame(pc: number): void {
    const at = this.forFrames.findIndex((f) => f.pc === pc);
    if (at >= 0) this.forFrames.length = at;
  }

  private assign(
    name: string,
    op: string,
    stmt: Extract<Stmt, { k: "assign" }>,
  ): void {
    if (stmt.index) {
      const index = this.int(evalExpr(stmt.index, this.env), "添字");
      const value =
        op === "="
          ? evalExpr(stmt.expr, this.env)
          : evalExpr(
              {
                k: "bin",
                op: op.slice(0, -1),
                l: { k: "index", name, index: stmt.index },
                r: stmt.expr,
              },
              this.env,
            );
      this.setElement(name, index, value);
      return;
    }
    if (op === "=") {
      this.setVar(name, evalExpr(stmt.expr, this.env));
      return;
    }
    this.setVar(
      name,
      evalExpr(
        {
          k: "bin",
          op: op.slice(0, -1),
          l: { k: "var", name },
          r: stmt.expr,
        },
        this.env,
      ),
    );
  }

  private truth(v: Value, what: string): boolean {
    return this.int(v, what) !== 0;
  }

  private int(v: Value, what: string): number {
    if (typeof v !== "number") throw new TtlError(`${what}: 整数が必要です`);
    return v;
  }

  // ---- コマンド ----

  private values(args: Arg[]): Array<Value | { name: string; index?: number }> {
    return args.map((a) =>
      a.k === "name"
        ? {
            name: a.name,
            index: a.index
              ? this.int(evalExpr(a.index, this.env), "添字")
              : undefined,
          }
        : evalExpr(a, this.env),
    );
  }

  private async command(name: string, args: Arg[]): Promise<void> {
    if (name === "goto" || name === "call") {
      const label = (args[0] as { name: string }).name;
      const to = this.program.labels.get(label);
      if (to === undefined)
        throw new TtlError(`ラベルが見つかりません: ${label}`);
      if (name === "call") this.callStack.push(this.next);
      this.next = to;
      return;
    }
    if (name === "return") {
      const back = this.callStack.pop();
      if (back === undefined)
        throw new TtlError("return に対応する call がありません");
      this.next = back;
      return;
    }
    if (name === "end" || name === "exit") {
      this.finished = true;
      return;
    }
    if (NO_OP_COMMANDS.has(name)) return;

    const v = this.values(args);
    const str = (i: number): string => {
      const x = v[i];
      if (typeof x !== "string")
        throw new TtlError(`${name}: 引数 ${i + 1} は文字列が必要です`);
      return x;
    };
    const num = (i: number): number => {
      const x = v[i];
      if (typeof x !== "number")
        throw new TtlError(`${name}: 引数 ${i + 1} は整数が必要です`);
      return x;
    };
    /** 出力先。配列の要素なら、名前と添字を1つの鍵にまとめる。 */
    const target = (i: number): string => {
      const t = v[i] as { name: string; index?: number };
      return t.index === undefined ? t.name : `${t.name}\u0000${t.index}`;
    };
    const split = (key: string): [string, number | undefined] => {
      const at = key.indexOf("\u0000");
      return at < 0
        ? [key, undefined]
        : [key.slice(0, at), Number(key.slice(at + 1))];
    };
    const store = (key: string, value: Value) => {
      const [n, idx] = split(key);
      if (idx === undefined) this.setVar(n, value);
      else this.setElement(n, idx, value);
    };
    const load = (key: string): Value | undefined => {
      const [n, idx] = split(key);
      if (idx === undefined) return this.vars.get(n);
      return this.element(n, idx).data[idx];
    };
    const nameOf = (i: number): string => (v[i] as { name: string }).name;
    const setResult = (n: number) => void this.vars.set("result", n);
    const strVar = (i: number): string => {
      const cur = load(target(i));
      if (typeof cur !== "string") {
        throw new TtlError(
          `${name}: 変数 ${nameOf(i)} は文字列である必要があります`,
        );
      }
      return cur;
    };
    const intVar = (i: number): number => {
      const cur = load(target(i));
      if (typeof cur !== "number") {
        throw new TtlError(
          `${name}: 変数 ${nameOf(i)} は整数である必要があります`,
        );
      }
      return cur;
    };

    switch (name) {
      case "send":
      case "sendln": {
        let text = "";
        for (let i = 0; i < v.length; i++) {
          const x = v[i];
          if (typeof x === "string") text += x;
          else if (typeof x === "number") text += this.charOf(name, x);
        }
        if (name === "sendln") text += "\r";
        await this.guard(Promise.resolve(this.host.send(text)));
        return;
      }
      case "sendbreak":
        await this.guard(this.host.sendBreak());
        return;
      case "dispstr": {
        let text = "";
        for (const x of v) {
          text +=
            typeof x === "string"
              ? x
              : typeof x === "number"
                ? this.charOf(name, x)
                : "";
        }
        this.host.display(text);
        return;
      }
      case "wait":
      case "wait4all":
      case "waitln": {
        const patterns = v.map((_, i) => str(i));
        const found = await this.waitFor(
          () => this.findPatterns(patterns, name === "waitln"),
          this.timeoutMs(),
        );
        if (!found) setResult(0);
        return;
      }
      case "waitregex": {
        const res = v.map((_, i) => this.regex(name, str(i)));
        const found = await this.waitFor(
          () => this.findRegexes(res),
          this.timeoutMs(),
        );
        if (!found) setResult(0);
        return;
      }
      case "waitn": {
        const count = num(0);
        if (count < 1) throw new TtlError("waitn: 文字数は 1 以上が必要です");
        const found = await this.waitFor(() => {
          if (this.buf.length < count) return false;
          this.vars.set("inputstr", this.buf.slice(0, 511));
          this.buf = "";
          this.vars.set("result", 1);
          return true;
        }, this.timeoutMs());
        if (!found) setResult(0);
        return;
      }
      case "waitrecv": {
        const sub = str(0);
        const len = num(1);
        const pos = num(2);
        if (len < 1 || pos < 1 || pos - 1 + sub.length > len) {
          throw new TtlError("waitrecv: 文字数と位置が正しくありません");
        }
        const matches = (block: string) =>
          block.slice(pos - 1, pos - 1 + sub.length) === sub;
        const found = await this.waitFor(() => {
          while (this.buf.length >= len) {
            const block = this.buf.slice(0, len);
            this.buf = this.buf.slice(len);
            if (matches(block)) {
              this.vars.set("inputstr", block);
              this.vars.set("result", 1);
              return true;
            }
          }
          return false;
        }, this.timeoutMs());
        if (!found) {
          if (this.buf.length > 0 && matches(this.buf)) {
            this.vars.set("inputstr", this.buf);
            this.buf = "";
            setResult(-1);
          } else {
            setResult(0);
          }
        }
        return;
      }
      case "recvln": {
        const found = await this.waitFor(
          () => this.readLine(),
          this.timeoutMs(),
        );
        if (!found) {
          this.vars.set("inputstr", "");
          setResult(0);
        }
        return;
      }
      case "flushrecv":
        this.buf = "";
        return;
      case "pause":
        await this.sleep(num(0) * 1000);
        return;
      case "mpause":
        await this.sleep(num(0));
        return;
      case "messagebox":
        await this.guard(
          this.host.messagebox(this.special(str(0), v, 2), str(1)),
        );
        return;
      case "yesnobox":
        setResult(
          (await this.guard(
            this.host.yesnobox(this.special(str(0), v, 2), str(1)),
          ))
            ? 1
            : 0,
        );
        return;
      case "inputbox": {
        const initial = v.length > 2 ? str(2) : "";
        const got = await this.guard(
          this.host.inputbox(this.special(str(0), v, 3), str(1), initial),
        );
        this.vars.set("inputstr", got ?? "");
        return;
      }
      case "passwordbox": {
        const got = await this.guard(
          this.host.passwordbox(this.special(str(0), v, 2), str(1)),
        );
        this.vars.set("inputstr", got ?? "");
        return;
      }
      case "statusbox":
        this.host.showStatus(this.special(str(0), v, 2), str(1));
        return;
      case "closesbox":
        this.host.closeStatus();
        return;
      case "testlink":
        setResult(this.host.isConnected() ? 2 : 0);
        return;
      case "disconnect":
      case "closett":
        this.host.disconnect();
        return;
      case "inc":
      case "dec":
        store(target(0), (intVar(0) + (name === "inc" ? 1 : -1)) | 0);
        return;
      case "random": {
        const max = num(1);
        if (max < 1) throw new TtlError("random: 上限は 1 以上が必要です");
        // 0 以上 max 以下（max を含む）。
        store(target(0), this.host.random(max + 1));
        return;
      }
      case "getdate":
      case "gettime": {
        const given = v.length > 1;
        const format = given
          ? str(1)
          : name === "getdate"
            ? "%Y-%m-%d"
            : "%H:%M:%S";
        const zone = v.length > 2 ? str(2) : undefined;
        const text = strftime(format, this.host.now(), zone);
        if (text === null) {
          setResult(2);
          return;
        }
        if (text.length > 511) {
          setResult(1);
          return;
        }
        store(target(0), text);
        if (given) setResult(0);
        return;
      }
      case "strlen":
        setResult(str(0).length);
        return;
      case "strcompare": {
        const a = str(0);
        const b = str(1);
        setResult(a < b ? -1 : a > b ? 1 : 0);
        return;
      }
      case "strconcat":
        store(target(0), strVar(0) + str(1));
        return;
      case "strcopy": {
        const s = str(0);
        const index = num(1);
        const len = num(2);
        if (index < 1 || len < 0)
          throw new TtlError("strcopy: 位置は 1 以上、長さは 0 以上が必要です");
        store(target(3), s.slice(index - 1, index - 1 + len));
        return;
      }
      case "strinsert": {
        const cur = strVar(0);
        const index = num(1);
        if (index < 1) throw new TtlError("strinsert: 位置は 1 以上が必要です");
        const at = Math.min(index - 1, cur.length);
        store(target(0), cur.slice(0, at) + str(2) + cur.slice(at));
        return;
      }
      case "strremove": {
        const cur = strVar(0);
        const index = num(1);
        const len = num(2);
        if (index < 1 || len < 0)
          throw new TtlError(
            "strremove: 位置は 1 以上、長さは 0 以上が必要です",
          );
        store(target(0), cur.slice(0, index - 1) + cur.slice(index - 1 + len));
        return;
      }
      case "strreplace": {
        const cur = strVar(0);
        const index = num(1);
        if (index < 1)
          throw new TtlError("strreplace: 位置は 1 以上が必要です");
        const re = this.tryRegex(str(2));
        for (let i = 1; i <= 9; i++) this.vars.set(`groupmatchstr${i}`, "");
        if (!re) {
          setResult(-1);
          return;
        }
        const head = cur.slice(0, index - 1);
        const tail = cur.slice(index - 1);
        const replacement = str(3);
        const m = re.exec(tail);
        if (!m) {
          setResult(0);
          return;
        }
        const replaced = replacement.replace(/\\([0-9])/g, (_, d: string) =>
          d === "0" ? m[0] : (m[Number(d)] ?? ""),
        );
        store(
          target(0),
          head +
            tail.slice(0, m.index) +
            replaced +
            tail.slice(m.index + m[0].length),
        );
        this.vars.set("matchstr", m[0]);
        setResult(1);
        return;
      }
      case "strscan":
        setResult(str(0).indexOf(str(1)) + 1);
        return;
      case "strmatch": {
        const m = this.regex(name, str(1)).exec(str(0));
        if (m) {
          this.vars.set("matchstr", m[0]);
          for (let i = 1; i <= 9; i++)
            this.vars.set(`groupmatchstr${i}`, m[i] ?? "");
        }
        setResult(m ? m.index + 1 : 0);
        return;
      }
      case "strtrim": {
        const chars = str(1);
        let s = strVar(0);
        let a = 0;
        let b = s.length;
        while (a < b && chars.includes(s[a])) a += 1;
        while (b > a && chars.includes(s[b - 1])) b -= 1;
        s = s.slice(a, b);
        store(target(0), s);
        return;
      }
      case "strspecial":
        store(target(0), strspecial(v.length > 1 ? str(1) : strVar(0)));
        return;
      case "str2int": {
        const m = /^[-+]?(?:0x[0-9a-f]+|\$[0-9a-f]+|\d+)/i.exec(str(1).trim());
        if (m) {
          const text = m[0].replace(/^[-+]/, "");
          const sign = m[0].startsWith("-") ? -1 : 1;
          const magnitude = /^0x/i.test(text)
            ? parseInt(text.slice(2), 16)
            : text.startsWith("$")
              ? parseInt(text.slice(1), 16)
              : parseInt(text, 10);
          store(target(0), (sign * magnitude) | 0);
          setResult(1);
        } else {
          setResult(0);
        }
        return;
      }
      case "int2str":
        store(target(0), String(num(1)));
        return;
      case "tolower":
        store(target(0), str(1).toLowerCase());
        return;
      case "toupper":
        store(target(0), str(1).toUpperCase());
        return;
      case "code2str":
        store(target(0), this.charOf(name, num(1)));
        return;
      case "str2code": {
        const s = str(1);
        store(target(0), s.length === 0 ? 0 : (s.codePointAt(0) as number));
        return;
      }
      case "sprintf":
        this.vars.set("inputstr", sprintf(str(0), v.slice(1) as Value[], name));
        return;
      case "sprintf2": {
        const r = printf(str(1), v.slice(2) as Value[]);
        if (r.code === 0) store(target(0), r.text);
        setResult(r.code);
        return;
      }
      case "intdim":
      case "strdim": {
        const arrName = nameOf(0);
        const size = num(1);
        if (!(size >= 1 && size <= MAX_ARRAY_SIZE)) {
          throw new TtlError(
            `${name}: 要素数は 1〜${MAX_ARRAY_SIZE} にしてください`,
          );
        }
        if (this.arrays.has(arrName) || this.vars.has(arrName)) {
          throw new TtlError(`${name}: ${arrName} は、すでに使われています`);
        }
        const isInt = name === "intdim";
        this.arrays.set(arrName, {
          type: isInt ? "int" : "str",
          data: Array.from({ length: size }, () => (isInt ? 0 : "")),
        });
        return;
      }
      case "strsplit": {
        const text = str(0);
        const delimiter = str(1);
        if (delimiter.length !== 1)
          throw new TtlError("strsplit: 区切りは1文字にしてください");
        const given = v.length > 2;
        const max = given ? num(2) : 9;
        if (max < 1 || max > 9)
          throw new TtlError("strsplit: 個数は 1〜9 にしてください");
        const parts = text.split(delimiter);
        let used: string[];
        if (given && parts.length > max) {
          used = [
            ...parts.slice(0, max - 1),
            parts.slice(max - 1).join(delimiter),
          ];
        } else {
          used = parts;
        }
        for (let i = 1; i <= 9; i++) {
          // 個数を指定しないで10個以上に分かれたときは、9番目だけに値を入れる。
          const piece = i < 9 || used.length <= 9 ? used[i - 1] : used[8];
          this.vars.set(`groupmatchstr${i}`, piece ?? "");
        }
        setResult(!given && parts.length > 9 ? 10 : used.length);
        return;
      }
      case "strjoin": {
        const delimiter = str(1);
        const max = v.length > 2 ? num(2) : 9;
        if (max < 1 || max > 9)
          throw new TtlError("strjoin: 個数は 1〜9 にしてください");
        const pieces: string[] = [];
        for (let i = 1; i <= max; i++) {
          pieces.push(String(this.vars.get(`groupmatchstr${i}`) ?? ""));
        }
        // 後ろの空の groupmatchstr は、つなげない。
        while (pieces.length > 1 && pieces[pieces.length - 1] === "")
          pieces.pop();
        store(target(0), pieces.join(delimiter));
        return;
      }
      case "listbox": {
        const arr = this.strArray(name, nameOf(2));
        const selected = v.length > 3 ? num(3) : 0;
        const picked = await this.guard(
          this.host.listbox(str(0), str(1), arr.data as string[], selected),
        );
        setResult(picked === null ? -1 : picked);
        return;
      }
      case "gethostname":
        store(target(0), this.host.hostName());
        return;
      case "gettitle":
        store(target(0), this.host.getTitle());
        return;
      case "settitle":
        this.host.setTitle(str(0));
        return;
      case "setecho":
        this.host.setEcho(num(0) !== 0);
        return;
      case "setdtr":
      case "setrts":
        await this.guard(
          this.host.setSignal(name === "setdtr" ? "dtr" : "rts", num(0) !== 0),
        );
        return;
      case "enablekeyb":
        this.host.setKeyboardEnabled(num(0) !== 0);
        return;
      case "clearscreen": {
        const kind = num(0);
        if (kind < 0 || kind > 2)
          throw new TtlError("clearscreen: 0〜2 を指定してください");
        if (kind <= 1) this.host.clearScreen(kind as 0 | 1);
        return;
      }
      case "beep":
        this.host.beep(v.length > 0 ? num(0) : 5);
        return;
      case "show":
        num(0);
        return;
      case "sendbroadcast":
      case "sendlnbroadcast": {
        let text = "";
        for (const x of v) {
          if (typeof x === "string") text += x;
          else if (typeof x === "number") text += this.charOf(name, x);
        }
        if (name === "sendlnbroadcast") text += "\r";
        this.host.broadcast(text);
        return;
      }
      case "getver": {
        store(target(0), RUNNING_VERSION);
        if (v.length > 1) setResult(compareVersion(RUNNING_VERSION, str(1)));
        return;
      }
      case "ifdefined": {
        const n = nameOf(0);
        const arr = this.arrays.get(n);
        const value = this.vars.get(n);
        setResult(
          arr
            ? arr.type === "int"
              ? 5
              : 6
            : typeof value === "number"
              ? 1
              : typeof value === "string"
                ? 3
                : this.program.labels.has(n)
                  ? 4
                  : 0,
        );
        return;
      }
      case "uptime":
        store(target(0), this.host.uptimeMs() | 0);
        return;
      case "checksum8":
      case "checksum16":
      case "checksum32":
        store(
          target(0),
          checksum(str(1), Number(name.slice(8)) as 8 | 16 | 32),
        );
        return;
      case "crc16":
        store(target(0), crc16(str(1)));
        return;
      case "crc32":
        store(target(0), crc32(str(1)));
        return;
      case "rotateleft":
      case "rotateright":
        store(target(0), rotate32(num(1), num(2), name === "rotateleft"));
        return;
      case "regexoption":
        this.setRegexOptions(v.map((_, i) => str(i)));
        return;
      default:
        throw new TtlError(`未対応の命令です: ${name}`);
    }
  }

  /** 文字列の配列（strdim で作ったもの）。 */
  private strArray(
    command: string,
    name: string,
  ): { type: "int" | "str"; data: Value[] } {
    const arr = this.arrays.get(name);
    if (!arr || arr.type !== "str") {
      throw new TtlError(
        `${command}: ${name} は strdim で作った配列にしてください`,
      );
    }
    return arr;
  }

  private charOf(name: string, code: number): string {
    if (!(code >= 0 && code <= 0x10ffff))
      throw new TtlError(`${name}: 文字コードが範囲外です: ${code}`);
    return String.fromCodePoint(code);
  }

  private regex(name: string, pattern: string): RegExp {
    if (pattern.length > MAX_REGEX_CHARS) {
      throw new TtlError(
        `${name}: 正規表現が長すぎます（${MAX_REGEX_CHARS}文字まで）`,
      );
    }
    try {
      return this.compile(pattern);
    } catch (e) {
      throw new TtlError(
        `${name}: 正規表現が正しくありません: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** 不正・長すぎる正規表現は、例外にせず `null`（`strreplace` の result -1 用）。 */
  private tryRegex(pattern: string): RegExp | null {
    if (pattern.length > MAX_REGEX_CHARS) return null;
    try {
      return this.compile(pattern);
    } catch {
      return null;
    }
  }

  private compile(pattern: string): RegExp {
    const { ignoreCase, dotAll, asis } = this.regexOptions;
    const source = asis
      ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      : pattern;
    return new RegExp(source, `${ignoreCase ? "i" : ""}${dotAll ? "s" : ""}`);
  }

  /** `regexoption`: 文法・文字コード・オプションを決める（指定のたびに、初期値から決め直す）。 */
  private setRegexOptions(tokens: string[]): void {
    const next = { ignoreCase: false, dotAll: false, asis: false };
    for (const raw of tokens) {
      const t = raw.toUpperCase();
      if (t === "IGNORECASE") next.ignoreCase = true;
      else if (t === "MULTILINE") next.dotAll = true;
      else if (t === "ASIS") next.asis = true;
      else if (!REGEX_TOKENS.has(t) && !/^ISO_8859_(?:[1-9]|1[0-6])$/.test(t)) {
        throw new TtlError(`regexoption: 知らない指定です: ${raw}`);
      }
    }
    this.regexOptions = next;
  }

  /** `special`（省略可の引数）が 0 以外なら、メッセージの \\n \\t を文字にする。 */
  private special(
    message: string,
    v: Array<Value | { name: string; index?: number }>,
    at: number,
  ): string {
    const flag = v[at];
    return typeof flag === "number" && flag !== 0
      ? strspecial(message)
      : message;
  }

  // ---- 待つ ----

  private timeoutMs(): number {
    const t = this.vars.get("timeout");
    const m = this.vars.get("mtimeout");
    if (typeof t !== "number" || typeof m !== "number") {
      throw new TtlError("timeout と mtimeout は整数にしてください");
    }
    return Math.max(0, t) * 1000 + Math.max(0, m);
  }

  /**
   * 受信した文字から探す。見つかれば、一致した所までを捨てて `result` などを設定し、`true`。
   * `waitln` は、改行までそろった行の中だけで照合し、その行を `inputstr` に入れる。
   * 空の文字列は、`wait` ではどの1文字にも、`waitln` ではどの行にも一致する。
   */
  private findPatterns(patterns: string[], perLine: boolean): boolean {
    if (perLine) {
      let start = 0;
      for (;;) {
        const nl = this.buf.indexOf("\n", start);
        if (nl < 0) return false;
        const line = this.buf.slice(start, nl);
        const index = patterns.findIndex((p) => p === "" || line.includes(p));
        if (index >= 0) {
          this.vars.set("inputstr", line);
          this.vars.set("result", index + 1);
          this.buf = this.buf.slice(nl + 1);
          return true;
        }
        start = nl + 1;
      }
    }
    let best: { end: number; index: number } | null = null;
    patterns.forEach((p, i) => {
      let end = -1;
      if (p === "") {
        if (this.buf.length > 0) end = 1;
      } else {
        const at = this.buf.indexOf(p);
        if (at >= 0) end = at + p.length;
      }
      if (end >= 0 && (best === null || end < best.end))
        best = { end, index: i };
    });
    if (best === null) return false;
    const found = best as { end: number; index: number };
    this.buf = this.buf.slice(found.end);
    this.vars.set("result", found.index + 1);
    return true;
  }

  /** 改行までそろった行を1行ずつ、正規表現のどれかで照合する（`waitregex`）。 */
  private findRegexes(res: RegExp[]): boolean {
    let start = 0;
    for (;;) {
      const nl = this.buf.indexOf("\n", start);
      if (nl < 0) return false;
      const line = this.buf.slice(start, nl);
      for (let i = 0; i < res.length; i++) {
        const m = res[i].exec(line.slice(0, 511));
        if (!m) continue;
        this.vars.set("inputstr", line);
        this.vars.set("matchstr", m[0]);
        for (let g = 1; g <= 9; g++)
          this.vars.set(`groupmatchstr${g}`, m[g] ?? "");
        this.vars.set("result", i + 1);
        this.buf = this.buf.slice(nl + 1);
        return true;
      }
      start = nl + 1;
    }
  }

  private readLine(): boolean {
    const nl = this.buf.indexOf("\n");
    if (nl < 0) return false;
    this.vars.set("inputstr", this.buf.slice(0, nl));
    this.buf = this.buf.slice(nl + 1);
    this.vars.set("result", 1);
    return true;
  }

  /** `find` が真になるか、時間切れ（0 なら無期限）か、停止されるまで待つ。見つかれば `true`。 */
  private waitFor(find: () => boolean, timeoutMs: number): Promise<boolean> {
    if (find()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (found: boolean) => {
        if (timer !== null) clearTimeout(timer);
        this.onData = null;
        this.cancelWait = null;
        resolve(found);
      };
      this.onData = () => {
        if (find()) finish(true);
      };
      this.cancelWait = () => finish(false);
      if (timeoutMs > 0) timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await this.guard(
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.cancelWait = null;
          resolve();
        }, ms);
        this.cancelWait = () => {
          clearTimeout(timer);
          this.cancelWait = null;
          resolve();
        };
      }),
    );
  }

  /** 処理を待つ間に停止されたら、そこで止める。 */
  private async guard<T>(p: Promise<T>): Promise<T> {
    const result = await Promise.race([
      p,
      this.aborted.then(() => undefined as never),
    ]);
    if (this.stopped) throw new StopSignal();
    return result;
  }
}

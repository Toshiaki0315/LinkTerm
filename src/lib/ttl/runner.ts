import { stripTerminalControls } from "../auto-login";
import { TtlError } from "./errors";
import { evalExpr, type Env, type Value } from "./expr";
import type { Arg, Program, Stmt } from "./parser";
import { formatStrftime, sprintf, strspecial } from "./strings";

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
  disconnect(): void;
  isConnected(): boolean;
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
      const v = this.vars.get(name);
      if (v === undefined) throw new TtlError(`変数 ${name} に値がありません`);
      return v;
    },
  };

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
    if (op === "=") {
      this.vars.set(name, evalExpr(stmt.expr, this.env));
      return;
    }
    const binary = op.slice(0, -1);
    this.vars.set(
      name,
      evalExpr(
        { k: "bin", op: binary, l: { k: "var", name }, r: stmt.expr },
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

  private values(args: Arg[]): Array<Value | { name: string }> {
    return args.map((a) =>
      a.k === "name" ? { name: a.name } : evalExpr(a, this.env),
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
    const target = (i: number): string => (v[i] as { name: string }).name;
    const setResult = (n: number) => void this.vars.set("result", n);
    const strVar = (i: number): string => {
      const cur = this.vars.get(target(i));
      if (typeof cur !== "string") {
        throw new TtlError(
          `${name}: 変数 ${target(i)} は文字列である必要があります`,
        );
      }
      return cur;
    };
    const intVar = (i: number): number => {
      const cur = this.vars.get(target(i));
      if (typeof cur !== "number") {
        throw new TtlError(
          `${name}: 変数 ${target(i)} は整数である必要があります`,
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
        const re = this.regex(name, str(0));
        const found = await this.waitFor(
          () => this.findRegex(re),
          this.timeoutMs(),
        );
        if (!found) setResult(0);
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
        await this.guard(this.host.messagebox(str(0), str(1)));
        return;
      case "yesnobox":
        setResult(
          (await this.guard(this.host.yesnobox(str(0), str(1)))) ? 1 : 0,
        );
        return;
      case "inputbox": {
        const initial = v.length > 2 ? str(2) : "";
        const got = await this.guard(
          this.host.inputbox(str(0), str(1), initial),
        );
        this.vars.set("inputstr", got ?? "");
        return;
      }
      case "passwordbox": {
        const got = await this.guard(this.host.passwordbox(str(0), str(1)));
        this.vars.set("inputstr", got ?? "");
        return;
      }
      case "testlink":
        setResult(this.host.isConnected() ? 2 : 0);
        return;
      case "disconnect":
      case "closett":
        this.host.disconnect();
        return;
      case "inc":
      case "dec":
        this.vars.set(target(0), (intVar(0) + (name === "inc" ? 1 : -1)) | 0);
        return;
      case "random": {
        const max = num(1);
        if (max < 1) throw new TtlError("random: 上限は 1 以上が必要です");
        this.vars.set(target(0), this.host.random(max));
        return;
      }
      case "getdate":
        this.vars.set(
          target(0),
          formatStrftime(v.length > 1 ? str(1) : "%Y-%m-%d", this.host.now()),
        );
        return;
      case "gettime":
        this.vars.set(
          target(0),
          formatStrftime(v.length > 1 ? str(1) : "%H:%M:%S", this.host.now()),
        );
        return;
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
        this.vars.set(target(0), strVar(0) + str(1));
        return;
      case "strcopy": {
        const s = str(0);
        const index = num(1);
        const len = num(2);
        if (index < 1 || len < 0)
          throw new TtlError("strcopy: 位置は 1 以上、長さは 0 以上が必要です");
        this.vars.set(target(3), s.slice(index - 1, index - 1 + len));
        return;
      }
      case "strinsert": {
        const cur = strVar(0);
        const index = num(1);
        if (index < 1) throw new TtlError("strinsert: 位置は 1 以上が必要です");
        const at = Math.min(index - 1, cur.length);
        this.vars.set(target(0), cur.slice(0, at) + str(2) + cur.slice(at));
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
        this.vars.set(
          target(0),
          cur.slice(0, index - 1) + cur.slice(index - 1 + len),
        );
        return;
      }
      case "strreplace": {
        const cur = strVar(0);
        const index = num(1);
        if (index < 1)
          throw new TtlError("strreplace: 位置は 1 以上が必要です");
        const re = this.regex(name, str(2));
        const head = cur.slice(0, index - 1);
        const tail = cur.slice(index - 1);
        const replacement = str(3);
        const replaced = tail.replace(re, (...m) => {
          const groups = m.slice(0, -2) as string[];
          return replacement.replace(
            /\\([0-9])/g,
            (_, d: string) => groups[Number(d)] ?? "",
          );
        });
        this.vars.set(target(0), head + replaced);
        return;
      }
      case "strscan":
        setResult(str(0).indexOf(str(1)) + 1);
        return;
      case "strmatch": {
        const m = this.regex(name, str(1)).exec(str(0));
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
        this.vars.set(target(0), s);
        return;
      }
      case "strspecial":
        this.vars.set(target(0), strspecial(strVar(0)));
        return;
      case "str2int": {
        const s = str(1).trim();
        const n = /^-?\d+$/.test(s) ? Number(s) : NaN;
        if (Number.isInteger(n) && n >= -2147483648 && n <= 2147483647) {
          this.vars.set(target(0), n);
          setResult(1);
        } else {
          setResult(0);
        }
        return;
      }
      case "int2str":
        this.vars.set(target(0), String(num(1)));
        return;
      case "tolower":
        this.vars.set(target(0), str(1).toLowerCase());
        return;
      case "toupper":
        this.vars.set(target(0), str(1).toUpperCase());
        return;
      case "code2str":
        this.vars.set(target(0), this.charOf(name, num(1)));
        return;
      case "str2code": {
        const s = str(1);
        this.vars.set(
          target(0),
          s.length === 0 ? 0 : (s.codePointAt(0) as number),
        );
        return;
      }
      case "sprintf":
        this.vars.set("inputstr", sprintf(str(0), v.slice(1) as Value[], name));
        return;
      default:
        throw new TtlError(`未対応の命令です: ${name}`);
    }
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
      return new RegExp(pattern);
    } catch (e) {
      throw new TtlError(
        `${name}: 正規表現が正しくありません: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
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

  /** 受信した文字から探す。見つかれば、一致した所までを捨てて `result` などを設定し、`true`。 */
  private findPatterns(patterns: string[], perLine: boolean): boolean {
    let best: { end: number; index: number } | null = null;
    patterns.forEach((p, i) => {
      let end = -1;
      if (!perLine) {
        const at = this.buf.indexOf(p);
        if (at >= 0) end = at + p.length;
      } else {
        let lineStart = 0;
        while (lineStart <= this.buf.length) {
          const nl = this.buf.indexOf("\n", lineStart);
          const lineEnd = nl < 0 ? this.buf.length : nl;
          const at = this.buf.slice(lineStart, lineEnd).indexOf(p);
          if (at >= 0) {
            end = lineStart + at + p.length;
            break;
          }
          if (nl < 0) break;
          lineStart = nl + 1;
        }
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

  private findRegex(re: RegExp): boolean {
    const m = re.exec(this.buf);
    if (!m) return false;
    this.vars.set("matchstr", m[0]);
    for (let i = 1; i <= 9; i++) this.vars.set(`groupmatchstr${i}`, m[i] ?? "");
    this.vars.set("result", 1);
    this.buf = this.buf.slice(m.index + m[0].length);
    return true;
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

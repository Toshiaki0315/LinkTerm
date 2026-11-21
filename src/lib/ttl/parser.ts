import { COMMANDS, UNSUPPORTED_COMMANDS } from "./commands";
import { TtlError } from "./errors";
import { parseExpr, type Expr } from "./expr";
import { tokenizeLine, type Token } from "./lexer";

export const MAX_SOURCE_CHARS = 100_000;

export type Arg = Expr | { k: "name"; name: string };

interface Base {
  /** 元のスクリプトの行番号（1 から）。 */
  line: number;
}

export type LoopTest = { kind: "while" | "until"; cond: Expr } | null;

export type Stmt = Base &
  (
    | { k: "assign"; name: string; op: string; expr: Expr }
    | { k: "cmd"; name: string; args: Arg[] }
    | { k: "label"; name: string }
    | { k: "if"; cond: Expr; elseTo: number; endTo: number }
    | { k: "elseif"; cond: Expr; elseTo: number; endTo: number }
    | { k: "else"; endTo: number }
    | { k: "endif" }
    | { k: "inlineIf"; cond: Expr; then: Stmt }
    | { k: "while"; cond: Expr; endTo: number }
    | { k: "endwhile"; startTo: number }
    | { k: "until"; cond: Expr; endTo: number }
    | { k: "enduntil"; startTo: number }
    | { k: "do"; test: LoopTest; endTo: number }
    | { k: "loop"; test: LoopTest; startTo: number }
    | { k: "for"; varName: string; from: Expr; to: Expr; endTo: number }
    | { k: "next"; startTo: number }
    | { k: "break"; loopIdx: number }
    | { k: "continue"; loopIdx: number }
  );

export interface Program {
  stmts: Stmt[];
  /** ラベル名（小文字）→ 文の位置。 */
  labels: Map<string, number>;
}

export interface ParseIssue {
  line: number;
  message: string;
}

export type ParseResult =
  { ok: true; program: Program } | { ok: false; errors: ParseIssue[] };

const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%="]);
const LABEL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 式を1つ読む。 */
function readExpr(tokens: Token[], pos: number): { expr: Expr; pos: number } {
  return parseExpr(tokens, pos);
}

/** コマンドの引数を、形（spec）に従って読む。 */
function readArgs(
  name: string,
  spec: string,
  tokens: Token[],
  from: number,
): Arg[] {
  const args: Arg[] = [];
  let pos = from;
  const required = [...spec].filter(
    (c) => c === "e" || c === "v" || c === "l" || c === "+",
  ).length;
  const variadic = spec.endsWith("+") || spec.endsWith("*");
  const fixed = variadic ? spec.length - 1 : spec.length;
  const countError = () =>
    new TtlError(
      `${name} の引数の数が正しくありません（${
        variadic
          ? `${required}個以上`
          : `${required}個${spec.includes("E") || spec.includes("V") ? "以上" : ""}`
      }が必要）`,
    );
  for (let i = 0; i < fixed; i++) {
    const kind = spec[i];
    const optional = kind === "E" || kind === "V";
    if (pos >= tokens.length) {
      if (optional) break;
      throw countError();
    }
    if (kind === "v" || kind === "V") {
      const tok = tokens[pos];
      if (tok.t !== "id")
        throw new TtlError(`${name} の引数には変数名を書いてください`);
      args.push({ k: "name", name: tok.lower });
      pos += 1;
    } else if (kind === "l") {
      const tok = tokens[pos];
      if (tok.t !== "id")
        throw new TtlError(`${name} にはラベル名を書いてください`);
      args.push({ k: "name", name: tok.lower });
      pos += 1;
    } else {
      const r = readExpr(tokens, pos);
      args.push(r.expr);
      pos = r.pos;
    }
  }
  if (variadic) {
    let n = 0;
    while (pos < tokens.length) {
      const r = readExpr(tokens, pos);
      args.push(r.expr);
      pos = r.pos;
      n += 1;
    }
    if (spec.endsWith("+") && n === 0) throw countError();
  }
  if (pos < tokens.length) throw countError();
  return args;
}

/** 1行 if の中の break / continue。いちばん内側のループを指す。 */
function loopControl(
  word: "break" | "continue",
  tokens: Token[],
  stack: Frame[],
  line: number,
): Stmt {
  let loopIdx = -1;
  for (let s = stack.length - 1; s >= 0; s--) {
    const f = stack[s];
    if (f.type !== "if") {
      loopIdx = f.idx;
      break;
    }
  }
  if (loopIdx < 0) throw new TtlError(`${word} はループの中だけで使えます`);
  if (tokens.length > 1)
    throw new TtlError(`${word} のあとに余分なものがあります`);
  return { k: word, loopIdx, line };
}

/** 1つの文（制御構造の開始・終了以外）を、トークンから作る。1行 if の中身にも使う。 */
function parseSimple(tokens: Token[], line: number): Stmt {
  const first = tokens[0];
  if (first.t !== "id") throw new TtlError("命令または変数が必要です");
  const second = tokens[1];
  if (second && second.t === "op" && ASSIGN_OPS.has(second.v)) {
    const { expr, pos } = readExpr(tokens, 2);
    if (pos < tokens.length)
      throw new TtlError("式のあとに余分なものがあります");
    return { k: "assign", name: first.lower, op: second.v, expr, line };
  }
  const name = first.lower;
  if (UNSUPPORTED_COMMANDS.has(name)) {
    throw new TtlError(
      `${first.v} は、このアプリでは使えません（安全のため、ファイルや外部コマンドは扱いません）`,
    );
  }
  const spec = COMMANDS[name];
  if (spec === undefined) {
    throw new TtlError(`未対応の命令または文法です: ${first.v}`);
  }
  return { k: "cmd", name, args: readArgs(first.v, spec, tokens, 1), line };
}

type Frame =
  | { type: "if"; branches: number[]; hasElse: boolean; line: number }
  | { type: "while" | "until" | "do" | "for"; idx: number; line: number };

const END_OF: Record<string, string> = {
  while: "endwhile",
  until: "enduntil",
  do: "loop",
  for: "next",
};

/** スクリプトを文に分け、制御構造の飛び先とラベルを決める。誤りはすべて集めて返す。 */
export function parseProgram(source: string): ParseResult {
  if (source.length > MAX_SOURCE_CHARS) {
    return {
      ok: false,
      errors: [
        {
          line: 1,
          message: `スクリプトが大きすぎます（${MAX_SOURCE_CHARS}文字まで）`,
        },
      ],
    };
  }
  const stmts: Stmt[] = [];
  const labels = new Map<string, number>();
  const issues: ParseIssue[] = [];
  const stack: Frame[] = [];
  const gotos: Array<{ name: string; line: number }> = [];
  const lines = source.split(/\r\n|\r|\n/);

  const fail = (line: number, e: unknown) => {
    issues.push({ line, message: e instanceof Error ? e.message : String(e) });
  };

  for (let n = 0; n < lines.length; n++) {
    const line = n + 1;
    const raw = lines[n];
    try {
      const trimmed = raw.trim();
      if (trimmed.startsWith(":")) {
        const name = trimmed.slice(1).split(/[\s;]/)[0];
        if (!LABEL_NAME.test(name))
          throw new TtlError(`ラベル名が正しくありません: ${name}`);
        const key = name.toLowerCase();
        if (labels.has(key))
          throw new TtlError(`ラベルが重複しています: ${name}`);
        labels.set(key, stmts.length);
        stmts.push({ k: "label", name: key, line });
        continue;
      }
      const tokens = tokenizeLine(raw);
      if (tokens.length === 0) continue;
      const idx = stmts.length;
      const head = tokens[0];
      const word = head.t === "id" ? head.lower : "";
      const isAssign =
        tokens[1]?.t === "op" && ASSIGN_OPS.has((tokens[1] as { v: string }).v);

      if (word && !isAssign) {
        switch (word) {
          case "if": {
            const { expr, pos } = readExpr(tokens, 1);
            const then = tokens[pos];
            if (!then || then.t !== "id" || then.lower !== "then") {
              throw new TtlError("if には then が必要です");
            }
            const rest = tokens.slice(pos + 1);
            if (rest.length > 0) {
              const w = rest[0].t === "id" ? rest[0].lower : "";
              const inner =
                w === "break" || w === "continue"
                  ? loopControl(w, rest, stack, line)
                  : parseSimple(rest, line);
              stmts.push({ k: "inlineIf", cond: expr, then: inner, line });
              if (
                inner.k === "cmd" &&
                (inner.name === "goto" || inner.name === "call")
              ) {
                gotos.push({
                  name: (inner.args[0] as { name: string }).name,
                  line,
                });
              }
            } else {
              stmts.push({ k: "if", cond: expr, elseTo: -1, endTo: -1, line });
              stack.push({ type: "if", branches: [idx], hasElse: false, line });
            }
            continue;
          }
          case "elseif": {
            const top = stack[stack.length - 1];
            if (!top || top.type !== "if")
              throw new TtlError("elseif に対応する if がありません");
            if (top.hasElse)
              throw new TtlError("else のあとに elseif は書けません");
            const { expr, pos } = readExpr(tokens, 1);
            const then = tokens[pos];
            if (!then || then.t !== "id" || then.lower !== "then") {
              throw new TtlError("elseif には then が必要です");
            }
            const prev = stmts[top.branches[top.branches.length - 1]] as {
              elseTo: number;
            };
            prev.elseTo = idx;
            stmts.push({
              k: "elseif",
              cond: expr,
              elseTo: -1,
              endTo: -1,
              line,
            });
            top.branches.push(idx);
            continue;
          }
          case "else": {
            const top = stack[stack.length - 1];
            if (!top || top.type !== "if")
              throw new TtlError("else に対応する if がありません");
            if (top.hasElse) throw new TtlError("else が2つあります");
            if (tokens.length > 1)
              throw new TtlError("else のあとに余分なものがあります");
            const prev = stmts[top.branches[top.branches.length - 1]] as {
              elseTo: number;
            };
            prev.elseTo = idx;
            stmts.push({ k: "else", endTo: -1, line });
            top.branches.push(idx);
            top.hasElse = true;
            continue;
          }
          case "endif": {
            const top = stack.pop();
            if (!top || top.type !== "if") {
              if (top) stack.push(top);
              throw new TtlError("endif に対応する if がありません");
            }
            const last = stmts[top.branches[top.branches.length - 1]] as {
              k: string;
              elseTo?: number;
            };
            if (last.k !== "else") last.elseTo = idx;
            for (const b of top.branches)
              (stmts[b] as { endTo: number }).endTo = idx;
            stmts.push({ k: "endif", line });
            continue;
          }
          case "while":
          case "until": {
            const { expr, pos } = readExpr(tokens, 1);
            if (pos < tokens.length)
              throw new TtlError("式のあとに余分なものがあります");
            stmts.push({ k: word, cond: expr, endTo: -1, line });
            stack.push({ type: word, idx, line });
            continue;
          }
          case "endwhile":
          case "enduntil": {
            const top = stack[stack.length - 1];
            const open = word === "endwhile" ? "while" : "until";
            if (!top || top.type !== open) {
              throw new TtlError(`${word} に対応する ${open} がありません`);
            }
            stack.pop();
            (stmts[top.idx] as { endTo: number }).endTo = idx;
            stmts.push({ k: word, startTo: top.idx, line });
            continue;
          }
          case "do": {
            let test: LoopTest = null;
            if (tokens.length > 1) {
              const kw = tokens[1];
              if (
                kw.t !== "id" ||
                (kw.lower !== "while" && kw.lower !== "until")
              ) {
                throw new TtlError("do のあとには while か until を書きます");
              }
              const { expr, pos } = readExpr(tokens, 2);
              if (pos < tokens.length)
                throw new TtlError("式のあとに余分なものがあります");
              test = { kind: kw.lower, cond: expr };
            }
            stmts.push({ k: "do", test, endTo: -1, line });
            stack.push({ type: "do", idx, line });
            continue;
          }
          case "loop": {
            const top = stack[stack.length - 1];
            if (!top || top.type !== "do")
              throw new TtlError("loop に対応する do がありません");
            let test: LoopTest = null;
            if (tokens.length > 1) {
              const kw = tokens[1];
              if (
                kw.t !== "id" ||
                (kw.lower !== "while" && kw.lower !== "until")
              ) {
                throw new TtlError("loop のあとには while か until を書きます");
              }
              const { expr, pos } = readExpr(tokens, 2);
              if (pos < tokens.length)
                throw new TtlError("式のあとに余分なものがあります");
              test = { kind: kw.lower, cond: expr };
            }
            stack.pop();
            (stmts[top.idx] as { endTo: number }).endTo = idx;
            stmts.push({ k: "loop", test, startTo: top.idx, line });
            continue;
          }
          case "for": {
            const v = tokens[1];
            if (!v || v.t !== "id")
              throw new TtlError("for には変数名が必要です");
            const a = readExpr(tokens, 2);
            const b = readExpr(tokens, a.pos);
            if (b.pos < tokens.length)
              throw new TtlError("for の引数が多すぎます");
            stmts.push({
              k: "for",
              varName: v.lower,
              from: a.expr,
              to: b.expr,
              endTo: -1,
              line,
            });
            stack.push({ type: "for", idx, line });
            continue;
          }
          case "next": {
            const top = stack[stack.length - 1];
            if (!top || top.type !== "for")
              throw new TtlError("next に対応する for がありません");
            stack.pop();
            (stmts[top.idx] as { endTo: number }).endTo = idx;
            stmts.push({ k: "next", startTo: top.idx, line });
            continue;
          }
          case "break":
          case "continue":
            stmts.push(loopControl(word, tokens, stack, line));
            continue;
        }
      }
      const stmt = parseSimple(tokens, line);
      if (stmt.k === "cmd" && (stmt.name === "goto" || stmt.name === "call")) {
        gotos.push({ name: (stmt.args[0] as { name: string }).name, line });
      }
      stmts.push(stmt);
    } catch (e) {
      fail(line, e);
    }
  }

  for (const f of stack) {
    issues.push({
      line: f.line,
      message:
        f.type === "if"
          ? "if が endif で閉じられていません"
          : `${f.type} が ${END_OF[f.type]} で閉じられていません`,
    });
  }
  for (const g of gotos) {
    if (!labels.has(g.name)) {
      issues.push({
        line: g.line,
        message: `ラベルが見つかりません: ${g.name}`,
      });
    }
  }

  if (issues.length > 0) {
    issues.sort((a, b) => a.line - b.line);
    return { ok: false, errors: issues };
  }
  return { ok: true, program: { stmts, labels } };
}

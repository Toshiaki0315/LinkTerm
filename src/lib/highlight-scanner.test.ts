import { describe, expect, it, vi } from "vitest";
import { newRule, type HighlightRule } from "./highlight";
import {
  HighlightScanner,
  type Marker,
  type ScanTerm,
} from "./highlight-scanner";

/** 行の文字列から、1文字1セルの偽のバッファを作る。 */
function fakeTerm(
  lines: string[],
  opts: { cols?: number; type?: string } = {},
) {
  const cols = opts.cols ?? 20;
  const state = {
    lines,
    baseY: 0,
    cursorY: lines.length - 1,
    type: opts.type ?? "normal",
  };
  const markers: Array<Marker & { _line: number; _disposed: boolean }> = [];
  const decorations: Array<{
    options: Record<string, unknown>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const term: ScanTerm = {
    cols,
    buffer: {
      active: {
        get type() {
          return state.type;
        },
        get baseY() {
          return state.baseY;
        },
        get cursorY() {
          return state.cursorY;
        },
        get length() {
          return state.lines.length;
        },
        getLine: (y) => {
          const text = state.lines[y];
          if (text === undefined) return undefined;
          return {
            isWrapped: false,
            getCell: (x) =>
              x < cols
                ? { getChars: () => text[x] ?? "", getWidth: () => 1 }
                : undefined,
          };
        },
      },
    },
    registerMarker: (offset = 0) => {
      const m = {
        _line: state.baseY + state.cursorY + offset,
        _disposed: false,
        get line() {
          return this._line;
        },
        get isDisposed() {
          return this._disposed;
        },
        dispose() {
          this._disposed = true;
        },
      };
      markers.push(m);
      return m;
    },
    registerDecoration: (options) => {
      const d = {
        options: options as unknown as Record<string, unknown>,
        dispose: vi.fn(),
      };
      decorations.push(d);
      return d;
    },
  };
  return { term, state, markers, decorations };
}

const rule = (over: Partial<HighlightRule> = {}): HighlightRule => ({
  ...newRule("r"),
  pattern: "ERROR",
  ...over,
});

describe("HighlightScanner", () => {
  it("一致した部分に、列と幅・色を指定した装飾を付ける", () => {
    const { term, decorations } = fakeTerm(["ok", "xx ERROR yy"]);
    const s = new HighlightScanner(term);
    s.setRules([rule({ color: "red" })]);
    expect(decorations).toHaveLength(1);
    expect(decorations[0].options).toMatchObject({
      x: 3,
      width: 5,
      backgroundColor: "#ef4444",
      foregroundColor: "#ffffff",
    });
  });

  it("同じ行を何度調べても、装飾は増えない。内容が変われば付け直す", () => {
    const { term, state, decorations } = fakeTerm(["ERROR"]);
    const s = new HighlightScanner(term);
    s.setRules([rule()]);
    s.scanRecent(5);
    s.scanRecent(5);
    expect(decorations).toHaveLength(1);
    state.lines[0] = "ERROR ERROR";
    s.scanRecent(5);
    expect(decorations).toHaveLength(3);
    expect(decorations[0].dispose).toHaveBeenCalled();
  });

  it("新しく増えた行だけを新たに調べる", () => {
    const { term, state, decorations } = fakeTerm(["ERROR 1"]);
    const s = new HighlightScanner(term);
    s.setRules([rule()]);
    state.lines.push("ERROR 2");
    state.cursorY = 1;
    s.scanRecent(5);
    expect(decorations).toHaveLength(2);
    expect(decorations[0].dispose).not.toHaveBeenCalled();
  });

  it("スクロールで行がずれて、装飾の位置が合わなくなったら付け直す", () => {
    const { term, state, markers, decorations } = fakeTerm(["a", "ERROR"]);
    const s = new HighlightScanner(term);
    s.setRules([rule()]);
    // 先頭の行が捨てられ、同じ内容の行が 0 番目になった（マーカーは 1 のまま取り残される想定）。
    state.lines = ["ERROR", "b"];
    state.cursorY = 1;
    markers[0]._line = -1;
    s.scanRecent(5);
    expect(decorations.length).toBeGreaterThan(1);
  });

  it("規則を替えると、付けていた装飾を外して調べ直す。規則が空なら何も付けない", () => {
    const { term, decorations } = fakeTerm(["ERROR warn"]);
    const s = new HighlightScanner(term);
    s.setRules([rule()]);
    s.setRules([rule({ pattern: "warn", color: "yellow" })]);
    expect(decorations[0].dispose).toHaveBeenCalled();
    expect(decorations[1].options).toMatchObject({ x: 6, width: 4 });
    s.setRules([]);
    expect(decorations[1].dispose).toHaveBeenCalled();
    expect(decorations).toHaveLength(2);
  });

  it("スクロールで xterm が捨てたマーカーの記録は、調べる範囲の外でも掃除する", () => {
    const { term, state, markers, decorations } = fakeTerm(["ERROR 1"]);
    const s = new HighlightScanner(term);
    s.setRules([rule()]);
    state.lines.push("ERROR 2");
    state.cursorY = 1;
    s.scanRecent(5);
    expect(decorations).toHaveLength(2);
    // 先頭の行のマーカーが捨てられた。いまは最後の1行だけを調べる。
    markers[0]._disposed = true;
    state.lines.push("ERROR 3");
    state.cursorY = 2;
    s.scanRecent(1);
    expect(decorations[0].dispose).toHaveBeenCalled();
    expect(decorations[1].dispose).not.toHaveBeenCalled();
  });

  it("代替画面（vim など）では何もしない", () => {
    const { term, decorations } = fakeTerm(["ERROR"], { type: "alternate" });
    new HighlightScanner(term).setRules([rule()]);
    expect(decorations).toHaveLength(0);
  });

  it("dispose で装飾を外す", () => {
    const { term, decorations } = fakeTerm(["ERROR"]);
    const s = new HighlightScanner(term);
    s.setRules([rule()]);
    s.dispose();
    expect(decorations[0].dispose).toHaveBeenCalled();
  });
});

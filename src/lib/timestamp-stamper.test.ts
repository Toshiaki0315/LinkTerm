import { describe, expect, it, vi } from "vitest";
import type { Marker } from "./highlight-scanner";
import {
  TimestampStamper,
  formatClock,
  type StampTerm,
} from "./timestamp-stamper";

/** 1文字1セルの偽のバッファ。 */
function fakeTerm(lines: string[], cols = 40, type = "normal") {
  const state = { lines, baseY: 0, cursorY: lines.length - 1, type };
  const markers: Array<Marker & { _line: number; _disposed: boolean }> = [];
  const decorations: Array<{
    options: Record<string, unknown>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const term: StampTerm = {
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
        getLine: (y) => {
          const text = state.lines[y];
          if (text === undefined) return undefined;
          return {
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

/** 新しい行を出力したことにする。 */
const push = (s: ReturnType<typeof fakeTerm>, text: string) => {
  s.state.lines.push(text);
  s.state.cursorY = s.state.lines.length - 1;
};

describe("formatClock", () => {
  it("HH:MM:SS（ゼロ埋め）", () => {
    expect(formatClock(new Date(2024, 0, 2, 3, 4, 5).getTime())).toBe(
      "03:04:05",
    );
    expect(formatClock(new Date(2024, 0, 2, 13, 14, 15).getTime())).toBe(
      "13:14:15",
    );
  });
});

describe("TimestampStamper", () => {
  it("有効にした後に出た行だけに、右端へ時刻を付ける（それ以前の行には付けない）", () => {
    const f = fakeTerm(["old line", "prompt$ "]);
    let now = new Date(2024, 0, 1, 10, 0, 0).getTime();
    const s = new TimestampStamper(f.term, () => now);
    s.setEnabled(true);
    s.scanRecent(10);
    expect(f.decorations).toHaveLength(0);
    now += 5000;
    push(f, "output A");
    s.scanRecent(10);
    expect(f.decorations).toHaveLength(1);
    expect(f.decorations[0].options).toMatchObject({
      anchor: "right",
      x: 0,
      width: 9,
    });
    const el = document.createElement("span");
    (f.decorations[0].options.onRender as (e: HTMLElement) => void)(el);
    expect(el.textContent).toBe("10:00:05");
  });

  it("オンにした時点のカーソル行に、あとから文字が出力されたら、その行にも時刻を付ける（出力のない間は付けない）", () => {
    const f = fakeTerm(["old", "prompt$ "]);
    let now = new Date(2024, 0, 1, 10, 0, 0).getTime();
    const s = new TimestampStamper(f.term, () => now);
    s.setEnabled(true);
    s.scanRecent(10);
    expect(f.decorations).toHaveLength(0);
    // 同じ行に入力のエコーなどが続いた（改行はまだ）。
    now += 3000;
    f.state.lines[1] = "prompt$ ls";
    s.scanRecent(10);
    expect(f.decorations).toHaveLength(1);
    const el = document.createElement("span");
    (f.decorations[0].options.onRender as (e: HTMLElement) => void)(el);
    expect(el.textContent).toBe("10:00:03");
    // その後に改行があっても、同じ行を付け直さない。
    push(f, "output");
    s.scanRecent(10);
    expect(f.decorations).toHaveLength(2);
  });

  it("同じ行を何度調べても、時刻は付け直さない（最初に現れた時刻のまま）", () => {
    const f = fakeTerm(["base"]);
    let now = new Date(2024, 0, 1, 10, 0, 0).getTime();
    const s = new TimestampStamper(f.term, () => now);
    s.setEnabled(true);
    push(f, "line 1");
    s.scanRecent(10);
    now += 60_000;
    s.scanRecent(10);
    s.scanRecent(10);
    expect(f.decorations).toHaveLength(1);
  });

  it("空の行・右端まで文字がある行には付けない", () => {
    const f = fakeTerm(["base"], 30);
    const s = new TimestampStamper(f.term);
    s.setEnabled(true);
    push(f, "");
    push(f, "   ");
    push(f, "x".repeat(25)); // 右端の時刻（9列）と重なる
    push(f, "short");
    s.scanRecent(10);
    expect(f.decorations).toHaveLength(1);
  });

  it("オフにすると、付けた時刻をすべて消す。もう一度オンにしても、過去の行には付けない", () => {
    const f = fakeTerm(["base"]);
    const s = new TimestampStamper(f.term);
    s.setEnabled(true);
    push(f, "a");
    s.scanRecent(10);
    s.setEnabled(false);
    expect(f.decorations[0].dispose).toHaveBeenCalled();
    s.scanRecent(10);
    s.setEnabled(true);
    s.scanRecent(10);
    expect(f.decorations).toHaveLength(1);
    push(f, "b");
    s.scanRecent(10);
    expect(f.decorations).toHaveLength(2);
  });

  it("代替画面（vim など）では付けない", () => {
    const f = fakeTerm(["base"], 40, "alternate");
    const s = new TimestampStamper(f.term);
    s.setEnabled(true);
    push(f, "text");
    s.scanRecent(10);
    expect(f.decorations).toHaveLength(0);
  });

  it("スクロールで行がずれて装飾の位置が合わなくなったら、付け直す", () => {
    const f = fakeTerm(["base"]);
    const s = new TimestampStamper(f.term);
    s.setEnabled(true);
    push(f, "a");
    s.scanRecent(10);
    // マーカーが外れた（行が捨てられた）想定。
    f.markers[1]._disposed = true;
    s.scanRecent(10);
    expect(f.decorations.length).toBeGreaterThan(1);
  });

  it("スクロールで xterm が捨てたマーカーの記録は、調べる範囲の外でも掃除する", () => {
    const f = fakeTerm(["base"]);
    const s = new TimestampStamper(f.term);
    s.setEnabled(true);
    push(f, "a");
    s.scanRecent(10);
    push(f, "b");
    s.scanRecent(10);
    expect(f.decorations).toHaveLength(2);
    // 古い行（a）のマーカーが捨てられた。いまは最後の1行だけを調べる。
    f.markers[1]._disposed = true;
    push(f, "c");
    s.scanRecent(1);
    expect(f.decorations[0].dispose).toHaveBeenCalled();
    expect(f.decorations[1].dispose).not.toHaveBeenCalled();
  });

  it("dispose で、すべて消す", () => {
    const f = fakeTerm(["base"]);
    const s = new TimestampStamper(f.term);
    s.setEnabled(true);
    push(f, "a");
    s.scanRecent(10);
    s.dispose();
    expect(f.decorations[0].dispose).toHaveBeenCalled();
    push(f, "b");
    s.scanRecent(10);
    expect(f.decorations).toHaveLength(1);
  });
});

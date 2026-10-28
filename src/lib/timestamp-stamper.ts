import type { Marker } from "./highlight-scanner";

/** `TimestampStamper` が使う xterm の機能（試験で差し替えられるよう、必要な部分だけ）。 */
export interface StampTerm {
  cols: number;
  buffer: {
    active: {
      type: string;
      baseY: number;
      cursorY: number;
      getLine(y: number):
        | {
            getCell(
              x: number,
            ): { getChars(): string; getWidth(): number } | undefined;
          }
        | undefined;
    };
  };
  registerMarker(cursorYOffset?: number): Marker | undefined;
  registerDecoration(options: {
    marker: Marker;
    anchor: "right";
    x: number;
    width: number;
    onRender: (element: HTMLElement) => void;
  }): { dispose(): void } | undefined;
}

/** 時刻の表示幅（`HH:MM:SS` の 8 列と、余白 1 列）。 */
export const STAMP_WIDTH = 9;
/** 一度に調べる行数の上限。 */
const MAX_SCAN_LINES = 300;
/** 記録を持つ行数の上限。 */
const MAX_RECORDS = 3000;

/** `HH:MM:SS`（ローカル時刻）。 */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

interface Stamp {
  marker: Marker;
  decoration: { dispose(): void };
}

/**
 * 出力された行の右端に、その行が現れた時刻を重ねて表示する（xterm の装飾）。
 * 画面の内容は書き換えないので、全画面のアプリや色の途中にも影響しない。
 * 右端に文字が届く行（時刻と重なる行）には、時刻を付けない。
 */
export class TimestampStamper {
  private enabled = false;
  /** 有効にした時点の位置。これより後の行だけに付ける。 */
  private baseline: Marker | undefined;
  private stamps = new Map<number, Stamp>();

  constructor(
    private readonly term: StampTerm,
    private readonly now: () => number = Date.now,
  ) {}

  /** 表示のオン・オフ。オンにした時点より前の行には付けない。オフにすると、付けた時刻をすべて消す。 */
  setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.baseline = this.term.registerMarker(0);
    } else {
      this.clear();
      this.baseline?.dispose();
      this.baseline = undefined;
    }
  }

  /** 最後の `count` 行（カーソルの行まで）を調べ、新しく文字が現れた行に時刻を付ける。 */
  scanRecent(count: number) {
    const buf = this.term.buffer.active;
    // 代替画面（vim など）では、装飾を付けられない。
    if (!this.enabled || buf.type !== "normal") return;
    const last = buf.baseY + buf.cursorY;
    const base =
      this.baseline && !this.baseline.isDisposed ? this.baseline.line : -1;
    const first = Math.max(
      base + 1,
      last - Math.min(count, MAX_SCAN_LINES) + 1,
      0,
    );
    for (let y = first; y <= last; y += 1) this.stampLine(y, last);
    this.prune(first);
  }

  dispose() {
    this.clear();
    this.baseline?.dispose();
    this.baseline = undefined;
    this.enabled = false;
  }

  private clear() {
    for (const s of this.stamps.values()) {
      s.decoration.dispose();
      s.marker.dispose();
    }
    this.stamps.clear();
  }

  /** この行の、文字のある最後の列（なければ -1）。 */
  private lastUsedColumn(y: number): number {
    const line = this.term.buffer.active.getLine(y);
    if (!line) return -1;
    for (let x = this.term.cols - 1; x >= 0; x -= 1) {
      const cell = line.getCell(x);
      if (cell && cell.getWidth() > 0 && cell.getChars().trim() !== "")
        return x;
    }
    return -1;
  }

  private stampLine(y: number, cursorLine: number) {
    const prev = this.stamps.get(y);
    // すでに付いていて、位置も合っていれば、そのまま。
    if (prev && !prev.marker.isDisposed && prev.marker.line === y) return;
    if (prev) {
      prev.decoration.dispose();
      prev.marker.dispose();
      this.stamps.delete(y);
    }
    const used = this.lastUsedColumn(y);
    // 空の行（まだ何も出ていない）と、右端まで文字がある行には付けない。
    if (used < 0 || used >= this.term.cols - STAMP_WIDTH - 1) return;
    const marker = this.term.registerMarker(y - cursorLine);
    if (!marker) return;
    const text = formatClock(this.now());
    const decoration = this.term.registerDecoration({
      marker,
      anchor: "right",
      x: 0,
      width: STAMP_WIDTH,
      onRender: (el) => {
        el.textContent = text;
        el.style.cssText =
          "color:#9ca3af;text-align:right;pointer-events:none;background:rgba(0,0,0,0.35)";
      },
    });
    if (!decoration) {
      marker.dispose();
      return;
    }
    this.stamps.set(y, { marker, decoration });
  }

  private prune(firstScanned: number) {
    if (this.stamps.size <= MAX_RECORDS) return;
    for (const [y, s] of this.stamps) {
      if (y >= firstScanned) continue;
      s.decoration.dispose();
      s.marker.dispose();
      this.stamps.delete(y);
      if (this.stamps.size <= MAX_RECORDS) break;
    }
  }
}

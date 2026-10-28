import {
  compileRules,
  findMatches,
  highlightColors,
  lineFromCells,
  toColumns,
  type Cell,
  type CompiledRule,
  type HighlightRule,
} from "./highlight";

/** `HighlightScanner` が使う xterm の機能（試験で差し替えられるよう、必要な部分だけ）。 */
export interface ScanTerm {
  cols: number;
  buffer: {
    active: {
      type: string;
      baseY: number;
      cursorY: number;
      length: number;
      getLine(y: number):
        | {
            isWrapped: boolean;
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
    x: number;
    width: number;
    backgroundColor: string;
    foregroundColor: string;
  }): { dispose(): void } | undefined;
}

export interface Marker {
  readonly line: number;
  readonly isDisposed: boolean;
  dispose(): void;
}

interface LineRecord {
  text: string;
  markers: Marker[];
  decorations: Array<{ dispose(): void }>;
}

/** 一度に調べる行数の上限（大量の出力でも、最後の部分だけ見る）。 */
const MAX_SCAN_LINES = 300;
/** 強調を付けた行の記録を持つ数の上限。 */
const MAX_RECORDS = 3000;

/**
 * 端末の画面（バッファ）にある文字列を調べ、規則に一致した部分に色を付ける（xterm の装飾）。
 * 出力の流れは書き換えないので、色や制御文字の途中に影響しない。
 */
export class HighlightScanner {
  private compiled: CompiledRule[] = [];
  /** 行番号（バッファ内）→ その行に付けた装飾。 */
  private records = new Map<number, LineRecord>();

  constructor(private readonly term: ScanTerm) {}

  /** 規則を入れ替える。付けていた強調は外し、最近の行を調べ直す。 */
  setRules(rules: HighlightRule[]) {
    this.compiled = compileRules(rules);
    this.clear();
    this.scanRecent(MAX_SCAN_LINES);
  }

  /** 最後の `count` 行（カーソルの行まで）を調べる。 */
  scanRecent(count: number) {
    const buf = this.term.buffer.active;
    // 代替画面（vim など）では、装飾を付けられない。
    if (buf.type !== "normal" || this.compiled.length === 0) return;
    const last = buf.baseY + buf.cursorY;
    const first = Math.max(0, last - Math.min(count, MAX_SCAN_LINES) + 1);
    for (let y = first; y <= last; y += 1) this.scanLine(y, last);
    this.prune(first);
  }

  dispose() {
    this.clear();
  }

  private clear() {
    for (const record of this.records.values()) this.release(record);
    this.records.clear();
  }

  private release(record: LineRecord) {
    for (const d of record.decorations) d.dispose();
    for (const m of record.markers) m.dispose();
  }

  private scanLine(y: number, cursorLine: number) {
    const line = this.term.buffer.active.getLine(y);
    if (!line) return;
    const cells: Cell[] = [];
    for (let x = 0; x < this.term.cols; x += 1) {
      const cell = line.getCell(x);
      cells.push(
        cell
          ? { chars: cell.getChars(), width: cell.getWidth() }
          : { chars: "", width: 1 },
      );
    }
    const { text, columns } = lineFromCells(cells);
    const prev = this.records.get(y);
    // 内容が変わらず、装飾もこの行に付いたままなら、そのまま。
    if (
      prev &&
      prev.text === text &&
      prev.markers.every((m) => !m.isDisposed && m.line === y)
    ) {
      return;
    }
    if (prev) {
      this.release(prev);
      this.records.delete(y);
    }
    const matches = findMatches(text, this.compiled);
    if (matches.length === 0) return;
    const record: LineRecord = { text, markers: [], decorations: [] };
    for (const match of matches) {
      const marker = this.term.registerMarker(y - cursorLine);
      if (!marker) continue;
      const { x, width } = toColumns(match, columns);
      const { background, foreground } = highlightColors(match.rule.color);
      const decoration = this.term.registerDecoration({
        marker,
        x,
        width,
        backgroundColor: background,
        foregroundColor: foreground,
      });
      record.markers.push(marker);
      if (decoration) record.decorations.push(decoration);
    }
    this.records.set(y, record);
  }

  /** 古い記録（調べた範囲より前）を、多すぎるときに捨てる。 */
  private prune(firstScanned: number) {
    if (this.records.size <= MAX_RECORDS) return;
    for (const [y, record] of this.records) {
      if (y >= firstScanned) continue;
      this.release(record);
      this.records.delete(y);
      if (this.records.size <= MAX_RECORDS) break;
    }
  }
}

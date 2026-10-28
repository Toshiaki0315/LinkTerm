/**
 * 画面の走査の要求をまとめる。最初の要求はすぐ実行し、`intervalMs` 以内に続いた要求は、
 * 間隔が空いてから 1 回にまとめて実行する（行数は合計）。大量の出力で、走査が詰まらないようにする。
 */
export class ScanBatcher {
  private pending = 0;
  private lastRun = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly run: (lines: number) => void,
    private readonly intervalMs = 50,
    private readonly now: () => number = Date.now,
  ) {}

  /** `lines` 行ぶんの新しい出力があった。 */
  request(lines: number) {
    if (this.disposed) return;
    this.pending += lines;
    if (this.timer !== null) return;
    const wait = this.lastRun + this.intervalMs - this.now();
    if (wait <= 0) this.flush();
    else this.timer = setTimeout(() => this.flush(), wait);
  }

  dispose() {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = 0;
  }

  private flush() {
    this.timer = null;
    if (this.disposed || this.pending === 0) return;
    const lines = this.pending;
    this.pending = 0;
    this.lastRun = this.now();
    this.run(lines);
  }
}

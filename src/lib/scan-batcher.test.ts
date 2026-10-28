import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScanBatcher } from "./scan-batcher";

describe("ScanBatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("最初の要求はすぐ実行し、間隔内の続きは1回にまとめて、間隔が空いてから実行する（行数は合計）", () => {
    const run = vi.fn();
    const b = new ScanBatcher(run, 50);
    b.request(3);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenLastCalledWith(3);
    b.request(2);
    b.request(4);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(49);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(6);
  });

  it("間隔が空いたあとの要求は、またすぐ実行する", () => {
    const run = vi.fn();
    const b = new ScanBatcher(run, 50);
    b.request(1);
    vi.advanceTimersByTime(100);
    b.request(2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(2);
  });

  it("まとめた実行のあとも、間隔を保つ（連続出力で、1間隔に1回まで）", () => {
    const run = vi.fn();
    const b = new ScanBatcher(run, 50);
    for (let t = 0; t < 500; t += 5) {
      b.request(1);
      vi.advanceTimersByTime(5);
    }
    // 500ms の連続出力で、約 10 回（先頭の即時 + 50ms ごと）。
    expect(run.mock.calls.length).toBeLessThanOrEqual(11);
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(9);
    const total = run.mock.calls.reduce((n, c) => n + (c[0] as number), 0);
    vi.advanceTimersByTime(100);
    const final = run.mock.calls.reduce((n, c) => n + (c[0] as number), 0);
    expect(final).toBe(100); // 100 回の要求（1 行ずつ）が、取りこぼしなく届く
    expect(total).toBeLessThanOrEqual(final);
  });

  it("dispose すると、待っている分を実行しない。その後の要求も無視する", () => {
    const run = vi.fn();
    const b = new ScanBatcher(run, 50);
    b.request(1);
    b.request(2);
    b.dispose();
    vi.advanceTimersByTime(200);
    b.request(3);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

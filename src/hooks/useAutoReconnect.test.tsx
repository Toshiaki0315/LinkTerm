import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "./useTerminalSession";
import { STABLE_CONNECTION_MS, useAutoReconnect } from "./useAutoReconnect";

interface Props {
  enabled: boolean;
  delaySeconds: number;
  maxAttempts: number;
  status: SessionStatus;
  canReconnect: boolean;
}

const base: Props = {
  enabled: true,
  delaySeconds: 3,
  maxAttempts: 2,
  status: "connected",
  canReconnect: true,
};

/** 状態を順に変えながら検証するための小さな補助。 */
function harness(initial: Partial<Props> = {}) {
  const onReconnect = vi.fn();
  let props: Props = { ...base, ...initial };
  const hook = renderHook(
    (p: Props) => useAutoReconnect({ ...p, onReconnect }),
    {
      initialProps: props,
    },
  );
  const set = (next: Partial<Props>) => {
    props = { ...props, ...next };
    hook.rerender(props);
  };
  const tick = (seconds: number) =>
    act(() => vi.advanceTimersByTime(seconds * 1000));
  return { hook, onReconnect, set, tick };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useAutoReconnect", () => {
  it("無効なら、エラーになっても何もしない", () => {
    const { hook, onReconnect, set, tick } = harness({ enabled: false });
    set({ status: "error" });
    expect(hook.result.current.remaining).toBeNull();
    tick(60);
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("エラーになると待ち時間から1秒ずつ減らし、0 になったら再接続する", () => {
    const { hook, onReconnect, set, tick } = harness();
    set({ status: "error" });
    expect(hook.result.current.remaining).toBe(3);
    tick(1);
    expect(hook.result.current.remaining).toBe(2);
    tick(1);
    expect(hook.result.current.remaining).toBe(1);
    expect(onReconnect).not.toHaveBeenCalled();
    tick(1);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("正常な終了（closed）では再接続しない", () => {
    const { hook, onReconnect, set, tick } = harness();
    set({ status: "closed" });
    expect(hook.result.current.remaining).toBeNull();
    tick(60);
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("接続中・接続済みの間は、カウントダウンしない", () => {
    const { hook, set, tick } = harness();
    set({ status: "connecting" });
    expect(hook.result.current.remaining).toBeNull();
    tick(10);
    set({ status: "connected" });
    expect(hook.result.current.remaining).toBeNull();
  });

  it("再接続できない接続（パスワードが必要など）は、カウントダウンしない", () => {
    const { hook, onReconnect, set, tick } = harness({ canReconnect: false });
    set({ status: "error" });
    expect(hook.result.current.remaining).toBeNull();
    tick(60);
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("キャンセルすると、その切断については再接続しない。次の接続からはまた有効", () => {
    const { hook, onReconnect, set, tick } = harness();
    set({ status: "error" });
    tick(1);
    act(() => hook.result.current.cancel());
    expect(hook.result.current.remaining).toBeNull();
    tick(60);
    expect(onReconnect).not.toHaveBeenCalled();

    // 手動で再接続して、また切れたら、再び自動再接続の対象になる。
    set({ status: "connecting" });
    set({ status: "connected" });
    set({ status: "error" });
    expect(hook.result.current.remaining).toBe(3);
  });

  it("再接続に失敗し続けたら、上限の回数で止まる（上限に達したことを知らせる）", () => {
    const { hook, onReconnect, set, tick } = harness({ maxAttempts: 2 });
    set({ status: "error" });
    tick(3);
    expect(onReconnect).toHaveBeenCalledTimes(1);
    set({ status: "connecting" });
    set({ status: "error" });
    expect(hook.result.current.attempt).toBe(1);
    tick(3);
    expect(onReconnect).toHaveBeenCalledTimes(2);
    set({ status: "connecting" });
    set({ status: "error" });
    expect(hook.result.current.exhausted).toBe(true);
    expect(hook.result.current.remaining).toBeNull();
    tick(60);
    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  it("上限が 0 なら無制限", () => {
    const { hook, onReconnect, set, tick } = harness({
      maxAttempts: 0,
      delaySeconds: 1,
    });
    for (let i = 0; i < 8; i++) {
      set({ status: "error" });
      tick(1);
      set({ status: "connecting" });
    }
    expect(onReconnect).toHaveBeenCalledTimes(8);
    set({ status: "error" });
    expect(hook.result.current.exhausted).toBe(false);
  });

  it("安定して接続できていたら、試行回数を数え直す（直後に切れた場合は数え直さない）", () => {
    const { hook, onReconnect, set, tick } = harness({ maxAttempts: 2 });
    set({ status: "error" });
    tick(3);
    set({ status: "connecting" });
    set({ status: "connected" });
    tick(STABLE_CONNECTION_MS / 1000 - 1); // まだ安定とみなさない
    set({ status: "error" });
    expect(hook.result.current.attempt).toBe(1);
    tick(3);
    set({ status: "connecting" });
    set({ status: "connected" });
    tick(STABLE_CONNECTION_MS / 1000); // 安定した
    expect(hook.result.current.attempt).toBe(0);
    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  it("アンマウントするとタイマーを止める", () => {
    const { hook, onReconnect, set, tick } = harness();
    set({ status: "error" });
    hook.unmount();
    tick(60);
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("無効にすると、カウントダウンを止める", () => {
    const { hook, onReconnect, set, tick } = harness();
    set({ status: "error" });
    tick(1);
    set({ enabled: false });
    expect(hook.result.current.remaining).toBeNull();
    tick(60);
    expect(onReconnect).not.toHaveBeenCalled();
  });
});

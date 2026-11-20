import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  setControlSignal: vi.fn(),
  sendBreak: vi.fn(),
  setDisplayMode: vi.fn(),
}));
vi.mock("../lib/terminal-api", () => api);

import { useSerialControl } from "./useSerialControl";

beforeEach(() => {
  vi.clearAllMocks();
  api.setControlSignal.mockResolvedValue(undefined);
  api.sendBreak.mockResolvedValue(undefined);
  api.setDisplayMode.mockResolvedValue(undefined);
});

describe("useSerialControl", () => {
  it("DTR / RTS は初期状態でオン、HEX 表示はオフ", () => {
    const { result } = renderHook(() => useSerialControl("s1"));
    expect(result.current.signals).toEqual({ dtr: true, rts: true });
    expect(result.current.hex).toBe(false);
    expect(result.current.disabled).toBe(false);
  });

  it("DTR / RTS を切り替えると、設定してから状態を更新する", async () => {
    const { result } = renderHook(() => useSerialControl("s1"));
    await act(() => result.current.toggleSignal("dtr"));
    expect(api.setControlSignal).toHaveBeenCalledWith("s1", "dtr", false);
    expect(result.current.signals.dtr).toBe(false);
    await act(() => result.current.toggleSignal("dtr"));
    expect(api.setControlSignal).toHaveBeenLastCalledWith("s1", "dtr", true);
    await act(() => result.current.toggleSignal("rts"));
    expect(api.setControlSignal).toHaveBeenLastCalledWith("s1", "rts", false);
  });

  it("設定に失敗したら、状態は変えずに理由を出す", async () => {
    api.setControlSignal.mockRejectedValue("この接続では使えない操作です");
    const { result } = renderHook(() => useSerialControl("s1"));
    await act(() => result.current.toggleSignal("rts"));
    expect(result.current.error).toContain("この接続では使えない操作です");
    expect(result.current.signals.rts).toBe(true);
  });

  it("ブレークを送る（送信中は breaking）", async () => {
    let finish!: () => void;
    api.sendBreak.mockReturnValue(new Promise<void>((r) => (finish = r)));
    const { result } = renderHook(() => useSerialControl("s1"));
    let done!: Promise<void>;
    act(() => {
      done = result.current.doBreak();
    });
    expect(api.sendBreak).toHaveBeenCalledWith("s1");
    expect(result.current.breaking).toBe(true);
    await act(async () => {
      finish();
      await done;
    });
    expect(result.current.breaking).toBe(false);
  });

  it("ブレーク送信の失敗を出す", async () => {
    api.sendBreak.mockRejectedValue("ブレークを送れません");
    const { result } = renderHook(() => useSerialControl("s1"));
    await act(() => result.current.doBreak());
    expect(result.current.error).toContain("ブレークを送れません");
    expect(result.current.breaking).toBe(false);
  });

  it("HEX 表示を切り替える", async () => {
    const { result } = renderHook(() => useSerialControl("s1"));
    await act(() => result.current.toggleHex());
    expect(api.setDisplayMode).toHaveBeenCalledWith("s1", "hex");
    expect(result.current.hex).toBe(true);
    await act(() => result.current.toggleHex());
    expect(api.setDisplayMode).toHaveBeenLastCalledWith("s1", "text");
    expect(result.current.hex).toBe(false);
  });

  it("接続していない間は操作できない（何も呼ばない）", async () => {
    const { result } = renderHook(() => useSerialControl(null));
    expect(result.current.disabled).toBe(true);
    await act(async () => {
      await result.current.toggleSignal("dtr");
      await result.current.doBreak();
      await result.current.toggleHex();
    });
    expect(api.setControlSignal).not.toHaveBeenCalled();
    expect(api.sendBreak).not.toHaveBeenCalled();
    expect(api.setDisplayMode).not.toHaveBeenCalled();
  });

  it("セッションが変わったら（再接続）、状態を初期値に戻す", async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useSerialControl(id),
      { initialProps: { id: "s1" as string | null } },
    );
    await act(() => result.current.toggleSignal("dtr"));
    await act(() => result.current.toggleHex());
    expect(result.current.signals.dtr).toBe(false);
    rerender({ id: "s2" });
    expect(result.current.signals).toEqual({ dtr: true, rts: true });
    expect(result.current.hex).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("エラー表示を閉じられる", async () => {
    api.sendBreak.mockRejectedValue("x");
    const { result } = renderHook(() => useSerialControl("s1"));
    await act(() => result.current.doBreak());
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });
});

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  startSessionLog: vi.fn(),
  stopSessionLog: vi.fn(),
  defaultLogPath: vi.fn(),
  onLogError: vi.fn(),
}));
vi.mock("../lib/terminal-api", () => api);

import { useLogControl } from "./useLogControl";

let emitError: (id: string, message: string) => void;
const config = {
  path: "/logs/a.log",
  mode: "Text" as const,
  timestamps: false,
  append: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.startSessionLog.mockResolvedValue(undefined);
  api.stopSessionLog.mockResolvedValue(undefined);
  api.defaultLogPath.mockResolvedValue("/logs/default.log");
  api.onLogError.mockImplementation(async (cb) => {
    emitError = cb;
    return () => {};
  });
});

const setup = (sessionId: string | null = "s1", title = "alice@h") =>
  renderHook(() => useLogControl({ sessionId, title }));

describe("useLogControl", () => {
  it("開く: 既定のパスを取って、ダイアログの初期値にする", async () => {
    const { result } = setup();
    expect(result.current.dialogPath).toBeNull();
    await act(() => result.current.openDialog());
    expect(api.defaultLogPath).toHaveBeenCalledWith("alice@h");
    expect(result.current.dialogPath).toBe("/logs/default.log");
    act(() => result.current.closeDialog());
    expect(result.current.dialogPath).toBeNull();
  });

  it("既定パスの取得に失敗しても、空の初期値で開ける（手入力で開始できる）", async () => {
    api.defaultLogPath.mockRejectedValue("取得失敗");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = setup();
    await act(() => result.current.openDialog());
    expect(result.current.dialogPath).toBe("");
    errors.mockRestore();
  });

  it("開始すると記録中になり、停止すると戻る", async () => {
    const { result } = setup();
    expect(result.current.logging).toBe(false);
    await act(() => result.current.start(config));
    expect(api.startSessionLog).toHaveBeenCalledWith("s1", config);
    expect(result.current.logging).toBe(true);
    await act(() => result.current.stop());
    expect(api.stopSessionLog).toHaveBeenCalledWith("s1");
    expect(result.current.logging).toBe(false);
  });

  it("セッションがなければ開始できない", async () => {
    const { result } = setup(null);
    await expect(result.current.start(config)).rejects.toThrow(
      "セッションが確立していません",
    );
    expect(api.startSessionLog).not.toHaveBeenCalled();
  });

  it("開始コマンドが失敗したら、記録中にせず、呼び出し元（ダイアログ）へ理由を返す", async () => {
    api.startSessionLog.mockRejectedValue("切り詰めに失敗しました");
    const { result } = setup();
    await act(async () => {
      await expect(result.current.start(config)).rejects.toBe(
        "切り詰めに失敗しました",
      );
    });
    expect(result.current.logging).toBe(false);
  });

  it("停止に失敗したら、記録中のまま、理由を表示する", async () => {
    const { result } = setup();
    await act(() => result.current.start(config));
    api.stopSessionLog.mockRejectedValue(new Error("止められません"));
    await act(() => result.current.stop());
    expect(result.current.logging).toBe(true);
    expect(result.current.error).toContain("止められません");
  });

  it("書き込みエラーを受けたら、記録中を戻し、メッセージを出す（ほかのセッションのエラーは無視）", async () => {
    const { result } = setup();
    await act(() => result.current.start(config));
    await waitFor(() => expect(api.onLogError).toHaveBeenCalled());
    act(() => emitError("other", "ignored"));
    expect(result.current.logging).toBe(true);
    expect(result.current.error).toBeNull();
    act(() => emitError("s1", "disk full"));
    expect(result.current.logging).toBe(false);
    expect(result.current.error).toContain("disk full");
  });

  it("開始の応答より先に失敗イベントが届いても、記録中で上書きしない", async () => {
    api.startSessionLog.mockImplementation(async () => {
      emitError("s1", "切り詰めに失敗しました");
    });
    const { result } = setup();
    await waitFor(() => expect(api.onLogError).toHaveBeenCalled());
    await act(() => result.current.start(config));
    expect(result.current.logging).toBe(false);
    expect(result.current.error).toContain("切り詰めに失敗しました");
  });

  it("開くとき、前のエラー表示を消す", async () => {
    const { result } = setup();
    await waitFor(() => expect(api.onLogError).toHaveBeenCalled());
    act(() => emitError("s1", "disk full"));
    expect(result.current.error).not.toBeNull();
    await act(() => result.current.openDialog());
    expect(result.current.error).toBeNull();
  });

  it("エラー表示を閉じられる", async () => {
    const { result } = setup();
    await waitFor(() => expect(api.onLogError).toHaveBeenCalled());
    act(() => emitError("s1", "x"));
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });
});

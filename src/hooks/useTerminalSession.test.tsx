import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type DataCb = (id: string, data: Uint8Array) => void;
type ClosedCb = (id: string, reason: string | null) => void;

const api = vi.hoisted(() => ({
  startSession: vi.fn(),
  writeToSession: vi.fn(),
  resizeSession: vi.fn(),
  closeSession: vi.fn(),
  onTerminalData: vi.fn(),
  onTerminalClosed: vi.fn(),
  onTerminalEcho: vi.fn(),
}));
vi.mock("../lib/terminal-api", () => api);

import { useTerminalSession } from "./useTerminalSession";

let emitData: DataCb;
let emitClosed: ClosedCb;
let emitEcho: (id: string, remote: boolean) => void;
const unlistenEcho = vi.fn();
const unlistenData = vi.fn();
const unlistenClosed = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  api.onTerminalData.mockImplementation(async (cb: DataCb) => {
    emitData = cb;
    return unlistenData;
  });
  api.onTerminalClosed.mockImplementation(async (cb: ClosedCb) => {
    emitClosed = cb;
    return unlistenClosed;
  });
  api.onTerminalEcho.mockImplementation(
    async (cb: (id: string, r: boolean) => void) => {
      emitEcho = cb;
      return unlistenEcho;
    },
  );
  api.writeToSession.mockResolvedValue(undefined);
  api.resizeSession.mockResolvedValue(undefined);
  api.closeSession.mockResolvedValue(undefined);
});

const LOCAL = { type: "local", cols: 80, rows: 24 } as const;
const bytes = (s: string) => new TextEncoder().encode(s);

async function setup(onData = vi.fn()) {
  const hook = renderHook(() => useTerminalSession({ onData }));
  await waitFor(() => expect(api.onTerminalClosed).toHaveBeenCalled());
  return { ...hook, onData };
}

describe("useTerminalSession", () => {
  it("初期状態は idle", async () => {
    const { result } = await setup();
    expect(result.current.status).toBe("idle");
    expect(result.current.sessionId).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("start で connecting を経て connected になる", async () => {
    let resolve!: (id: string) => void;
    api.startSession.mockReturnValue(new Promise<string>((r) => (resolve = r)));
    const { result } = await setup();
    let p!: Promise<void>;
    act(() => {
      p = result.current.start(LOCAL);
    });
    expect(result.current.status).toBe("connecting");
    await act(async () => {
      resolve("session-1");
      await p;
    });
    expect(result.current.status).toBe("connected");
    expect(result.current.sessionId).toBe("session-1");
    expect(api.startSession).toHaveBeenCalledWith(LOCAL);
  });

  it("start 失敗で error とメッセージを保持する", async () => {
    api.startSession.mockRejectedValue("接続に失敗しました");
    const { result } = await setup();
    await act(async () => {
      await result.current.start(LOCAL);
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("接続に失敗しました");
    expect(result.current.sessionId).toBeNull();
  });

  it("自分のセッションの出力だけ onData に渡す", async () => {
    api.startSession.mockResolvedValue("s1");
    const { result, onData } = await setup();
    await act(async () => {
      await result.current.start(LOCAL);
    });
    act(() => {
      emitData("s1", bytes("mine"));
      emitData("other", bytes("theirs"));
    });
    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenCalledWith(bytes("mine"));
  });

  it("start 完了前に届いた出力も取りこぼさない", async () => {
    let resolve!: (id: string) => void;
    api.startSession.mockReturnValue(new Promise<string>((r) => (resolve = r)));
    const { result, onData } = await setup();
    let p!: Promise<void>;
    act(() => {
      p = result.current.start(LOCAL);
    });
    act(() => {
      emitData("s1", bytes("early"));
    });
    expect(onData).not.toHaveBeenCalled();
    await act(async () => {
      resolve("s1");
      await p;
    });
    expect(onData).toHaveBeenCalledWith(bytes("early"));
  });

  it("closed イベントで closed になる（理由があれば error 扱い）", async () => {
    api.startSession.mockResolvedValue("s1");
    const { result } = await setup();
    await act(async () => {
      await result.current.start(LOCAL);
    });
    act(() => emitClosed("s1", null));
    expect(result.current.status).toBe("closed");
    expect(result.current.error).toBeNull();

    api.startSession.mockResolvedValue("s2");
    await act(async () => {
      await result.current.start(LOCAL);
    });
    act(() => emitClosed("s2", "USB抜去"));
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("USB抜去");
  });

  it("他セッションの closed は無視する", async () => {
    api.startSession.mockResolvedValue("s1");
    const { result } = await setup();
    await act(async () => {
      await result.current.start(LOCAL);
    });
    act(() => emitClosed("other", null));
    expect(result.current.status).toBe("connected");
  });

  it("write / resize は接続中のみ送信する", async () => {
    api.startSession.mockResolvedValue("s1");
    const { result } = await setup();
    await act(async () => {
      await result.current.write("x");
      await result.current.resize(10, 10);
    });
    expect(api.writeToSession).not.toHaveBeenCalled();
    expect(api.resizeSession).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.start(LOCAL);
    });
    await act(async () => {
      await result.current.write("ls\r");
      await result.current.resize(120, 40);
    });
    expect(api.writeToSession).toHaveBeenCalledWith("s1", "ls\r");
    expect(api.resizeSession).toHaveBeenCalledWith("s1", 120, 40);
  });

  it("write 失敗は error 状態にせず握りつぶさず reject する", async () => {
    api.startSession.mockResolvedValue("s1");
    api.writeToSession.mockRejectedValue("送信失敗");
    const { result } = await setup();
    await act(async () => {
      await result.current.start(LOCAL);
    });
    await expect(result.current.write("x")).rejects.toBe("送信失敗");
  });

  it("close でセッションを閉じて closed になる", async () => {
    api.startSession.mockResolvedValue("s1");
    const { result } = await setup();
    await act(async () => {
      await result.current.start(LOCAL);
    });
    await act(async () => {
      await result.current.close();
    });
    expect(api.closeSession).toHaveBeenCalledWith("s1");
    expect(result.current.status).toBe("closed");
  });

  it("アンマウントでリスナーを解除する", async () => {
    const { unmount } = await setup();
    await waitFor(() => expect(api.onTerminalData).toHaveBeenCalled());
    unmount();
    await waitFor(() => {
      expect(unlistenData).toHaveBeenCalled();
      expect(unlistenClosed).toHaveBeenCalled();
    });
  });

  it("アンマウント時に接続中のセッションを閉じる", async () => {
    api.startSession.mockResolvedValue("s1");
    const { result, unmount } = await setup();
    await act(async () => {
      await result.current.start(LOCAL);
    });
    unmount();
    expect(api.closeSession).toHaveBeenCalledWith("s1");
  });

  it("start 完了前にアンマウントされたら、確立したセッションを閉じる", async () => {
    let resolve!: (id: string) => void;
    api.startSession.mockReturnValue(new Promise<string>((r) => (resolve = r)));
    const { result, unmount } = await setup();
    let p!: Promise<void>;
    act(() => {
      p = result.current.start(LOCAL);
    });
    unmount();
    await act(async () => {
      resolve("late");
      await p;
    });
    expect(api.closeSession).toHaveBeenCalledWith("late");
  });

  it("close 済みのセッションはアンマウントで二重に閉じない", async () => {
    api.startSession.mockResolvedValue("s1");
    const { result, unmount } = await setup();
    await act(async () => {
      await result.current.start(LOCAL);
    });
    await act(async () => {
      await result.current.close();
    });
    unmount();
    expect(api.closeSession).toHaveBeenCalledTimes(1);
  });

  describe("接続先のエコー状態", () => {
    it("接続前は null、自分のセッションの通知で更新される", async () => {
      api.startSession.mockResolvedValue("s1");
      const { result } = await setup();
      expect(result.current.remoteEcho).toBeNull();
      await act(async () => {
        await result.current.start(LOCAL);
      });
      expect(result.current.remoteEcho).toBeNull();
      act(() => emitEcho("s1", false));
      expect(result.current.remoteEcho).toBe(false);
      act(() => emitEcho("s1", true));
      expect(result.current.remoteEcho).toBe(true);
    });

    it("他のセッションの通知は無視する", async () => {
      api.startSession.mockResolvedValue("s1");
      const { result } = await setup();
      await act(async () => {
        await result.current.start(LOCAL);
      });
      act(() => emitEcho("other", true));
      expect(result.current.remoteEcho).toBeNull();
    });

    it("start 完了前に届いた通知も取りこぼさない", async () => {
      let resolve!: (id: string) => void;
      api.startSession.mockReturnValue(
        new Promise<string>((r) => (resolve = r)),
      );
      const { result } = await setup();
      let p!: Promise<void>;
      act(() => {
        p = result.current.start(LOCAL);
      });
      act(() => emitEcho("s1", true));
      await act(async () => {
        resolve("s1");
        await p;
      });
      expect(result.current.remoteEcho).toBe(true);
    });

    it("再接続（start のやり直し）で null に戻る", async () => {
      api.startSession.mockResolvedValue("s1");
      const { result } = await setup();
      await act(async () => {
        await result.current.start(LOCAL);
      });
      act(() => emitEcho("s1", true));
      api.startSession.mockResolvedValue("s2");
      await act(async () => {
        await result.current.start(LOCAL);
      });
      expect(result.current.remoteEcho).toBeNull();
    });

    it("アンマウントでリスナーを解除する", async () => {
      const { unmount } = await setup();
      await waitFor(() => expect(api.onTerminalEcho).toHaveBeenCalled());
      unmount();
      await waitFor(() => expect(unlistenEcho).toHaveBeenCalled());
    });
  });
});

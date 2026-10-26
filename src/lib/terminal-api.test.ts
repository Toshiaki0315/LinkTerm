import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const listen = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...a: unknown[]) => listen(...a),
}));

import {
  closeSession,
  decodeBase64,
  defaultLogPath,
  onLogError,
  pendingHostKeyRequests,
  startSessionLog,
  stopSessionLog,
  onTerminalClosed,
  onTerminalData,
  respondHostKey,
  resizeSession,
  startSession,
  writeToSession,
} from "./terminal-api";

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
});

describe("decodeBase64", () => {
  it("バイナリを復元する", () => {
    expect(Array.from(decodeBase64("AP9h"))).toEqual([0, 255, 97]);
    expect(decodeBase64("").length).toBe(0);
  });
});

describe("startSession", () => {
  it("local は start_local_shell を呼ぶ", async () => {
    invoke.mockResolvedValue("session-1");
    await expect(
      startSession({ type: "local", cols: 80, rows: 24 }),
    ).resolves.toBe("session-1");
    expect(invoke).toHaveBeenCalledWith("start_local_shell", {
      req: { cols: 80, rows: 24 },
    });
  });

  it("ssh は type を除いたリクエストを渡す", async () => {
    invoke.mockResolvedValue("s");
    await startSession({
      type: "ssh",
      host: "h",
      port: 22,
      username: "u",
      auth: { kind: "agent" },
      cols: 80,
      rows: 24,
    });
    const [cmd, args] = invoke.mock.calls[0];
    expect(cmd).toBe("start_ssh");
    expect(args.req).not.toHaveProperty("type");
    expect(args.req.auth).toEqual({ kind: "agent" });
  });

  it("serial は config を渡す", async () => {
    invoke.mockResolvedValue("s");
    const config = {
      port: "/dev/x",
      baud_rate: 115200,
      data_bits: "Eight",
      parity: "None",
      stop_bits: "One",
      flow_control: "None",
    } as const;
    await startSession({ type: "serial", config, encoding: "EUC-JP" });
    expect(invoke).toHaveBeenCalledWith("start_serial", {
      config,
      encoding: "EUC-JP",
    });
  });
});

describe("コマンド", () => {
  it("write / resize / close / respondHostKey", async () => {
    invoke.mockResolvedValue(undefined);
    await writeToSession("a", "ls\r");
    await resizeSession("a", 100, 30);
    await closeSession("a");
    await respondHostKey("r1", true);
    expect(invoke.mock.calls).toEqual([
      ["terminal_write", { id: "a", data: "ls\r" }],
      ["terminal_resize", { id: "a", cols: 100, rows: 30 }],
      ["terminal_close", { id: "a" }],
      ["respond_host_key", { requestId: "r1", approved: true }],
    ]);
  });
});

describe("イベント", () => {
  it("terminal-data を base64 デコードして渡す", async () => {
    listen.mockImplementation(async (_name, handler) => {
      handler({ payload: { id: "a", data: "AP9h" } });
      return () => {};
    });
    const cb = vi.fn();
    await onTerminalData(cb);
    expect(listen.mock.calls[0][0]).toBe("terminal-data");
    expect(cb).toHaveBeenCalledWith("a", new Uint8Array([0, 255, 97]));
  });

  it("terminal-closed を渡す", async () => {
    listen.mockImplementation(async (_name, handler) => {
      handler({ payload: { id: "a", reason: "boom" } });
      return () => {};
    });
    const cb = vi.fn();
    await onTerminalClosed(cb);
    expect(cb).toHaveBeenCalledWith("a", "boom");
  });
});

describe("ログ", () => {
  it("start / stop / defaultLogPath", async () => {
    invoke.mockResolvedValue(undefined);
    const config = {
      path: "/tmp/a.log",
      mode: "Text",
      timestamps: true,
      append: false,
    } as const;
    await startSessionLog("a", config);
    await stopSessionLog("a");
    invoke.mockResolvedValueOnce("/logs/x.log");
    await expect(defaultLogPath("alice@h")).resolves.toBe("/logs/x.log");
    expect(invoke.mock.calls).toEqual([
      ["start_session_log", { id: "a", config }],
      ["stop_session_log", { id: "a" }],
      ["default_log_path", { title: "alice@h" }],
    ]);
  });

  it("terminal-log-error を渡す", async () => {
    listen.mockImplementation(async (_name, handler) => {
      handler({ payload: { id: "a", message: "disk full" } });
      return () => {};
    });
    const cb = vi.fn();
    await onLogError(cb);
    expect(listen.mock.calls[0][0]).toBe("terminal-log-error");
    expect(cb).toHaveBeenCalledWith("a", "disk full");
  });
});

describe("未応答のホスト鍵承認要求", () => {
  it("pending_host_key_requests を呼ぶ", async () => {
    const req = {
      requestId: "r1",
      host: "h",
      port: 22,
      fingerprint: "SHA256:x",
    };
    invoke.mockResolvedValue([req]);
    await expect(pendingHostKeyRequests()).resolves.toEqual([req]);
    expect(invoke).toHaveBeenCalledWith("pending_host_key_requests");
  });
});

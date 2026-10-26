import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionValues } from "../lib/connection-schema";

const session = vi.hoisted(() => ({
  state: {
    status: "connecting",
    sessionId: null as string | null,
    error: null as string | null,
  },
  start: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  close: vi.fn(),
}));
vi.mock("../hooks/useTerminalSession", () => ({
  useTerminalSession: () => ({
    ...session.state,
    start: session.start,
    write: session.write,
    resize: session.resize,
    close: session.close,
  }),
}));
const termWrite = vi.hoisted(() => vi.fn());
vi.mock("./TerminalView", async () => {
  const React = await import("react");
  return {
    TerminalView: React.forwardRef(
      (_props: unknown, ref: React.Ref<unknown>) => {
        React.useImperativeHandle(ref, () => ({
          write: termWrite,
          size: () => ({ cols: 100, rows: 30 }),
          focus: () => {},
        }));
        return <div data-testid="term" />;
      },
    ),
  };
});
vi.mock("./LogControl", () => ({ LogControl: () => null }));

import { TerminalTab } from "./TerminalTab";

const telnet: ConnectionValues = {
  type: "telnet",
  encoding: "UTF-8",
  host: "h",
  port: 23,
  txNewline: "Cr",
  rxNewline: "Raw",
};
const sshPassword: ConnectionValues = {
  type: "ssh",
  encoding: "UTF-8",
  host: "h",
  port: 22,
  username: "u",
  authKind: "password",
  password: "pw",
  remember: false,
  keyPath: "",
  passphrase: "",
};

function setup(values: ConnectionValues) {
  const props = {
    tabId: "t1",
    title: "title",
    values,
    active: true,
    onStatusChange: vi.fn(),
    onSecretsConsumed: vi.fn(),
    onEditAndReconnect: vi.fn(),
  };
  const view = render(<TerminalTab {...props} />);
  return { ...props, view };
}

beforeEach(() => {
  vi.clearAllMocks();
  session.state = { status: "connecting", sessionId: null, error: null };
  session.start.mockResolvedValue(undefined);
});

describe("TerminalTab", () => {
  it("マウント時に端末サイズで接続を開始し、秘密情報の消去を通知する", () => {
    const { onSecretsConsumed } = setup(sshPassword);
    expect(session.start).toHaveBeenCalledTimes(1);
    expect(session.start).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ssh",
        cols: 100,
        rows: 30,
        auth: expect.objectContaining({ kind: "password", password: "pw" }),
      }),
    );
    expect(onSecretsConsumed).toHaveBeenCalledWith("t1");
  });

  it("切断・エラー表示がない間は再接続ボタンを出さない", () => {
    session.state.status = "connected";
    setup(telnet);
    expect(
      screen.queryByRole("button", { name: "再接続" }),
    ).not.toBeInTheDocument();
  });

  it("切断後の「再接続」で同じ設定のまま接続し直す（区切り線を表示）", async () => {
    session.state = { status: "closed", sessionId: "s1", error: null };
    setup(telnet);
    session.start.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "再接続" }));
    expect(session.start).toHaveBeenCalledTimes(1);
    expect(session.start).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "telnet",
        host: "h",
        cols: 100,
        rows: 30,
      }),
    );
    expect(termWrite).toHaveBeenCalledWith(expect.any(Uint8Array));
  });

  it("エラー表示でも再接続できる", async () => {
    session.state = { status: "error", sessionId: null, error: "boom" };
    setup(telnet);
    expect(screen.getByRole("status")).toHaveTextContent("boom");
    session.start.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "再接続" }));
    expect(session.start).toHaveBeenCalledTimes(1);
  });

  it("パスワード認証のSSHは、パスワードを保持していないため入力し直す", async () => {
    session.state = { status: "closed", sessionId: "s1", error: null };
    const { onEditAndReconnect } = setup({ ...sshPassword, password: "" });
    session.start.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "再接続" }));
    expect(session.start).not.toHaveBeenCalled();
    expect(onEditAndReconnect).toHaveBeenCalledWith("t1");
  });
});

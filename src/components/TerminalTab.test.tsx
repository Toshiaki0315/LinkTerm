import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionValues } from "../lib/connection-schema";

const session = vi.hoisted(() => ({
  state: {
    status: "connecting",
    sessionId: null as string | null,
    error: null as string | null,
    remoteEcho: null as boolean | null,
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
const viewProps = vi.hoisted(() => ({ onInput: (_d: string) => {} }));
vi.mock("./TerminalView", async () => {
  const React = await import("react");
  return {
    TerminalView: React.forwardRef(
      (props: { onInput: (d: string) => void }, ref: React.Ref<unknown>) => {
        viewProps.onInput = props.onInput;
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
  localEcho: "auto",
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
  session.state = {
    status: "connecting",
    sessionId: null,
    error: null,
    remoteEcho: null,
  };
  session.start.mockResolvedValue(undefined);
  session.write.mockResolvedValue(undefined);
  session.resize.mockResolvedValue(undefined);
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
    session.state = {
      status: "closed",
      sessionId: "s1",
      error: null,
      remoteEcho: null,
    };
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
    session.state = {
      status: "error",
      sessionId: null,
      error: "boom",
      remoteEcho: null,
    };
    setup(telnet);
    expect(screen.getByRole("status")).toHaveTextContent("boom");
    session.start.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "再接続" }));
    expect(session.start).toHaveBeenCalledTimes(1);
  });

  it("パスワード認証のSSHは、パスワードを保持していないため入力し直す", async () => {
    session.state = {
      status: "closed",
      sessionId: "s1",
      error: null,
      remoteEcho: null,
    };
    const { onEditAndReconnect } = setup({ ...sshPassword, password: "" });
    session.start.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "再接続" }));
    expect(session.start).not.toHaveBeenCalled();
    expect(onEditAndReconnect).toHaveBeenCalledWith("t1");
  });

  describe("ローカルエコー", () => {
    const telnetWith = (localEcho: "auto" | "on" | "off"): ConnectionValues =>
      ({ ...telnet, localEcho }) as ConnectionValues;
    const serial = (localEcho: "auto" | "on" | "off"): ConnectionValues =>
      ({
        type: "serial",
        encoding: "UTF-8",
        serialPort: "/dev/cu.x",
        baudRate: 115200,
        dataBits: "Eight",
        parity: "None",
        stopBits: "One",
        flowControl: "None",
        localEcho,
      }) as ConnectionValues;

    const typed = (text: string) => {
      viewProps.onInput(text);
    };
    const echoed = () =>
      termWrite.mock.calls
        .map((c) => new TextDecoder().decode(c[0] as Uint8Array))
        .join("");

    it("オンなら、入力を端末に表示してから送信する（Enter は改行として表示）", () => {
      session.state = {
        status: "connected",
        sessionId: "s1",
        error: null,
        remoteEcho: true,
      };
      setup(telnetWith("on"));
      termWrite.mockClear();
      typed("ls\r");
      expect(echoed()).toBe("ls\r\n");
      expect(session.write).toHaveBeenCalledWith("ls\r");
    });

    it("オフなら表示しない（送信はする）", () => {
      session.state = {
        status: "connected",
        sessionId: "s1",
        error: null,
        remoteEcho: false,
      };
      setup(telnetWith("off"));
      termWrite.mockClear();
      typed("x");
      expect(echoed()).toBe("");
      expect(session.write).toHaveBeenCalledWith("x");
    });

    it("Telnet の自動: サーバーがエコーしていなければ表示、していれば表示しない", () => {
      session.state = {
        status: "connected",
        sessionId: "s1",
        error: null,
        remoteEcho: false,
      };
      const first = setup(telnetWith("auto"));
      termWrite.mockClear();
      typed("a");
      expect(echoed()).toBe("a");
      first.view.unmount();

      session.state = {
        status: "connected",
        sessionId: "s1",
        error: null,
        remoteEcho: true,
      };
      setup(telnetWith("auto"));
      termWrite.mockClear();
      typed("b");
      expect(echoed()).toBe("");
    });

    it("シリアルの自動: エコー状態が判定できないので表示しない", () => {
      session.state = {
        status: "connected",
        sessionId: "s1",
        error: null,
        remoteEcho: null,
      };
      setup(serial("auto"));
      termWrite.mockClear();
      typed("a");
      expect(echoed()).toBe("");
    });

    it("実行中に切り替えられる（自動→オン）", async () => {
      session.state = {
        status: "connected",
        sessionId: "s1",
        error: null,
        remoteEcho: true,
      };
      setup(telnetWith("auto"));
      expect(
        screen.getByRole("button", { name: "ローカルエコーの切り替え" }),
      ).toHaveTextContent("自動（オフ）");
      await userEvent.click(
        screen.getByRole("button", { name: "ローカルエコーの切り替え" }),
      );
      termWrite.mockClear();
      typed("z");
      expect(echoed()).toBe("z");
      expect(
        screen.getByRole("button", { name: "ローカルエコーの切り替え" }),
      ).toHaveTextContent("エコー: オン");
    });

    it("ローカルシェル・SSH にはエコーの切り替えを出さず、表示もしない", () => {
      session.state = {
        status: "connected",
        sessionId: "s1",
        error: null,
        remoteEcho: false,
      };
      setup({ type: "local", encoding: "UTF-8" } as ConnectionValues);
      expect(
        screen.queryByRole("button", { name: "ローカルエコーの切り替え" }),
      ).not.toBeInTheDocument();
      termWrite.mockClear();
      typed("a");
      expect(echoed()).toBe("");
    });
  });
});

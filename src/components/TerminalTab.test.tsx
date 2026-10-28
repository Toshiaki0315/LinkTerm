import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionValues } from "../lib/connection-schema";

const session = vi.hoisted(() => ({
  state: {
    status: "connecting",
    sessionId: null as string | null,
    error: null as string | null,
    remoteEcho: null as boolean | null,
  },
  onData: (_d: Uint8Array) => {},
  start: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  close: vi.fn(),
}));
vi.mock("../hooks/useTerminalSession", () => ({
  useTerminalSession: ({ onData }: { onData: (d: Uint8Array) => void }) => ({
    ...((session.onData = onData), session.state),
    start: session.start,
    write: session.write,
    resize: session.resize,
    close: session.close,
  }),
}));
const termWrite = vi.hoisted(() => vi.fn());
const termSearch = vi.hoisted(() => ({
  find: vi.fn(),
  clearSearch: vi.fn(),
  focus: vi.fn(),
  hasSelection: vi.fn(() => false),
  getSelection: vi.fn(() => ""),
  selectAll: vi.fn(),
  clear: vi.fn(),
  paste: vi.fn(),
  getText: vi.fn(() => ""),
}));
const exporter = vi.hoisted(() => ({ exportText: vi.fn() }));
vi.mock("../lib/export-text", () => exporter);
const clipboard = vi.hoisted(() => ({ copyText: vi.fn(), pasteText: vi.fn() }));
vi.mock("../lib/clipboard", () => clipboard);
const viewProps = vi.hoisted(() => ({
  onInput: (_d: string) => {},
  onBell: undefined as undefined | (() => void),
  onContextMenu: undefined as
    undefined | ((p: { x: number; y: number }) => void),
}));
vi.mock("./TerminalView", async () => {
  const React = await import("react");
  return {
    TerminalView: React.forwardRef(
      (
        props: {
          onInput: (d: string) => void;
          onBell?: () => void;
          onContextMenu?: (p: { x: number; y: number }) => void;
        },
        ref: React.Ref<unknown>,
      ) => {
        viewProps.onInput = props.onInput;
        viewProps.onBell = props.onBell;
        viewProps.onContextMenu = props.onContextMenu;
        React.useImperativeHandle(ref, () => ({
          write: termWrite,
          size: () => ({ cols: 100, rows: 30 }),
          focus: termSearch.focus,
          find: termSearch.find,
          clearSearch: termSearch.clearSearch,
          hasSelection: termSearch.hasSelection,
          getSelection: termSearch.getSelection,
          selectAll: termSearch.selectAll,
          clear: termSearch.clear,
          paste: termSearch.paste,
          getText: termSearch.getText,
        }));
        return <div data-testid="term" />;
      },
    ),
  };
});
const notify = vi.hoisted(() => ({ notifyMatch: vi.fn() }));
vi.mock("../lib/notify", async (orig) => ({
  ...(await orig<typeof import("../lib/notify")>()),
  notifyMatch: notify.notifyMatch,
}));
vi.mock("./LogControl", () => ({ LogControl: () => null }));
vi.mock("./SftpDialog", () => ({
  SftpDialog: ({ open, sessionId }: { open: boolean; sessionId: string }) =>
    open ? <div data-testid="sftp-dialog">{sessionId}</div> : null,
}));
vi.mock("./SerialControls", () => ({
  SerialControls: ({ sessionId }: { sessionId: string | null }) => (
    <div data-testid="serial-controls" data-session={sessionId ?? ""} />
  ),
}));

import { runPaneAction } from "../lib/pane-actions";
import { sendToPane } from "../lib/pane-input";
import { TerminalTab } from "./TerminalTab";

const telnet: ConnectionValues = {
  type: "telnet",
  encoding: "UTF-8",
  termType: "xterm-256color",
  localEcho: "auto",
  host: "h",
  port: 23,
  txNewline: "Cr",
  rxNewline: "Raw",
  loginScript: "",
  loginPassword: "",
};
const sshPassword: ConnectionValues = {
  type: "ssh",
  encoding: "UTF-8",
  termType: "xterm-256color",
  host: "h",
  port: 22,
  username: "u",
  useSshConfig: true,
  jumpHosts: "",
  forwards: "",
  socksPorts: "",
  remoteForwards: "",
  authKind: "password",
  password: "pw",
  remember: false,
  keyPath: "",
  passphrase: "",
};

function setup(values: ConnectionValues) {
  const props = {
    findSignal: 0,
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
  session.start.mockResolvedValue(true);
  session.write.mockResolvedValue(undefined);
  clipboard.copyText.mockReset().mockResolvedValue(undefined);
  clipboard.pasteText.mockReset().mockResolvedValue("pasted text");
  termSearch.hasSelection.mockReturnValue(false);
  termSearch.getSelection.mockReturnValue("");
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

  describe("シリアルの操作パネル", () => {
    const serialValues = {
      type: "serial",
      encoding: "UTF-8",
      localEcho: "off",
      serialPort: "/dev/cu.x",
      baudRate: 115200,
      dataBits: "Eight",
      parity: "None",
      stopBits: "One",
      flowControl: "None",
    } as ConnectionValues;

    it("シリアルの接続中に表示し、セッションIDを渡す", () => {
      session.state = {
        status: "connected",
        sessionId: "s9",
        error: null,
        remoteEcho: null,
      };
      setup(serialValues);
      expect(screen.getByTestId("serial-controls")).toHaveAttribute(
        "data-session",
        "s9",
      );
    });

    it("Telnet・ローカルシェルには表示しない", () => {
      session.state = {
        status: "connected",
        sessionId: "s9",
        error: null,
        remoteEcho: null,
      };
      const { view } = setup(telnet);
      expect(screen.queryByTestId("serial-controls")).not.toBeInTheDocument();
      view.unmount();
      setup({ type: "local", encoding: "UTF-8" } as ConnectionValues);
      expect(screen.queryByTestId("serial-controls")).not.toBeInTheDocument();
    });

    it("接続が確立するまではセッションIDを渡さない（操作不可）", () => {
      session.state = {
        status: "connecting",
        sessionId: null,
        error: null,
        remoteEcho: null,
      };
      setup(serialValues);
      expect(screen.getByTestId("serial-controls")).toHaveAttribute(
        "data-session",
        "",
      );
    });
  });

  describe("検索", () => {
    it("最初は検索バーを出さない。ツールバーの「検索」でも開ける", async () => {
      setup(telnet);
      expect(screen.queryByRole("search")).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "検索（⌘F）" }));
      expect(screen.getByRole("search")).toBeInTheDocument();
    });

    it("検索の要求（findSignal の増加）で検索バーが開く。同じ値のままなら開き直さない", async () => {
      const { view, ...props } = setup(telnet);
      view.rerender(<TerminalTab {...props} findSignal={1} />);
      expect(screen.getByRole("search")).toBeInTheDocument();
      await userEvent.click(
        screen.getByRole("button", { name: "検索を閉じる" }),
      );
      expect(screen.queryByRole("search")).not.toBeInTheDocument();
      view.rerender(<TerminalTab {...props} findSignal={1} />);
      expect(screen.queryByRole("search")).not.toBeInTheDocument();
      view.rerender(<TerminalTab {...props} findSignal={2} />);
      expect(screen.getByRole("search")).toBeInTheDocument();
    });

    it("入力した語でスクロールバックを検索し、閉じると強調を消してターミナルへ戻る", async () => {
      termSearch.find.mockReturnValue(true);
      const user = userEvent.setup();
      setup(telnet);
      await user.click(screen.getByRole("button", { name: "検索（⌘F）" }));
      await user.type(screen.getByRole("textbox", { name: "検索" }), "ab");
      expect(termSearch.find).toHaveBeenLastCalledWith(
        "ab",
        { caseSensitive: false, regex: false },
        "next",
        true,
      );
      termSearch.focus.mockClear();
      await user.click(screen.getByRole("button", { name: "検索を閉じる" }));
      expect(termSearch.clearSearch).toHaveBeenCalled();
      expect(termSearch.focus).toHaveBeenCalled();
    });
  });

  describe("ファイル転送（SFTP）", () => {
    const connected = () => {
      session.state = {
        status: "connected",
        sessionId: "sess-1",
        error: null,
        remoteEcho: null,
      };
    };

    it("接続済みの SSH だけ、ボタンから SFTP の画面を開ける", async () => {
      connected();
      const user = userEvent.setup();
      setup({ ...sshPassword, password: "x" } as ConnectionValues);
      expect(screen.queryByTestId("sftp-dialog")).toBeNull();
      await user.click(
        screen.getByRole("button", { name: "ファイル転送（SFTP）" }),
      );
      expect(screen.getByTestId("sftp-dialog")).toHaveTextContent("sess-1");
    });

    it("SSH 以外・未接続では出さない", () => {
      connected();
      setup(telnet);
      expect(
        screen.queryByRole("button", { name: "ファイル転送（SFTP）" }),
      ).toBeNull();
      session.state = { ...session.state, status: "connecting" };
      setup(sshPassword);
      expect(
        screen.queryByRole("button", { name: "ファイル転送（SFTP）" }),
      ).toBeNull();
    });
  });

  describe("ベル", () => {
    const mount = (active: boolean, onAttention = vi.fn()) => {
      render(
        <TerminalTab
          findSignal={0}
          tabId="t1"
          title="t"
          values={telnet}
          active={active}
          onAttention={onAttention}
          onStatusChange={vi.fn()}
          onSecretsConsumed={vi.fn()}
          onEditAndReconnect={vi.fn()}
        />,
      );
      return onAttention;
    };

    it("鳴ったら画面を一瞬光らせ、すぐ戻す", () => {
      vi.useFakeTimers();
      try {
        vi.spyOn(document, "hasFocus").mockReturnValue(true);
        mount(true);
        expect(screen.queryByTestId("bell-flash")).toBeNull();
        act(() => viewProps.onBell!());
        expect(screen.getByTestId("bell-flash")).toBeInTheDocument();
        act(() => {
          vi.advanceTimersByTime(200);
        });
        expect(screen.queryByTestId("bell-flash")).toBeNull();
      } finally {
        vi.useRealTimers();
        vi.restoreAllMocks();
      }
    });

    it("見ていないタブ（または注目のないウィンドウ）で鳴ったら、タブの注目表示も出す。見ているときは出さない", () => {
      const spy = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const watching = mount(true);
      act(() => viewProps.onBell!());
      expect(watching).not.toHaveBeenCalled();
      spy.mockReturnValue(false);
      act(() => viewProps.onBell!());
      expect(watching).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it("非アクティブなタブで鳴ったら、注目表示を出す", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const onAttention = mount(false);
      act(() => viewProps.onBell!());
      expect(onAttention).toHaveBeenCalledTimes(1);
    });
  });

  describe("キーワードの通知", () => {
    const rules = [
      {
        id: "r1",
        pattern: "FAILED",
        regex: false,
        caseSensitive: false,
        color: "red" as const,
        notify: true,
      },
      {
        id: "quiet",
        pattern: "warn",
        regex: false,
        caseSensitive: false,
        color: "yellow" as const,
        notify: false,
      },
    ];
    const output = (text: string) =>
      act(() => session.onData(new TextEncoder().encode(text)));
    const mount = (active: boolean, onAttention = vi.fn()) => {
      render(
        <TerminalTab
          findSignal={0}
          tabId="t1"
          title="alice@h"
          values={telnet}
          active={active}
          highlightRules={rules}
          onAttention={onAttention}
          onStatusChange={vi.fn()}
          onSecretsConsumed={vi.fn()}
          onEditAndReconnect={vi.fn()}
        />,
      );
      return onAttention;
    };

    beforeEach(() => {
      notify.notifyMatch.mockResolvedValue(true);
    });

    it("見ていないタブで通知する語が出たら、通知とタブの注目表示を出す（画面の内容は載せない）", async () => {
      const onAttention = mount(false);
      await waitFor(() => expect(session.start).toHaveBeenCalled());
      output("secret-token=abc FAILED\n");
      expect(onAttention).toHaveBeenCalledTimes(1);
      expect(notify.notifyMatch).toHaveBeenCalledWith(
        "キーワードを検出しました",
        "「FAILED」 — alice@h",
      );
      expect(JSON.stringify(notify.notifyMatch.mock.calls)).not.toContain(
        "secret-token",
      );
    });

    it("通知しない規則や、一致しない出力では何もしない", async () => {
      const onAttention = mount(false);
      await waitFor(() => expect(session.start).toHaveBeenCalled());
      output("just a warn line\n");
      expect(onAttention).not.toHaveBeenCalled();
      expect(notify.notifyMatch).not.toHaveBeenCalled();
    });

    it("見ている（アクティブで、ウィンドウにも注目がある）ときは通知しない", async () => {
      const spy = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const onAttention = mount(true);
      await waitFor(() => expect(session.start).toHaveBeenCalled());
      output("FAILED\n");
      expect(onAttention).not.toHaveBeenCalled();
      expect(notify.notifyMatch).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("アクティブでも、ウィンドウに注目がなければ通知する", async () => {
      const spy = vi.spyOn(document, "hasFocus").mockReturnValue(false);
      const onAttention = mount(true);
      await waitFor(() => expect(session.start).toHaveBeenCalled());
      output("FAILED\n");
      expect(onAttention).toHaveBeenCalled();
      expect(notify.notifyMatch).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it("同じ規則の通知は、続けて出さない", async () => {
      mount(false);
      await waitFor(() => expect(session.start).toHaveBeenCalled());
      output("FAILED 1\n");
      output("FAILED 2\n");
      expect(notify.notifyMatch).toHaveBeenCalledTimes(1);
    });
  });

  describe("自動ログイン", () => {
    const withScript = (script: string, password = ""): ConnectionValues =>
      ({
        ...telnet,
        loginScript: script,
        loginPassword: password,
      }) as ConnectionValues;
    const output = (text: string) =>
      act(() => session.onData(new TextEncoder().encode(text)));

    it("出力に待つ文字列が出たら、送る文字列を Enter 付きで送る", async () => {
      setup(withScript("login: => admin\nPassword: => {password}", "s3cret"));
      await waitFor(() => expect(session.start).toHaveBeenCalled());
      output("Welcome\r\nlogin: ");
      expect(session.write).toHaveBeenLastCalledWith("admin\r");
      output("Password: ");
      expect(session.write).toHaveBeenLastCalledWith("s3cret\r");
      await waitFor(() =>
        expect(termWrite).toHaveBeenLastCalledWith(expect.any(Uint8Array)),
      );
      const last = new TextDecoder().decode(termWrite.mock.lastCall![0]);
      expect(last).toContain("自動ログインを完了しました");
    });

    it("パスワードを画面（ローカルエコー）には出さない", async () => {
      setup(withScript("Password: => {password}", "s3cret"));
      await waitFor(() => expect(session.start).toHaveBeenCalled());
      termWrite.mockClear();
      output("Password: ");
      const shown = termWrite.mock.calls
        .map((c) => new TextDecoder().decode(c[0]))
        .join("");
      expect(shown).not.toContain("s3cret");
    });

    it("待たない手順は、接続できたらすぐ送る", async () => {
      setup(withScript("=> hello"));
      await waitFor(() =>
        expect(session.write).toHaveBeenCalledWith("hello\r"),
      );
    });

    it("接続に失敗したら、何も送らない", async () => {
      session.start.mockResolvedValue(false);
      setup(withScript("=> hello"));
      await waitFor(() => expect(session.start).toHaveBeenCalled());
      await Promise.resolve();
      expect(session.write).not.toHaveBeenCalled();
    });

    it("スクリプトがなければ、出力に反応しない", async () => {
      setup(telnet);
      await waitFor(() => expect(session.start).toHaveBeenCalled());
      output("login: ");
      expect(session.write).not.toHaveBeenCalled();
    });

    it("SSH では使わない", async () => {
      setup(sshPassword);
      await waitFor(() => expect(session.start).toHaveBeenCalled());
      output("login: ");
      expect(session.write).not.toHaveBeenCalled();
    });
  });

  describe("タイムスタンプ表示", () => {
    const mount = (show: boolean, onToggle?: () => void) =>
      render(
        <TerminalTab
          findSignal={0}
          tabId="t1"
          title="t"
          values={telnet}
          active
          showTimestamps={show}
          onToggleTimestamps={onToggle}
          onStatusChange={vi.fn()}
          onSecretsConsumed={vi.fn()}
          onEditAndReconnect={vi.fn()}
        />,
      );

    it("渡さなければボタンを出さない", () => {
      mount(false);
      expect(
        screen.queryByRole("button", { name: "タイムスタンプ表示" }),
      ).toBeNull();
    });

    it("ボタンで切り替える。いまの状態を aria-pressed で示す", async () => {
      const onToggle = vi.fn();
      const user = userEvent.setup();
      const view = mount(true, onToggle);
      const button = screen.getByRole("button", { name: "タイムスタンプ表示" });
      expect(button).toHaveAttribute("aria-pressed", "true");
      await user.click(button);
      expect(onToggle).toHaveBeenCalledTimes(1);
      view.unmount();
      mount(false, onToggle);
      expect(
        screen.getByRole("button", { name: "タイムスタンプ表示" }),
      ).toHaveAttribute("aria-pressed", "false");
    });
  });

  describe("同時入力", () => {
    it("キー入力はこのペインに送り、同時入力の通知も出す", () => {
      const onBroadcast = vi.fn();
      render(
        <TerminalTab
          findSignal={0}
          tabId="t1"
          title="t"
          values={telnet}
          active
          onBroadcast={onBroadcast}
          onStatusChange={vi.fn()}
          onSecretsConsumed={vi.fn()}
          onEditAndReconnect={vi.fn()}
        />,
      );
      act(() => viewProps.onInput("ls\r"));
      expect(session.write).toHaveBeenCalledWith("ls\r");
      expect(onBroadcast).toHaveBeenCalledWith("ls\r");
    });

    it("外部（ほかのペインの同時入力・スニペット）からの入力は、同時入力へ回さない（ループ防止）", () => {
      const onBroadcast = vi.fn();
      render(
        <TerminalTab
          findSignal={0}
          tabId="t1"
          title="t"
          values={telnet}
          active
          onBroadcast={onBroadcast}
          onStatusChange={vi.fn()}
          onSecretsConsumed={vi.fn()}
          onEditAndReconnect={vi.fn()}
        />,
      );
      sendToPane("t1", "from-other\r");
      expect(session.write).toHaveBeenCalledWith("from-other\r");
      expect(onBroadcast).not.toHaveBeenCalled();
    });
  });

  describe("外部からの入力（スニペット）", () => {
    it("ペインの入力口として登録され、キー入力と同じ経路で送る。アンマウントで解除する", () => {
      const { view } = setup(telnet);
      expect(sendToPane("t1", "ls\r")).toBe(true);
      expect(session.write).toHaveBeenCalledWith("ls\r");
      view.unmount();
      expect(sendToPane("t1", "x")).toBe(false);
    });
  });

  describe("右クリックメニュー", () => {
    function openMenu() {
      act(() => viewProps.onContextMenu!({ x: 30, y: 40 }));
    }

    it("分割・ペインを閉じる項目は、渡したときだけ表示し、選ぶと通知する", async () => {
      const onSplit = vi.fn();
      const onClosePane = vi.fn();
      const props = {
        findSignal: 0,
        tabId: "t1",
        title: "title",
        values: telnet,
        active: true,
        onStatusChange: vi.fn(),
        onSecretsConsumed: vi.fn(),
        onEditAndReconnect: vi.fn(),
        onSplit,
        onClosePane,
      };
      render(<TerminalTab {...props} />);
      openMenu();
      await userEvent.click(
        screen.getByRole("menuitem", { name: "右に分割（⌘D）" }),
      );
      expect(onSplit).toHaveBeenCalledWith("row");
      openMenu();
      await userEvent.click(
        screen.getByRole("menuitem", { name: "下に分割（⌘⇧D）" }),
      );
      expect(onSplit).toHaveBeenCalledWith("column");
      openMenu();
      await userEvent.click(
        screen.getByRole("menuitem", { name: "ペインを閉じる" }),
      );
      expect(onClosePane).toHaveBeenCalled();
    });

    it("コピー・貼り付け・すべて選択・検索・画面のクリアを表示する", () => {
      setup(telnet);
      openMenu();
      const names = screen.getAllByRole("menuitem").map((i) => i.textContent);
      expect(names).toEqual([
        "コピー",
        "貼り付け",
        "すべて選択",
        "検索…",
        "画面をクリア",
        "画面をテキストで保存…",
      ]);
    });

    describe("画面をテキストで保存", () => {
      const clickSave = async () => {
        openMenu();
        await userEvent.click(
          screen.getByRole("menuitem", { name: "画面をテキストで保存…" }),
        );
      };

      it("画面全体のテキストを保存し、保存先を表示する", async () => {
        termSearch.getText.mockReturnValue("line1\nline2\n");
        exporter.exportText.mockResolvedValue("/Users/me/out.txt");
        setup(telnet);
        await clickSave();
        expect(exporter.exportText).toHaveBeenCalledWith("line1\nline2\n");
        expect(
          await screen.findByText("保存しました: /Users/me/out.txt"),
        ).toBeInTheDocument();
      });

      it("キャンセルしたら、何も表示しない", async () => {
        termSearch.getText.mockReturnValue("x\n");
        exporter.exportText.mockResolvedValue(null);
        setup(telnet);
        await clickSave();
        await waitFor(() => expect(exporter.exportText).toHaveBeenCalled());
        expect(screen.queryByText(/保存しました/)).toBeNull();
      });

      it("内容が空なら、保存せずに知らせる", async () => {
        termSearch.getText.mockReturnValue("");
        setup(telnet);
        await clickSave();
        expect(exporter.exportText).not.toHaveBeenCalled();
        expect(
          screen.getByText("保存する内容がありません"),
        ).toBeInTheDocument();
      });

      it("保存に失敗したら、理由を表示する。「閉じる」で消せる", async () => {
        termSearch.getText.mockReturnValue("x\n");
        exporter.exportText.mockRejectedValue(new Error("保存先が不正です"));
        setup(telnet);
        await clickSave();
        expect(
          await screen.findByText("保存できません: 保存先が不正です"),
        ).toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: "閉じる" }));
        expect(screen.queryByText(/保存できません/)).toBeNull();
      });

      it("パレットなど外部からも、同じ保存を呼べる", async () => {
        termSearch.getText.mockReturnValue("x\n");
        exporter.exportText.mockResolvedValue("/a.txt");
        setup(telnet);
        act(() => {
          runPaneAction("t1", "exportText");
        });
        await waitFor(() => expect(exporter.exportText).toHaveBeenCalled());
      });
    });

    it("選択がなければ「コピー」は選べない", () => {
      setup(telnet);
      openMenu();
      expect(screen.getByRole("menuitem", { name: "コピー" })).toBeDisabled();
    });

    it("選択があれば「コピー」でクリップボードへコピーする", async () => {
      termSearch.hasSelection.mockReturnValue(true);
      termSearch.getSelection.mockReturnValue("selected");
      setup(telnet);
      openMenu();
      await userEvent.click(screen.getByRole("menuitem", { name: "コピー" }));
      expect(clipboard.copyText).toHaveBeenCalledWith("selected");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("「貼り付け」でクリップボードの内容を端末へ貼り付ける", async () => {
      setup(telnet);
      openMenu();
      await userEvent.click(screen.getByRole("menuitem", { name: "貼り付け" }));
      await waitFor(() =>
        expect(termSearch.paste).toHaveBeenCalledWith("pasted text"),
      );
    });

    it("クリップボードが空なら貼り付けない", async () => {
      clipboard.pasteText.mockResolvedValue("");
      setup(telnet);
      openMenu();
      await userEvent.click(screen.getByRole("menuitem", { name: "貼り付け" }));
      await waitFor(() => expect(clipboard.pasteText).toHaveBeenCalled());
      expect(termSearch.paste).not.toHaveBeenCalled();
    });

    it("「すべて選択」「画面をクリア」「検索…」", async () => {
      setup(telnet);
      openMenu();
      await userEvent.click(
        screen.getByRole("menuitem", { name: "すべて選択" }),
      );
      expect(termSearch.selectAll).toHaveBeenCalled();
      openMenu();
      await userEvent.click(
        screen.getByRole("menuitem", { name: "画面をクリア" }),
      );
      expect(termSearch.clear).toHaveBeenCalled();
      openMenu();
      await userEvent.click(screen.getByRole("menuitem", { name: "検索…" }));
      expect(screen.getByRole("search")).toBeInTheDocument();
    });

    it("コピーに失敗しても画面は壊さず、理由をコンソールに残す", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      clipboard.copyText.mockRejectedValue(new Error("denied"));
      termSearch.hasSelection.mockReturnValue(true);
      termSearch.getSelection.mockReturnValue("x");
      setup(telnet);
      openMenu();
      await userEvent.click(screen.getByRole("menuitem", { name: "コピー" }));
      await waitFor(() => expect(spy).toHaveBeenCalled());
      spy.mockRestore();
    });
  });

  describe("自動再接続", () => {
    const auto = { enabled: true, delaySeconds: 5, maxAttempts: 2 };
    const errored = {
      status: "error",
      sessionId: null,
      error: "切断",
      remoteEcho: null,
    };

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function mount(values: ConnectionValues, autoReconnect = auto) {
      const props = {
        findSignal: 0,
        tabId: "t1",
        title: "title",
        values,
        active: true,
        onStatusChange: vi.fn(),
        onSecretsConsumed: vi.fn(),
        onEditAndReconnect: vi.fn(),
        autoReconnect,
      };
      const view = render(<TerminalTab {...props} />);
      return { view, props };
    }
    const advance = (seconds: number) =>
      act(() => vi.advanceTimersByTime(seconds * 1000));

    it("異常な切断のあと、カウントダウンを表示して、時間が来たら再接続する", () => {
      session.state = errored;
      mount(telnet);
      session.start.mockClear();
      expect(screen.getByText(/5秒後に自動再接続します/)).toBeInTheDocument();
      expect(screen.getByText(/1\/2回目/)).toBeInTheDocument();
      advance(2);
      expect(screen.getByText(/3秒後に自動再接続します/)).toBeInTheDocument();
      advance(3);
      expect(session.start).toHaveBeenCalledTimes(1);
      expect(session.start).toHaveBeenCalledWith(
        expect.objectContaining({ type: "telnet" }),
      );
    });

    it("「キャンセル」で自動再接続を止める", () => {
      session.state = errored;
      mount(telnet);
      session.start.mockClear();
      act(() =>
        screen.getByRole("button", { name: "自動再接続をキャンセル" }).click(),
      );
      expect(screen.queryByText(/自動再接続します/)).not.toBeInTheDocument();
      advance(60);
      expect(session.start).not.toHaveBeenCalled();
    });

    it("設定が無効なら表示も再接続もしない", () => {
      session.state = errored;
      mount(telnet, { ...auto, enabled: false });
      session.start.mockClear();
      expect(screen.queryByText(/自動再接続/)).not.toBeInTheDocument();
      advance(60);
      expect(session.start).not.toHaveBeenCalled();
    });

    it("正常な終了（closed）では再接続しない", () => {
      session.state = {
        status: "closed",
        sessionId: "s1",
        error: null,
        remoteEcho: null,
      };
      mount(telnet);
      session.start.mockClear();
      advance(60);
      expect(session.start).not.toHaveBeenCalled();
      expect(screen.queryByText(/自動再接続/)).not.toBeInTheDocument();
    });

    it("パスワード認証のSSHは、パスワードを保持していないため自動再接続できないと伝える", () => {
      session.state = errored;
      mount({ ...sshPassword, password: "" });
      session.start.mockClear();
      expect(screen.getByText(/自動再接続できません/)).toBeInTheDocument();
      advance(60);
      expect(session.start).not.toHaveBeenCalled();
    });

    it("上限の回数に達したら、止まったことを知らせる", () => {
      session.state = errored;
      const { view, props } = mount(telnet, { ...auto, maxAttempts: 1 });
      session.start.mockClear();
      advance(5);
      expect(session.start).toHaveBeenCalledTimes(1);
      session.state = { ...errored, status: "connecting", error: null };
      view.rerender(<TerminalTab {...props} />);
      session.state = errored;
      view.rerender(<TerminalTab {...props} />);
      expect(
        screen.getByText(/上限（1回）に達したため、自動再接続を止めました/),
      ).toBeInTheDocument();
      advance(60);
      expect(session.start).toHaveBeenCalledTimes(1);
    });
  });

  describe("復元したタブ（接続を保留）", () => {
    function mountDeferred(
      values: ConnectionValues,
      status: "idle" | "closed" = "idle",
    ) {
      // 接続を始める前のセッションは idle。
      session.state = {
        status,
        sessionId: status === "idle" ? null : "s1",
        error: null,
        remoteEcho: null,
      };
      const props = {
        findSignal: 0,
        tabId: "t1",
        title: "title",
        values,
        active: true,
        deferStart: true,
        onStatusChange: vi.fn(),
        onSecretsConsumed: vi.fn(),
        onEditAndReconnect: vi.fn(),
      };
      render(<TerminalTab {...props} />);
      return props;
    }

    it("マウントしても自動では接続せず、未接続であることを示す", () => {
      mountDeferred(telnet);
      expect(session.start).not.toHaveBeenCalled();
      expect(screen.getByRole("status")).toHaveTextContent(
        "前回のタブです（未接続）",
      );
    });

    it("「接続」で接続を開始する（区切り線は出さない）", async () => {
      mountDeferred(telnet);
      termWrite.mockClear();
      await userEvent.click(screen.getByRole("button", { name: "接続" }));
      expect(session.start).toHaveBeenCalledTimes(1);
      expect(session.start).toHaveBeenCalledWith(
        expect.objectContaining({ type: "telnet" }),
      );
      expect(termWrite).not.toHaveBeenCalled();
    });

    it("パスワード認証のSSHは、「接続」でパスワード入力のダイアログを開く", async () => {
      const props = mountDeferred({ ...sshPassword, password: "" });
      await userEvent.click(screen.getByRole("button", { name: "接続" }));
      expect(session.start).not.toHaveBeenCalled();
      expect(props.onEditAndReconnect).toHaveBeenCalledWith("t1");
    });

    it("接続を始めたあとの切断では、通常どおり「再接続」を出す", () => {
      mountDeferred(telnet, "closed");
      expect(
        screen.getByRole("button", { name: "再接続" }),
      ).toBeInTheDocument();
      expect(screen.queryByText(/前回のタブです/)).not.toBeInTheDocument();
    });
  });
});

import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
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
const serialApi = vi.hoisted(() => ({
  sendBreak: vi.fn(),
  setControlSignal: vi.fn(),
}));
vi.mock("../lib/terminal-api", async (orig) => ({
  ...(await orig<typeof import("../lib/terminal-api")>()),
  sendBreak: serialApi.sendBreak,
  setControlSignal: serialApi.setControlSignal,
}));
const beepMock = vi.hoisted(() => ({ playBeep: vi.fn() }));
vi.mock("../lib/beep", () => beepMock);
const notify = vi.hoisted(() => ({ notifyMatch: vi.fn() }));
vi.mock("../lib/notify", async (orig) => ({
  ...(await orig<typeof import("../lib/notify")>()),
  notifyMatch: notify.notifyMatch,
}));
const logHook = vi.hoisted(() => ({
  state: {
    logging: false,
    dialogPath: null as string | null,
    error: null as string | null,
  },
  openDialog: vi.fn(),
  closeDialog: vi.fn(),
  clearError: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  args: [] as Array<{ sessionId: string | null; title: string }>,
}));
vi.mock("../hooks/useLogControl", () => ({
  useLogControl: (a: { sessionId: string | null; title: string }) => {
    logHook.args.push(a);
    return {
      ...logHook.state,
      openDialog: logHook.openDialog,
      closeDialog: logHook.closeDialog,
      clearError: logHook.clearError,
      start: logHook.start,
      stop: logHook.stop,
    };
  },
}));
const serialHook = vi.hoisted(() => ({
  state: {
    signals: { dtr: true, rts: true },
    hex: false,
    breaking: false,
    error: null as string | null,
    disabled: false,
  },
  toggleSignal: vi.fn(),
  doBreak: vi.fn(),
  toggleHex: vi.fn(),
  clearError: vi.fn(),
  args: [] as Array<string | null>,
}));
vi.mock("../hooks/useSerialControl", () => ({
  useSerialControl: (id: string | null) => {
    serialHook.args.push(id);
    return {
      ...serialHook.state,
      toggleSignal: serialHook.toggleSignal,
      doBreak: serialHook.doBreak,
      toggleHex: serialHook.toggleHex,
      clearError: serialHook.clearError,
    };
  },
}));
vi.mock("./LogDialog", () => ({
  LogDialog: ({ open, defaultPath }: { open: boolean; defaultPath: string }) =>
    open ? <div data-testid="log-dialog">{defaultPath}</div> : null,
}));
vi.mock("./SftpDialog", () => ({
  SftpDialog: ({ open, sessionId }: { open: boolean; sessionId: string }) =>
    open ? <div data-testid="sftp-dialog">{sessionId}</div> : null,
}));

import { runMacroOnPane, runPaneAction } from "../lib/pane-actions";
import {
  answerMacroDialog,
  cancelMacroDialogs,
  getCurrentMacroDialog,
} from "../lib/macro-dialog";
import { getPaneMenu } from "../lib/pane-menu";
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
  agentForwarding: false,
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

/** このペイン（tabId "t1"）が公開した、「⋯」のメニュー項目。 */
const menuItem = (label: string) => {
  const item = getPaneMenu("t1")?.items.find((i) => i.label === label);
  if (!item) throw new Error(`メニュー項目が見つかりません: ${label}`);
  return item;
};
const menuLabels = () => (getPaneMenu("t1")?.items ?? []).map((i) => i.label);

beforeEach(() => {
  vi.clearAllMocks();
  logHook.state = { logging: false, dialogPath: null, error: null };
  logHook.args = [];
  serialHook.state = {
    signals: { dtr: true, rts: true },
    hex: false,
    breaking: false,
    error: null,
    disabled: false,
  };
  serialHook.args = [];
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

    it("実行中に、メニューから切り替えられる（自動→オン）", async () => {
      session.state = {
        status: "connected",
        sessionId: "s1",
        error: null,
        remoteEcho: true,
      };
      setup(telnetWith("auto"));
      expect(menuItem("ローカルエコー: 自動（現在 オフ）").checked).toBe(true);
      termWrite.mockClear();
      typed("y");
      expect(echoed()).toBe("");
      act(() => menuItem("ローカルエコー: オン").onSelect());
      termWrite.mockClear();
      typed("z");
      expect(echoed()).toBe("z");
      await waitFor(() =>
        expect(menuItem("ローカルエコー: オン").checked).toBe(true),
      );
      expect(menuItem("ローカルエコー: 自動（現在 オン）").checked).toBe(false);
    });

    it("ローカルシェル・SSH にはエコーの切り替えを出さず、表示もしない", () => {
      session.state = {
        status: "connected",
        sessionId: "s1",
        error: null,
        remoteEcho: false,
      };
      setup({ type: "local", encoding: "UTF-8" } as ConnectionValues);
      expect(menuLabels().some((l) => l.startsWith("ローカルエコー"))).toBe(
        false,
      );
      termWrite.mockClear();
      typed("a");
      expect(echoed()).toBe("");
    });
  });

  describe("シリアルの操作（メニュー）", () => {
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
    const connected = () => {
      session.state = {
        status: "connected",
        sessionId: "s9",
        error: null,
        remoteEcho: null,
      };
    };

    it("シリアルの接続中は、DTR・RTS・ブレーク・HEX 表示の項目を出し、セッション ID を渡す", () => {
      connected();
      setup(serialValues);
      for (const l of ["DTR", "RTS", "ブレーク送信", "HEX表示"])
        expect(menuLabels()).toContain(l);
      expect(serialHook.args[serialHook.args.length - 1]).toBe("s9");
      expect(menuItem("DTR").disabled).toBe(false);
    });

    it("選ぶと、シリアルの操作を呼ぶ（状態はフックの値を反映する）", () => {
      connected();
      serialHook.state = {
        ...serialHook.state,
        signals: { dtr: false, rts: true },
        hex: true,
      };
      setup(serialValues);
      expect(menuItem("DTR").checked).toBe(false);
      expect(menuItem("RTS").checked).toBe(true);
      expect(menuItem("HEX表示").checked).toBe(true);
      menuItem("DTR").onSelect();
      menuItem("RTS").onSelect();
      menuItem("ブレーク送信").onSelect();
      menuItem("HEX表示").onSelect();
      expect(serialHook.toggleSignal.mock.calls.map((c) => c[0])).toEqual([
        "dtr",
        "rts",
      ]);
      expect(serialHook.doBreak).toHaveBeenCalled();
      expect(serialHook.toggleHex).toHaveBeenCalled();
    });

    it("Telnet・ローカルシェルには出さない（セッション ID も渡さない）", () => {
      connected();
      const { view } = setup(telnet);
      expect(menuLabels()).not.toContain("DTR");
      expect(serialHook.args.every((id) => id === null)).toBe(true);
      view.unmount();
      setup({ type: "local", encoding: "UTF-8" } as ConnectionValues);
      expect(menuLabels()).not.toContain("DTR");
    });

    it("接続が確立するまでは、セッション ID を渡さず、操作できない", () => {
      session.state = {
        status: "connecting",
        sessionId: null,
        error: null,
        remoteEcho: null,
      };
      setup(serialValues);
      expect(serialHook.args[serialHook.args.length - 1]).toBeNull();
      expect(menuItem("DTR").disabled).toBe(true);
      expect(menuItem("HEX表示").disabled).toBe(true);
    });

    it("操作の失敗は、ペインの上に表示し、閉じられる", async () => {
      connected();
      serialHook.state = {
        ...serialHook.state,
        error: "DTR を設定できません: 使えない操作です",
      };
      setup(serialValues);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "使えない操作です",
      );
      await userEvent.click(screen.getByRole("button", { name: "閉じる" }));
      expect(serialHook.clearError).toHaveBeenCalled();
      expect(logHook.clearError).toHaveBeenCalled();
    });
  });

  describe("ログ記録（メニュー）", () => {
    const connected = () => {
      session.state = {
        status: "connected",
        sessionId: "s1",
        error: null,
        remoteEcho: null,
      };
    };

    it("「ログ記録を開始…」で、ログの設定ダイアログを開く。接続前は押せない", () => {
      setup(telnet);
      expect(menuItem("ログ記録を開始…").disabled).toBe(true);
      expect(logHook.args[logHook.args.length - 1]).toEqual({
        sessionId: null,
        title: "title",
      });
    });

    it("接続後に開始を選ぶと、ダイアログを開く処理を呼ぶ", () => {
      connected();
      setup(telnet);
      expect(logHook.args[logHook.args.length - 1]).toEqual({
        sessionId: "s1",
        title: "title",
      });
      menuItem("ログ記録を開始…").onSelect();
      expect(logHook.openDialog).toHaveBeenCalled();
    });

    it("記録中は「ログ記録を停止」になり、メニューに記録中の印を付ける", () => {
      connected();
      logHook.state = { ...logHook.state, logging: true };
      setup(telnet);
      expect(menuLabels()).toContain("ログ記録を停止");
      expect(menuLabels()).not.toContain("ログ記録を開始…");
      expect(getPaneMenu("t1")?.recording).toBe(true);
      menuItem("ログ記録を停止").onSelect();
      expect(logHook.stop).toHaveBeenCalled();
    });

    it("ダイアログの経路があれば、ダイアログを表示する", () => {
      connected();
      logHook.state = { ...logHook.state, dialogPath: "/logs/a.log" };
      setup(telnet);
      expect(screen.getByTestId("log-dialog")).toHaveTextContent("/logs/a.log");
    });

    it("書き込みエラーは、ペインの上に表示する", async () => {
      connected();
      logHook.state = { ...logHook.state, error: "disk full" };
      setup(telnet);
      expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    });
  });

  describe("マクロ", () => {
    const connect = (id = "s1") => {
      session.state = {
        status: "connected",
        sessionId: id,
        error: null,
        remoteEcho: false,
      };
    };
    const run = (text: string, name = "m") =>
      act(() => {
        runMacroOnPane("t1", { name, text });
      });
    const out = (text: string) =>
      act(() => session.onData(new TextEncoder().encode(text)));
    const stopButton = () =>
      screen.queryByRole("button", { name: "マクロを停止" });
    const written = () =>
      session.write.mock.calls.map((c) => String(c[0])).join("");

    afterEach(() => cancelMacroDialogs("t1-1"));

    it("出力を待って、送る。実行中は「マクロ実行中: 名前（N行目）」と停止ボタンを出し、終わると消える", async () => {
      connect();
      setup(telnet);
      run("wait 'ok'\nsendln 'go'");
      const banner = await screen.findByRole("status", { name: "マクロ" });
      expect(banner).toHaveTextContent("マクロ実行中: m");
      expect(banner).toHaveTextContent("1行目");
      expect(stopButton()).toBeInTheDocument();
      expect(written()).toBe("");
      out("all ok now");
      await waitFor(() => expect(written()).toBe("go\r"));
      await waitFor(() => expect(stopButton()).toBeNull());
      expect(
        await screen.findByText("マクロ「m」を終了しました"),
      ).toBeInTheDocument();
    });

    it("マクロの送信は、ローカルエコーに出さない（パスワードを画面に出さない）", async () => {
      connect();
      setup({ ...telnet, localEcho: "on" } as ConnectionValues);
      termWrite.mockClear();
      run("sendln 'secret-pw'");
      await waitFor(() => expect(written()).toBe("secret-pw\r"));
      const shown = termWrite.mock.calls
        .map((c) => new TextDecoder().decode(c[0] as Uint8Array))
        .join("");
      expect(shown).not.toContain("secret-pw");
    });

    it("「停止」ボタンで止まる。止まったことを知らせる", async () => {
      connect();
      setup(telnet);
      run("wait 'never'\nsendln 'x'");
      await userEvent.click(
        await screen.findByRole("button", { name: "マクロを停止" }),
      );
      await waitFor(() => expect(stopButton()).toBeNull());
      expect(
        await screen.findByText("マクロ「m」を停止しました"),
      ).toBeInTheDocument();
      expect(written()).toBe("");
    });

    it("メニューの「マクロを停止」は、実行中だけ出て、選ぶと止まる", async () => {
      connect();
      setup(telnet);
      expect(menuLabels()).not.toContain("マクロを停止");
      run("wait 'never'");
      await waitFor(() => expect(menuLabels()).toContain("マクロを停止"));
      act(() => menuItem("マクロを停止").onSelect());
      await waitFor(() => expect(menuLabels()).not.toContain("マクロを停止"));
    });

    it("文法のエラーは、実行せずに、行番号つきで表示する", async () => {
      connect();
      setup(telnet);
      run("send 'a'\nfrobnicate");
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("マクロ「m」");
      expect(alert).toHaveTextContent("2行目");
      expect(alert).toHaveTextContent("frobnicate");
      expect(written()).toBe("");
    });

    it("実行時のエラーも、行番号つきで表示し、止まる", async () => {
      connect();
      setup(telnet);
      run("send 'a'\nsend zzz");
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("2行目");
      expect(alert).toHaveTextContent("zzz");
      await waitFor(() => expect(stopButton()).toBeNull());
    });

    it("接続していないときは、実行しない（理由を表示する）", async () => {
      setup(telnet);
      run("sendln 'x'");
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "接続していない",
      );
      expect(written()).toBe("");
    });

    it("実行中に、別のマクロは実行できない（理由を表示する）", async () => {
      connect();
      setup(telnet);
      run("wait 'never'", "first");
      await screen.findByRole("status", { name: "マクロ" });
      run("sendln 'x'", "second");
      expect(await screen.findByRole("alert")).toHaveTextContent("実行中");
      expect(written()).toBe("");
    });

    it("通知は閉じられる", async () => {
      connect();
      setup(telnet);
      run("frobnicate");
      await screen.findByRole("alert");
      await userEvent.click(screen.getByRole("button", { name: "閉じる" }));
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("messagebox: ダイアログを出し、閉じたら続きを実行する", async () => {
      connect();
      setup(telnet);
      run("messagebox 'こんにちは' 'お知らせ'\nsendln 'after'");
      await waitFor(() => expect(getCurrentMacroDialog()).toBeDefined());
      expect(getCurrentMacroDialog()?.request).toMatchObject({
        kind: "message",
        message: "こんにちは",
        title: "お知らせ",
      });
      expect(written()).toBe("");
      act(() => answerMacroDialog(getCurrentMacroDialog()!.id, undefined));
      await waitFor(() => expect(written()).toBe("after\r"));
    });

    it("passwordbox: 入力した値を、そのあとの送信に使う", async () => {
      connect();
      setup(telnet);
      run("passwordbox 'パスワード' '認証'\nsendln inputstr");
      await waitFor(() => expect(getCurrentMacroDialog()).toBeDefined());
      expect(getCurrentMacroDialog()?.request.kind).toBe("password");
      act(() => answerMacroDialog(getCurrentMacroDialog()!.id, "s3cret"));
      await waitFor(() => expect(written()).toBe("s3cret\r"));
    });

    it("listbox: 一覧のダイアログを出し、選んだ番号を result に入れる", async () => {
      connect();
      setup(telnet);
      run(
        "strdim m 2\nm[0]='a'\nm[1]='b'\nlistbox '選ぶ' '一覧' m\nsendln result + 48",
      );
      await waitFor(() => expect(getCurrentMacroDialog()).toBeDefined());
      expect(getCurrentMacroDialog()?.request).toMatchObject({
        kind: "list",
        message: "選ぶ",
        title: "一覧",
        items: ["a", "b"],
        selected: 0,
      });
      act(() => answerMacroDialog(getCurrentMacroDialog()!.id, 1));
      await waitFor(() => expect(written()).toBe("1\r"));
    });

    it("ダイアログの待ちの途中で止めると、ダイアログも閉じる", async () => {
      connect();
      setup(telnet);
      run("yesnobox 'ok?' 't'\nsendln 'x'");
      await waitFor(() => expect(getCurrentMacroDialog()).toBeDefined());
      await userEvent.click(
        screen.getByRole("button", { name: "マクロを停止" }),
      );
      await waitFor(() => expect(getCurrentMacroDialog()).toBeUndefined());
      expect(written()).toBe("");
    });

    it("受信は、文字コードの切れ目をまたいでも正しく照合する（UTF-8）", async () => {
      connect();
      setup(telnet);
      run("wait 'ログイン'\nsendln 'go'");
      const bytes = new TextEncoder().encode("ログイン:");
      act(() => session.onData(bytes.slice(0, 4)));
      act(() => session.onData(bytes.slice(4)));
      await waitFor(() => expect(written()).toBe("go\r"));
    });

    it("dispstr は、端末の画面に出す（接続先へは送らない）", async () => {
      connect();
      setup(telnet);
      termWrite.mockClear();
      run("dispstr 'local only'");
      await waitFor(() => expect(stopButton()).toBeNull());
      const shown = termWrite.mock.calls
        .map((c) => new TextDecoder().decode(c[0] as Uint8Array))
        .join("");
      expect(shown).toContain("local only");
      expect(written()).toBe("");
    });

    it("disconnect で、接続を閉じる。testlink は接続の状態を返す", async () => {
      connect();
      setup(telnet);
      run("testlink\nsendln result\ndisconnect");
      await waitFor(() => expect(session.close).toHaveBeenCalled());
      expect(written()).toBe("\u0002\r");
    });

    it("sendbreak: シリアルならブレークを送る。それ以外はエラー", async () => {
      connect("ser1");
      const serial = {
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
      const first = setup(serial);
      serialApi.sendBreak.mockResolvedValue(undefined);
      run("sendbreak");
      await waitFor(() =>
        expect(serialApi.sendBreak).toHaveBeenCalledWith("ser1"),
      );
      first.view.unmount();
      setup(telnet);
      run("sendbreak");
      expect(await screen.findByRole("alert")).toHaveTextContent("ブレーク");
    });

    it("setecho: ローカルエコーを入り切りする", async () => {
      connect();
      setup(telnet);
      run("setecho 1\nwait 'never'");
      await waitFor(() =>
        expect(menuItem("ローカルエコー: オン").checked).toBe(true),
      );
      act(() => menuItem("マクロを停止").onSelect());
      await waitFor(() => expect(stopButton()).toBeNull());
      run("setecho 0");
      await waitFor(() =>
        expect(menuItem("ローカルエコー: オフ").checked).toBe(true),
      );
    });

    it("setdtr / setrts: シリアルの制御信号を設定する。シリアル以外はエラー", async () => {
      connect("ser1");
      const serial = {
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
      serialApi.setControlSignal.mockResolvedValue(undefined);
      const first = setup(serial);
      run("setdtr 0\nsetrts 1");
      await waitFor(() =>
        expect(serialApi.setControlSignal.mock.calls).toEqual([
          ["ser1", "dtr", false],
          ["ser1", "rts", true],
        ]),
      );
      first.view.unmount();
      setup(telnet);
      run("setdtr 1");
      expect(await screen.findByRole("alert")).toHaveTextContent("シリアル");
    });

    it("enablekeyb: マクロの実行中だけ、ユーザーのキー入力を止められる。終わると必ず戻る", async () => {
      connect();
      setup(telnet);
      run("enablekeyb 0\nwait 'go'\nsendln 'macro'");
      await screen.findByRole("status", { name: "マクロ" });
      await waitFor(() => {
        act(() => viewProps.onInput("typed"));
        expect(written()).toBe("");
      });
      out("go");
      await waitFor(() => expect(written()).toBe("macro\r"));
      await waitFor(() => expect(stopButton()).toBeNull());
      act(() => viewProps.onInput("after"));
      expect(written()).toBe("macro\rafter");
    });

    it("enablekeyb 0 のまま停止しても、キー入力は戻る", async () => {
      connect();
      setup(telnet);
      run("enablekeyb 0\nwait 'never'");
      await screen.findByRole("status", { name: "マクロ" });
      await userEvent.click(
        screen.getByRole("button", { name: "マクロを停止" }),
      );
      await waitFor(() => expect(stopButton()).toBeNull());
      act(() => viewProps.onInput("typed"));
      expect(written()).toBe("typed");
    });

    it("clearscreen: 画面を消す（1 はスクロールバックも）", async () => {
      connect();
      setup(telnet);
      termWrite.mockClear();
      termSearch.clear.mockClear();
      run("clearscreen 0\nclearscreen 1");
      await waitFor(() => expect(termSearch.clear).toHaveBeenCalledTimes(1));
      const shown = termWrite.mock.calls
        .map((c) => new TextDecoder().decode(c[0] as Uint8Array))
        .join("");
      expect(shown).toContain("\u001b[2J");
    });

    it("settitle / gettitle: タブの名前を変え、読む", async () => {
      connect();
      const onSetTitle = vi.fn();
      const props = {
        findSignal: 0,
        tabId: "t1",
        title: "元の名前",
        values: telnet,
        active: true,
        onStatusChange: vi.fn(),
        onSecretsConsumed: vi.fn(),
        onEditAndReconnect: vi.fn(),
        onSetTitle,
      };
      render(<TerminalTab {...props} />);
      run("gettitle t\nsendln t\nsettitle '新しい名前'");
      await waitFor(() => expect(written()).toBe("元の名前\r"));
      expect(onSetTitle).toHaveBeenCalledWith("新しい名前");
    });

    it("beep: 音を鳴らす（種類の省略は 5）", async () => {
      connect();
      setup(telnet);
      run("beep\nbeep 2");
      await waitFor(() =>
        expect(beepMock.playBeep.mock.calls.map((c) => c[0])).toEqual([5, 2]),
      );
    });

    it("statusbox / closesbox: 状態の表示を出し、閉じる", async () => {
      connect();
      setup(telnet);
      run("statusbox '処理中です' '状態'\nwait 'x'\nclosesbox");
      expect(await screen.findByText(/処理中です/)).toBeInTheDocument();
      out("x");
      await waitFor(() => expect(screen.queryByText(/処理中です/)).toBeNull());
    });

    it("sendbroadcast: すべてのペインへ送る処理を呼ぶ", async () => {
      connect();
      const onBroadcastAll = vi.fn();
      render(
        <TerminalTab
          findSignal={0}
          tabId="t1"
          title="t"
          values={telnet}
          active
          onBroadcastAll={onBroadcastAll}
          onStatusChange={vi.fn()}
          onSecretsConsumed={vi.fn()}
          onEditAndReconnect={vi.fn()}
        />,
      );
      run("sendlnbroadcast 'hi'");
      await waitFor(() => expect(onBroadcastAll).toHaveBeenCalledWith("hi\r"));
    });

    it("gethostname: 接続先のホスト名（ローカルは空）。uptime は整数", async () => {
      connect();
      setup({ ...telnet, host: "device.example.com" } as ConnectionValues);
      run("gethostname h\nsendln h\nuptime t\nif t >= 0 then sendln 'up'");
      await waitFor(() => expect(written()).toBe("device.example.com\rup\r"));
    });

    it("タブを閉じたら、マクロを止め、ダイアログも閉じる", async () => {
      connect();
      const { view } = setup(telnet);
      run("yesnobox 'ok?' 't'\nsendln 'x'");
      await waitFor(() => expect(getCurrentMacroDialog()).toBeDefined());
      view.unmount();
      await waitFor(() => expect(getCurrentMacroDialog()).toBeUndefined());
      await Promise.resolve();
      expect(written()).toBe("");
    });

    it("接続が切れた状態で送ろうとすると、エラーにする", async () => {
      connect();
      const { view, ...props } = setup(telnet);
      run("wait 'go'\nsendln 'x'");
      await screen.findByRole("status", { name: "マクロ" });
      session.state = { ...session.state, status: "closed" };
      view.rerender(<TerminalTab {...props} />);
      out("go");
      expect(await screen.findByRole("alert")).toHaveTextContent("接続");
    });
  });

  describe("ペインのメニュー（タブバーの「⋯」）", () => {
    it("公開し、閉じる（アンマウント）と取り下げる", () => {
      const { view } = setup(telnet);
      expect(getPaneMenu("t1")).toBeDefined();
      view.unmount();
      expect(getPaneMenu("t1")).toBeUndefined();
    });

    it("ローカルシェルは 検索・ログだけ。時刻表示は、切り替えを渡したときだけ", () => {
      setup({ type: "local", encoding: "UTF-8" } as ConnectionValues);
      expect(menuLabels()).toEqual(["検索…（⌘F）", "ログ記録を開始…"]);
    });

    it("見た目が変わらない再描画では、公開し直さない（再描画の連鎖を避ける）", () => {
      const first = setup(telnet);
      const menu = getPaneMenu("t1");
      first.view.rerender(<TerminalTab {...first} />);
      expect(getPaneMenu("t1")).toBe(menu);
    });

    it("選んだときは、最新の処理が呼ばれる（古い処理ではない）", async () => {
      const first = vi.fn();
      const second = vi.fn();
      const { view, ...props } = setup(telnet);
      view.rerender(
        <TerminalTab
          {...props}
          showTimestamps={false}
          onToggleTimestamps={first}
        />,
      );
      view.rerender(
        <TerminalTab
          {...props}
          showTimestamps={false}
          onToggleTimestamps={second}
        />,
      );
      menuItem("タイムスタンプ表示").onSelect();
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalled();
    });
  });

  describe("検索", () => {
    it("最初は検索バーを出さない。メニューの「検索」でも開ける", () => {
      setup(telnet);
      expect(screen.queryByRole("search")).not.toBeInTheDocument();
      act(() => menuItem("検索…（⌘F）").onSelect());
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
      act(() => menuItem("検索…（⌘F）").onSelect());
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

    it("接続済みの SSH だけ、メニューから SFTP の画面を開ける", () => {
      connected();
      setup({ ...sshPassword, password: "x" } as ConnectionValues);
      expect(screen.queryByTestId("sftp-dialog")).toBeNull();
      expect(menuItem("ファイル転送（SFTP）…").disabled).toBe(false);
      act(() => menuItem("ファイル転送（SFTP）…").onSelect());
      expect(screen.getByTestId("sftp-dialog")).toHaveTextContent("sess-1");
    });

    it("SSH 以外では項目を出さない。未接続では押せない", () => {
      connected();
      const { view } = setup(telnet);
      expect(menuLabels()).not.toContain("ファイル転送（SFTP）…");
      view.unmount();
      session.state = { ...session.state, status: "connecting" };
      setup(sshPassword);
      expect(menuItem("ファイル転送（SFTP）…").disabled).toBe(true);
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

    it("StrictMode（開発時の二重実行）でも、手順は止まらずに進む", async () => {
      const props = {
        findSignal: 0,
        tabId: "t1",
        title: "title",
        values: withScript("login: => admin"),
        active: true,
        onStatusChange: vi.fn(),
        onSecretsConsumed: vi.fn(),
        onEditAndReconnect: vi.fn(),
      };
      render(
        <StrictMode>
          <TerminalTab {...props} />
        </StrictMode>,
      );
      await waitFor(() => expect(session.start).toHaveBeenCalled());
      // 接続は1回だけ。
      expect(session.start).toHaveBeenCalledTimes(1);
      output("login: ");
      expect(session.write).toHaveBeenLastCalledWith("admin\r");
    });

    it("タブを閉じたら（本当にアンマウントされたら）手順を止める", async () => {
      const { view } = setup(withScript("login: => admin"));
      await waitFor(() => expect(session.start).toHaveBeenCalled());
      view.unmount();
      // 停止は、すぐ再マウントされないと分かってから（次の microtask）行う。
      await Promise.resolve();
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

    it("渡さなければ、メニューに項目を出さない", () => {
      mount(false);
      expect(menuLabels()).not.toContain("タイムスタンプ表示");
    });

    it("メニューで切り替える。いまの状態を checked で示す", () => {
      const onToggle = vi.fn();
      const view = mount(true, onToggle);
      expect(menuItem("タイムスタンプ表示").checked).toBe(true);
      menuItem("タイムスタンプ表示").onSelect();
      expect(onToggle).toHaveBeenCalledTimes(1);
      view.unmount();
      mount(false, onToggle);
      expect(menuItem("タイムスタンプ表示").checked).toBe(false);
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

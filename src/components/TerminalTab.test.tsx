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
const termSearch = vi.hoisted(() => ({
  find: vi.fn(),
  clearSearch: vi.fn(),
  focus: vi.fn(),
  hasSelection: vi.fn(() => false),
  getSelection: vi.fn(() => ""),
  selectAll: vi.fn(),
  clear: vi.fn(),
  paste: vi.fn(),
}));
const clipboard = vi.hoisted(() => ({ copyText: vi.fn(), pasteText: vi.fn() }));
vi.mock("../lib/clipboard", () => clipboard);
const viewProps = vi.hoisted(() => ({
  onInput: (_d: string) => {},
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
          onContextMenu?: (p: { x: number; y: number }) => void;
        },
        ref: React.Ref<unknown>,
      ) => {
        viewProps.onInput = props.onInput;
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
        }));
        return <div data-testid="term" />;
      },
    ),
  };
});
vi.mock("./LogControl", () => ({ LogControl: () => null }));
vi.mock("./SerialControls", () => ({
  SerialControls: ({ sessionId }: { sessionId: string | null }) => (
    <div data-testid="serial-controls" data-session={sessionId ?? ""} />
  ),
}));

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
  useSshConfig: true,
  jumpHosts: "",
  forwards: "",
  socksPorts: "",
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
  session.start.mockResolvedValue(undefined);
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

  describe("右クリックメニュー", () => {
    function openMenu() {
      act(() => viewProps.onContextMenu!({ x: 30, y: 40 }));
    }

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
      ]);
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

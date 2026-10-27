import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  onHostKeyRequest: vi.fn(),
  respondHostKey: vi.fn(),
  pendingHostKeyRequests: vi.fn(),
  listSerialPorts: vi.fn(),
  listProfiles: vi.fn(),
  getSettings: vi.fn(),
  getSessionState: vi.fn(),
  saveSessionState: vi.fn(),
  listFonts: vi.fn(),
  saveSettings: vi.fn(),
  onOpenSettings: vi.fn(),
  saveProfile: vi.fn(),
  deleteProfile: vi.fn(),
}));
vi.mock("./lib/terminal-api", () => api);
vi.mock("./components/TerminalTab", () => ({
  TerminalTab: ({
    tabId,
    appearance,
    deferStart,
    findSignal,
    onEditAndReconnect,
    onSecretsConsumed,
  }: {
    tabId: string;
    appearance?: { fontSize: number; fontFamily: string };
    findSignal?: number;
    deferStart?: boolean;
    onEditAndReconnect: (id: string) => void;
    onSecretsConsumed: (id: string) => void;
  }) => (
    <div
      data-testid={`term-${tabId}`}
      data-font-size={appearance?.fontSize}
      data-find-signal={findSignal}
      data-defer-start={deferStart ? "true" : "false"}
      data-font-family={appearance?.fontFamily}
    >
      <button onClick={() => onEditAndReconnect(tabId)}>edit-reconnect</button>
      <button onClick={() => onSecretsConsumed(tabId)}>consume</button>
    </div>
  ),
}));

import App from "./App";
import { DEFAULT_SETTINGS, type Settings } from "./lib/settings";

let openSettingsFromMenu: () => void;
const withStartup = (startup: Settings["startup"]): Settings => ({
  ...DEFAULT_SETTINGS,
  startup,
});

let emitHostKey: (r: {
  requestId: string;
  host: string;
  port: number;
  fingerprint: string;
}) => void;

beforeEach(() => {
  vi.clearAllMocks();
  api.onHostKeyRequest.mockImplementation(async (cb) => {
    emitHostKey = cb;
    return () => {};
  });
  api.respondHostKey.mockResolvedValue(undefined);
  api.pendingHostKeyRequests.mockResolvedValue([]);
  api.listSerialPorts.mockResolvedValue([]);
  api.listProfiles.mockResolvedValue([]);
  api.getSettings.mockResolvedValue(DEFAULT_SETTINGS);
  api.getSessionState.mockResolvedValue({ tabs: [], active: null });
  api.saveSessionState.mockResolvedValue(undefined);
  api.listFonts.mockResolvedValue([]);
  api.saveSettings.mockImplementation(async (s) => s);
  api.onOpenSettings.mockImplementation(async (cb) => {
    openSettingsFromMenu = cb;
    return () => {};
  });
  api.saveProfile.mockResolvedValue({ id: "new", name: "n", values: {} });
  api.deleteProfile.mockResolvedValue(true);
});

describe("App", () => {
  it("アプリ名と空状態を表示する", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { name: "LinkTerm" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/新しい接続/)).toBeInTheDocument();
  });

  it("接続ダイアログからタブを追加・切替・閉じる", async () => {
    const user = userEvent.setup();
    render(<App />);
    for (let i = 0; i < 2; i++) {
      await user.click(screen.getByRole("button", { name: "新しい接続" }));
      await user.click(await screen.findByRole("button", { name: "接続" }));
      await waitFor(() =>
        expect(screen.getAllByRole("tab")).toHaveLength(i + 1),
      );
    }
    const tabs = screen.getAllByRole("tab");
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    await user.click(tabs[0]);
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.click(screen.getAllByRole("button", { name: /を閉じる/ })[0]);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("ホスト鍵の承認要求を表示して応答する", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(api.onHostKeyRequest).toHaveBeenCalled());
    act(() =>
      emitHostKey({
        requestId: "r9",
        host: "h",
        port: 22,
        fingerprint: "SHA256:zz",
      }),
    );
    await user.click(
      await screen.findByRole("button", { name: "信頼して接続" }),
    );
    expect(api.respondHostKey).toHaveBeenCalledWith("r9", true);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("購読前に出た未応答のホスト鍵要求も取り込んで表示する", async () => {
    api.pendingHostKeyRequests.mockResolvedValue([
      {
        requestId: "early",
        host: "early.example",
        port: 22,
        fingerprint: "SHA256:early",
      },
    ]);
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText("SHA256:early")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "信頼して接続" }));
    expect(api.respondHostKey).toHaveBeenCalledWith("early", true);
  });

  it("購読を確立してから未応答の要求を問い合わせる（取りこぼし防止）", async () => {
    const order: string[] = [];
    api.onHostKeyRequest.mockImplementation(async (cb) => {
      emitHostKey = cb;
      order.push("subscribed");
      return () => {};
    });
    api.pendingHostKeyRequests.mockImplementation(async () => {
      order.push("queried");
      return [];
    });
    render(<App />);
    await waitFor(() => expect(order).toEqual(["subscribed", "queried"]));
  });

  it("イベントと問い合わせで同じ要求が重複しても1回だけ表示・応答する", async () => {
    const req = {
      requestId: "dup",
      host: "h",
      port: 22,
      fingerprint: "SHA256:dup",
    };
    let resolvePending!: (v: unknown[]) => void;
    api.pendingHostKeyRequests.mockReturnValue(
      new Promise((r) => (resolvePending = r)),
    );
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(api.onHostKeyRequest).toHaveBeenCalled());
    act(() => emitHostKey(req));
    await act(async () => resolvePending([req]));
    await user.click(
      await screen.findByRole("button", { name: "信頼して接続" }),
    );
    expect(api.respondHostKey).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("問い合わせに失敗してもアプリは使え、後続のイベントは受け取れる", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    api.pendingHostKeyRequests.mockRejectedValue("失敗");
    render(<App />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    act(() =>
      emitHostKey({
        requestId: "later",
        host: "h",
        port: 22,
        fingerprint: "SHA256:later",
      }),
    );
    expect(await screen.findByText("SHA256:later")).toBeInTheDocument();
    spy.mockRestore();
  });

  it("ショートカット: ⌘T で接続ダイアログ、⌘W でタブを閉じる、⌘1 で切替", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.keyboard("{Meta>}t{/Meta}");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "接続" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));

    await user.keyboard("{Meta>}t{/Meta}");
    await user.click(await screen.findByRole("button", { name: "接続" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(screen.getAllByRole("tab")[1]).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.keyboard("{Meta>}1{/Meta}");
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.keyboard("{Meta>}w{/Meta}");
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("ダイアログ表示中は ⌘W / ⌘T でタブを操作しない", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "新しい接続" }));
    await user.click(await screen.findByRole("button", { name: "接続" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "新しい接続" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Meta>}w{/Meta}");
    expect(screen.getAllByRole("tab", { hidden: true })).toHaveLength(1);
  });

  it("再入力して再接続: 設定を引き継いだダイアログを開き、送信するとそのタブを置き換える", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "新しい接続" }));
    await user.selectOptions(await screen.findByLabelText("接続種別"), "ssh");
    await user.type(screen.getByLabelText("ホスト"), "example.com");
    await user.type(screen.getByLabelText("ユーザー名"), "alice");
    await user.type(screen.getByLabelText("パスワード"), "first-pw");
    await user.click(screen.getByRole("button", { name: "接続" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
    await user.click(await screen.findByRole("button", { name: "consume" }));

    await user.click(
      await screen.findByRole("button", { name: "edit-reconnect" }),
    );
    expect(await screen.findByLabelText("ホスト")).toHaveValue("example.com");
    expect(screen.getByLabelText("ユーザー名")).toHaveValue("alice");
    expect(screen.getByLabelText("パスワード")).toHaveValue("");
    await user.type(screen.getByLabelText("パスワード"), "second-pw");
    await user.click(screen.getByRole("button", { name: "接続" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
    expect(screen.getAllByRole("tab")[0]).toHaveTextContent(
      "alice@example.com",
    );
  });

  it("保存済みの接続を読み込んで一覧に出し、選んで接続できる", async () => {
    api.listProfiles.mockResolvedValue([
      {
        id: "p1",
        name: "ルーター",
        values: {
          type: "telnet",
          encoding: "UTF-8",
          host: "192.168.0.1",
          port: 23,
          txNewline: "Cr",
          rxNewline: "Raw",
        },
      },
    ]);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "新しい接続" }));
    await user.selectOptions(
      await screen.findByLabelText("保存済みの接続"),
      "p1",
    );
    await user.click(screen.getByRole("button", { name: "接続" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
    expect(screen.getAllByRole("tab")[0]).toHaveTextContent(
      "telnet://192.168.0.1:23",
    );
  });

  it("接続しながら保存すると保存APIを呼び、次回の一覧に反映する", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "新しい接続" }));
    await user.click(await screen.findByLabelText("この接続を保存する"));
    await user.type(screen.getByLabelText("保存名"), "手元のシェル");
    await user.click(screen.getByRole("button", { name: "接続" }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalled());
    expect(api.saveProfile).toHaveBeenCalledWith({
      id: undefined,
      name: "手元のシェル",
      values: expect.objectContaining({ type: "local" }),
    });
    await waitFor(() =>
      expect(api.listProfiles.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
  });

  it("保存に失敗したら理由を表示する（接続自体は続ける）", async () => {
    api.saveProfile.mockRejectedValue("ディスクがいっぱいです");
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "新しい接続" }));
    await user.click(await screen.findByLabelText("この接続を保存する"));
    await user.type(screen.getByLabelText("保存名"), "x");
    await user.click(screen.getByRole("button", { name: "接続" }));
    expect(
      await screen.findByText(/ディスクがいっぱいです/),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("保存済みの接続を削除して一覧を更新する", async () => {
    api.listProfiles.mockResolvedValueOnce([
      {
        id: "p1",
        name: "古い接続",
        values: { type: "local", encoding: "UTF-8" },
      },
    ]);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "新しい接続" }));
    await user.selectOptions(
      await screen.findByLabelText("保存済みの接続"),
      "p1",
    );
    await user.click(
      screen.getByRole("button", { name: "この保存済み接続を削除" }),
    );
    await waitFor(() => expect(api.deleteProfile).toHaveBeenCalledWith("p1"));
  });

  describe("設定", () => {
    it("メニューの「設定…」でダイアログが開き、現在の設定が表示される", async () => {
      api.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, fontSize: 17 });
      render(<App />);
      await waitFor(() => expect(api.onOpenSettings).toHaveBeenCalled());
      act(() => openSettingsFromMenu());
      expect(await screen.findByLabelText("フォントサイズ")).toHaveValue(17);
    });

    it("保存した設定を保存APIへ渡し、開いているターミナルへ即時反映する", async () => {
      const user = userEvent.setup();
      render(<App />);
      await user.click(screen.getByRole("button", { name: "新しい接続" }));
      await user.click(await screen.findByRole("button", { name: "接続" }));
      const term = await screen.findByTestId(/^term-/);
      expect(term).toHaveAttribute("data-font-size", "13");

      await waitFor(() => expect(api.onOpenSettings).toHaveBeenCalled());
      act(() => openSettingsFromMenu());
      const size = await screen.findByLabelText("フォントサイズ");
      await user.clear(size);
      await user.type(size, "24");
      await user.click(screen.getByRole("button", { name: "保存" }));
      await waitFor(() => expect(api.saveSettings).toHaveBeenCalled());
      expect(api.saveSettings.mock.calls[0][0]).toMatchObject({ fontSize: 24 });
      await waitFor(() =>
        expect(screen.getByTestId(/^term-/)).toHaveAttribute(
          "data-font-size",
          "24",
        ),
      );
    });

    it("保存に失敗したら理由を表示し、ターミナルの設定は変えない", async () => {
      api.saveSettings.mockRejectedValue("書き込めません");
      const user = userEvent.setup();
      render(<App />);
      await user.click(screen.getByRole("button", { name: "新しい接続" }));
      await user.click(await screen.findByRole("button", { name: "接続" }));
      await waitFor(() => expect(api.onOpenSettings).toHaveBeenCalled());
      act(() => openSettingsFromMenu());
      await user.click(await screen.findByRole("button", { name: "保存" }));
      expect(await screen.findByText(/書き込めません/)).toBeInTheDocument();
      expect(screen.getByTestId(/^term-/)).toHaveAttribute(
        "data-font-size",
        "13",
      );
    });

    it("設定ダイアログ表示中は ⌘T / ⌘W を受け付けない", async () => {
      const user = userEvent.setup();
      render(<App />);
      await waitFor(() => expect(api.onOpenSettings).toHaveBeenCalled());
      act(() => openSettingsFromMenu());
      await screen.findByLabelText("フォントサイズ");
      await user.keyboard("{Meta>}t{/Meta}");
      expect(
        screen.queryByRole("button", { name: "接続" }),
      ).not.toBeInTheDocument();
    });

    it("設定を読み込めなかったら理由を表示し、既定値で動く", async () => {
      api.getSettings.mockRejectedValue("設定ファイルが壊れています");
      render(<App />);
      expect(
        await screen.findByText(/設定ファイルが壊れています/),
      ).toBeInTheDocument();
      expect(screen.queryAllByRole("tab")).toHaveLength(0);
    });
  });

  describe("起動時に開くターミナル", () => {
    it("「何も開かない」ならタブを作らない", async () => {
      api.getSettings.mockResolvedValue(withStartup({ kind: "none" }));
      render(<App />);
      await waitFor(() => expect(api.listProfiles).toHaveBeenCalled());
      expect(screen.queryAllByRole("tab")).toHaveLength(0);
    });

    it("ローカルシェルを開く", async () => {
      api.getSettings.mockResolvedValue(withStartup({ kind: "local" }));
      render(<App />);
      await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
      expect(screen.getAllByRole("tab")[0]).toHaveTextContent("Local");
    });

    it("保存済みの接続を開く", async () => {
      api.getSettings.mockResolvedValue(
        withStartup({ kind: "profile", profileId: "p1" }),
      );
      api.listProfiles.mockResolvedValue([
        {
          id: "p1",
          name: "ルーター",
          values: {
            type: "telnet",
            encoding: "UTF-8",
            host: "192.168.0.1",
            port: 23,
            txNewline: "Cr",
            rxNewline: "Raw",
          },
        },
      ]);
      render(<App />);
      await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
      expect(screen.getAllByRole("tab")[0]).toHaveTextContent(
        "telnet://192.168.0.1:23",
      );
    });

    it("パスワード認証のSSHは、パスワードを保存していないので入力用のダイアログを開く", async () => {
      api.getSettings.mockResolvedValue(
        withStartup({ kind: "profile", profileId: "p1" }),
      );
      api.listProfiles.mockResolvedValue([
        {
          id: "p1",
          name: "本番",
          values: {
            type: "ssh",
            encoding: "UTF-8",
            host: "prod.example.com",
            port: 22,
            username: "alice",
            authKind: "password",
            remember: false,
            keyPath: "",
          },
        },
      ]);
      render(<App />);
      expect(await screen.findByLabelText("ホスト")).toHaveValue(
        "prod.example.com",
      );
      expect(screen.getByLabelText("パスワード")).toHaveValue("");
      expect(screen.queryAllByRole("tab", { hidden: true })).toHaveLength(0);
    });

    it("指定した保存済みの接続が見つからなければ、通知する", async () => {
      api.getSettings.mockResolvedValue(
        withStartup({ kind: "profile", profileId: "gone" }),
      );
      render(<App />);
      expect(
        await screen.findByText(/起動時に開く保存済みの接続が見つかりません/),
      ).toBeInTheDocument();
      expect(screen.queryAllByRole("tab")).toHaveLength(0);
    });

    it("起動時の処理は1回だけ（設定を保存しても新しいタブは開かない）", async () => {
      api.getSettings.mockResolvedValue(withStartup({ kind: "local" }));
      const user = userEvent.setup();
      render(<App />);
      await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
      await waitFor(() => expect(api.onOpenSettings).toHaveBeenCalled());
      act(() => openSettingsFromMenu());
      await user.click(await screen.findByRole("button", { name: "保存" }));
      await waitFor(() => expect(api.saveSettings).toHaveBeenCalled());
      expect(screen.getAllByRole("tab", { hidden: true })).toHaveLength(1);
    });
  });

  describe("検索（⌘F）", () => {
    async function openTabs(
      user: ReturnType<typeof userEvent.setup>,
      n: number,
    ) {
      for (let i = 0; i < n; i++) {
        await user.click(screen.getByRole("button", { name: "新しい接続" }));
        await user.click(await screen.findByRole("button", { name: "接続" }));
        await waitFor(() =>
          expect(screen.getAllByRole("tab")).toHaveLength(i + 1),
        );
      }
    }
    const signals = () =>
      screen
        .getAllByTestId(/^term-/)
        .map((el) => el.getAttribute("data-find-signal"));

    it("⌘F は、表示中のタブにだけ検索を要求する（押すたびに値が増える）", async () => {
      const user = userEvent.setup();
      render(<App />);
      await openTabs(user, 2);
      expect(signals()).toEqual(["0", "0"]);
      await user.keyboard("{Meta>}f{/Meta}");
      expect(signals()).toEqual(["0", "1"]);
      await user.keyboard("{Meta>}f{/Meta}");
      expect(signals()).toEqual(["0", "2"]);
      await user.keyboard("{Meta>}1{/Meta}");
      await user.keyboard("{Meta>}f{/Meta}");
      expect(signals()).toEqual(["1", "2"]);
    });

    it("タブがなければ何もしない", async () => {
      const user = userEvent.setup();
      render(<App />);
      await user.keyboard("{Meta>}f{/Meta}");
      expect(screen.queryAllByTestId(/^term-/)).toHaveLength(0);
    });

    it("ダイアログ表示中は受け付けない", async () => {
      const user = userEvent.setup();
      render(<App />);
      await openTabs(user, 1);
      await user.click(screen.getByRole("button", { name: "新しい接続" }));
      await screen.findByRole("dialog");
      await user.keyboard("{Meta>}f{/Meta}");
      expect(signals()).toEqual(["0"]);
    });
  });

  describe("タブの名前変更・複製・並べ替え", () => {
    async function addLocalTab(user: ReturnType<typeof userEvent.setup>) {
      const before = screen.queryAllByRole("tab").length;
      await user.click(screen.getByRole("button", { name: "新しい接続" }));
      await user.click(await screen.findByRole("button", { name: "接続" }));
      await waitFor(() =>
        expect(screen.getAllByRole("tab")).toHaveLength(before + 1),
      );
    }
    const titles = () => screen.getAllByRole("tab").map((t) => t.textContent);

    it("ダブルクリックでタブ名を変更できる", async () => {
      const user = userEvent.setup();
      render(<App />);
      await addLocalTab(user);
      await user.dblClick(screen.getByRole("tab", { name: /Local/ }));
      const input = await screen.findByRole("textbox", { name: "タブ名" });
      await user.clear(input);
      await user.type(input, "本番サーバー{Enter}");
      expect(
        screen.getByRole("tab", { name: /本番サーバー/ }),
      ).toBeInTheDocument();
    });

    it("右クリック→複製で、同じ設定のタブが右隣にできて選択される（名前も引き継ぐ）", async () => {
      const user = userEvent.setup();
      render(<App />);
      await addLocalTab(user);
      await user.dblClick(screen.getByRole("tab", { name: /Local/ }));
      const input = await screen.findByRole("textbox", { name: "タブ名" });
      await user.clear(input);
      await user.type(input, "作業用{Enter}");
      await addLocalTab(user);
      // 先頭のタブ（作業用）を複製すると、その右隣に入る。
      fireEvent.contextMenu(screen.getByRole("tab", { name: /作業用/ }));
      await user.click(await screen.findByRole("menuitem", { name: "複製" }));
      await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
      expect(titles()).toEqual(["作業用", "作業用", "Local"]);
      expect(screen.getAllByRole("tab")[1]).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });

    it("パスワード認証のSSHは、パスワードを保持していないので複製時に入力用のダイアログを開く", async () => {
      const user = userEvent.setup();
      render(<App />);
      await user.click(screen.getByRole("button", { name: "新しい接続" }));
      await user.selectOptions(await screen.findByLabelText("接続種別"), "ssh");
      await user.type(screen.getByLabelText("ホスト"), "example.com");
      await user.type(screen.getByLabelText("ユーザー名"), "alice");
      await user.type(screen.getByLabelText("パスワード"), "pw");
      await user.click(screen.getByRole("button", { name: "接続" }));
      await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
      await user.click(await screen.findByRole("button", { name: "consume" }));

      fireEvent.contextMenu(
        screen.getByRole("tab", { name: /alice@example.com/ }),
      );
      await user.click(await screen.findByRole("menuitem", { name: "複製" }));
      expect(await screen.findByLabelText("ホスト")).toHaveValue("example.com");
      expect(screen.getByLabelText("パスワード")).toHaveValue("");
      await user.type(screen.getByLabelText("パスワード"), "pw2");
      await user.click(screen.getByRole("button", { name: "接続" }));
      await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    });

    it("ドラッグ＆ドロップで並べ替えできる", async () => {
      const user = userEvent.setup();
      render(<App />);
      await addLocalTab(user);
      await user.dblClick(screen.getByRole("tab", { name: /Local/ }));
      const input = await screen.findByRole("textbox", { name: "タブ名" });
      await user.clear(input);
      await user.type(input, "A{Enter}");
      await addLocalTab(user);
      expect(titles()).toEqual(["A", "Local"]);
      const dataTransfer = {
        setData: vi.fn(),
        effectAllowed: "",
        dropEffect: "",
      };
      fireEvent.dragStart(screen.getByRole("tab", { name: /^A$/ }), {
        dataTransfer,
      });
      fireEvent.drop(screen.getByRole("tab", { name: /Local/ }), {
        dataTransfer,
      });
      expect(titles()).toEqual(["Local", "A"]);
    });
  });

  describe("画面状態の復元", () => {
    const restore = withStartup({ kind: "restore" });
    const saved = (
      tabs: Array<{ title: string; values: Record<string, unknown> }>,
      active: number | null = 0,
    ) => ({
      tabs,
      active,
    });
    const telnetValues = {
      type: "telnet",
      host: "192.168.0.1",
      port: 23,
      encoding: "UTF-8",
    };
    const titles = () => screen.getAllByRole("tab").map((t) => t.textContent);

    it("前回のタブを、名前と順序のまま復元し、保存されていたアクティブなタブを選ぶ", async () => {
      api.getSettings.mockResolvedValue(restore);
      api.getSessionState.mockResolvedValue(
        saved(
          [
            { title: "作業用", values: { type: "local", encoding: "UTF-8" } },
            { title: "ルーター", values: telnetValues },
          ],
          1,
        ),
      );
      render(<App />);
      await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
      expect(titles()).toEqual(["作業用", "ルーター"]);
      expect(screen.getAllByRole("tab")[1]).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });

    it("パスワード認証のSSHのタブは、自動接続せずに「接続」を待つ。他は自動で接続する", async () => {
      api.getSettings.mockResolvedValue(restore);
      api.getSessionState.mockResolvedValue(
        saved([
          {
            title: "ssh",
            values: {
              type: "ssh",
              host: "h",
              port: 22,
              username: "u",
              authKind: "password",
              encoding: "UTF-8",
            },
          },
          { title: "telnet", values: telnetValues },
        ]),
      );
      render(<App />);
      await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
      const terms = screen.getAllByTestId(/^term-/);
      expect(terms.map((t) => t.getAttribute("data-defer-start"))).toEqual([
        "true",
        "false",
      ]);
    });

    it("復元できない（不正な）タブは飛ばして、その数を通知する", async () => {
      api.getSettings.mockResolvedValue(restore);
      api.getSessionState.mockResolvedValue(
        saved([
          { title: "壊れた", values: { type: "ssh", host: "" } },
          { title: "正常", values: telnetValues },
          { title: "未知", values: { type: "ftp" } },
        ]),
      );
      render(<App />);
      expect(
        await screen.findByText(/2個のタブを復元できませんでした/),
      ).toBeInTheDocument();
      expect(titles()).toEqual(["正常"]);
    });

    it("保存がなければ何も開かない", async () => {
      api.getSettings.mockResolvedValue(restore);
      render(<App />);
      await waitFor(() => expect(api.getSessionState).toHaveBeenCalled());
      expect(screen.queryAllByRole("tab")).toHaveLength(0);
    });

    it("タブ構成の読み込みに失敗したら理由を通知する", async () => {
      api.getSettings.mockResolvedValue(restore);
      api.getSessionState.mockRejectedValue("壊れています");
      render(<App />);
      expect(
        await screen.findByText(/タブ構成を読み込めません: 壊れています/),
      ).toBeInTheDocument();
    });

    it("「復元」が選ばれていなければ、保存済みの構成を読み込まない・保存もしない", async () => {
      const user = userEvent.setup();
      render(<App />);
      await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
      await user.click(screen.getByRole("button", { name: "新しい接続" }));
      await user.click(await screen.findByRole("button", { name: "接続" }));
      await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
      await new Promise((r) => setTimeout(r, 700));
      expect(api.getSessionState).not.toHaveBeenCalled();
      expect(api.saveSessionState).not.toHaveBeenCalled();
    });

    it("タブを開く・閉じる・名前を変える・切り替えると、構成を保存する（秘密情報は含めない）", async () => {
      api.getSettings.mockResolvedValue(restore);
      const user = userEvent.setup();
      render(<App />);
      await waitFor(() => expect(api.getSessionState).toHaveBeenCalled());
      await user.click(screen.getByRole("button", { name: "新しい接続" }));
      await user.selectOptions(await screen.findByLabelText("接続種別"), "ssh");
      await user.type(screen.getByLabelText("ホスト"), "example.com");
      await user.type(screen.getByLabelText("ユーザー名"), "alice");
      await user.type(screen.getByLabelText("パスワード"), "top-secret");
      await user.click(screen.getByRole("button", { name: "接続" }));
      await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
      await waitFor(() => expect(api.saveSessionState).toHaveBeenCalled(), {
        timeout: 3000,
      });
      const calls = api.saveSessionState.mock.calls;
      const last = calls[calls.length - 1][0];
      expect(last.active).toBe(0);
      expect(last.tabs).toHaveLength(1);
      expect(last.tabs[0].title).toBe("alice@example.com");
      expect(last.tabs[0].values).toMatchObject({
        type: "ssh",
        host: "example.com",
        username: "alice",
      });
      expect(JSON.stringify(last)).not.toContain("top-secret");
    });

    it("全部のタブを閉じたら、空の構成を保存する", async () => {
      api.getSettings.mockResolvedValue(restore);
      api.getSessionState.mockResolvedValue(
        saved([{ title: "A", values: telnetValues }]),
      );
      const user = userEvent.setup();
      render(<App />);
      await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
      api.saveSessionState.mockClear();
      await user.click(screen.getByRole("button", { name: "A を閉じる" }));
      await waitFor(
        () =>
          expect(api.saveSessionState).toHaveBeenLastCalledWith({
            tabs: [],
            active: null,
          }),
        {
          timeout: 3000,
        },
      );
    });

    it("復元が終わるまでは保存しない（保存済みの構成を空で上書きしない）", async () => {
      api.getSettings.mockResolvedValue(restore);
      api.getSessionState.mockReturnValue(new Promise(() => {}));
      render(<App />);
      await waitFor(() => expect(api.getSessionState).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 700));
      expect(api.saveSessionState).not.toHaveBeenCalled();
    });

    it("保存に失敗したら理由を通知する", async () => {
      api.getSettings.mockResolvedValue(restore);
      api.saveSessionState.mockRejectedValue("書き込めません");
      const user = userEvent.setup();
      render(<App />);
      await waitFor(() => expect(api.getSessionState).toHaveBeenCalled());
      await user.click(screen.getByRole("button", { name: "新しい接続" }));
      await user.click(await screen.findByRole("button", { name: "接続" }));
      expect(
        await screen.findByText(
          /タブ構成を保存できません: 書き込めません/,
          {},
          { timeout: 3000 },
        ),
      ).toBeInTheDocument();
    });
  });
});

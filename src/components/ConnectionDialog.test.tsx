import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { connectionSchema } from "../lib/connection-schema";
import { ConnectionDialog } from "./ConnectionDialog";

function setup(
  loadSerialPorts = vi.fn().mockResolvedValue(["/dev/cu.usbserial-1"]),
) {
  const onSubmit = vi.fn();
  const onOpenChange = vi.fn();
  const user = userEvent.setup();
  render(
    <ConnectionDialog
      open
      onOpenChange={onOpenChange}
      onSubmit={onSubmit}
      loadSerialPorts={loadSerialPorts}
    />,
  );
  return { onSubmit, onOpenChange, user, loadSerialPorts };
}

describe("ConnectionDialog", () => {
  it("ローカルシェルはそのまま接続できる", async () => {
    const { user, onSubmit, onOpenChange } = setup();
    await user.click(screen.getByRole("button", { name: "接続" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toEqual({
      type: "local",
      encoding: "UTF-8",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("SSH: 必須項目が空ならエラーを表示して送信しない", async () => {
    const { user, onSubmit } = setup();
    await user.selectOptions(screen.getByLabelText("接続種別"), "ssh");
    await user.click(screen.getByRole("button", { name: "接続" }));
    expect(
      await screen.findByText("ホストを入力してください"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("パスワードを入力してください"),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("SSH パスワード認証で送信できる", async () => {
    const { user, onSubmit } = setup();
    await user.selectOptions(screen.getByLabelText("接続種別"), "ssh");
    await user.type(screen.getByLabelText("ホスト"), "example.com");
    await user.type(screen.getByLabelText("ユーザー名"), "alice");
    await user.type(screen.getByLabelText("パスワード"), "pw");
    await user.click(screen.getByLabelText("Keychainに保存する"));
    await user.click(screen.getByRole("button", { name: "接続" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      type: "ssh",
      host: "example.com",
      port: 22,
      username: "alice",
      authKind: "password",
      password: "pw",
      remember: true,
    });
  });

  it("SSH 認証方式の切替で入力欄が変わる", async () => {
    const { user } = setup();
    await user.selectOptions(screen.getByLabelText("接続種別"), "ssh");
    expect(screen.getByLabelText("パスワード")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("認証方式"), "keyFile");
    expect(screen.queryByLabelText("パスワード")).not.toBeInTheDocument();
    expect(screen.getByLabelText("秘密鍵のパス")).toBeInTheDocument();
    expect(screen.getByLabelText("パスフレーズ")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("認証方式"), "agent");
    expect(screen.queryByLabelText("秘密鍵のパス")).not.toBeInTheDocument();
  });

  it("エンコーディングを選択できる（既定はUTF-8）", async () => {
    const { user, onSubmit } = setup();
    expect(screen.getByLabelText("エンコーディング")).toHaveValue("UTF-8");
    await user.selectOptions(
      screen.getByLabelText("エンコーディング"),
      "Shift_JIS",
    );
    await user.click(screen.getByRole("button", { name: "接続" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      type: "local",
      encoding: "Shift_JIS",
    });
  });

  it("パスワード欄はマスクされる", async () => {
    const { user } = setup();
    await user.selectOptions(screen.getByLabelText("接続種別"), "ssh");
    expect(screen.getByLabelText("パスワード")).toHaveAttribute(
      "type",
      "password",
    );
  });

  it("Telnet はポート23が既定で、改行設定を送れる", async () => {
    const { user, onSubmit } = setup();
    await user.selectOptions(screen.getByLabelText("接続種別"), "telnet");
    expect(screen.getByLabelText("ポート")).toHaveValue(23);
    await user.type(screen.getByLabelText("ホスト"), "router");
    await user.selectOptions(screen.getByLabelText("送信改行"), "CrLf");
    await user.selectOptions(screen.getByLabelText("受信改行"), "LfToCrLf");
    await user.click(screen.getByRole("button", { name: "接続" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      type: "telnet",
      host: "router",
      port: 23,
      txNewline: "CrLf",
      rxNewline: "LfToCrLf",
    });
  });

  it("不正なポートはエラー", async () => {
    const { user, onSubmit } = setup();
    await user.selectOptions(screen.getByLabelText("接続種別"), "telnet");
    await user.type(screen.getByLabelText("ホスト"), "h");
    await user.clear(screen.getByLabelText("ポート"));
    await user.type(screen.getByLabelText("ポート"), "70000");
    await user.click(screen.getByRole("button", { name: "接続" }));
    expect(
      await screen.findByText("ポート番号は1〜65535で入力してください"),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("シリアル: ポート一覧を取得して設定を送れる", async () => {
    const { user, onSubmit, loadSerialPorts } = setup();
    await user.selectOptions(screen.getByLabelText("接続種別"), "serial");
    await waitFor(() => expect(loadSerialPorts).toHaveBeenCalled());
    await user.selectOptions(
      await screen.findByLabelText("シリアルポート"),
      "/dev/cu.usbserial-1",
    );
    await user.selectOptions(screen.getByLabelText("パリティ"), "Even");
    await user.click(screen.getByRole("button", { name: "接続" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      type: "serial",
      serialPort: "/dev/cu.usbserial-1",
      baudRate: 115200,
      dataBits: "Eight",
      parity: "Even",
      stopBits: "One",
      flowControl: "None",
    });
  });

  it("ポート一覧の取得に失敗したらメッセージを表示する", async () => {
    const { user } = setup(vi.fn().mockRejectedValue("取得エラー"));
    await user.selectOptions(screen.getByLabelText("接続種別"), "serial");
    expect(await screen.findByText(/取得エラー/)).toBeInTheDocument();
  });

  it("閉じて開き直すと、前回の入力（パスワード等の秘密情報を含む）は残らない", async () => {
    const user = userEvent.setup();
    const props = {
      onOpenChange: vi.fn(),
      onSubmit: vi.fn(),
      loadSerialPorts: vi.fn().mockResolvedValue([]),
    };
    const { rerender } = render(<ConnectionDialog open {...props} />);
    // 他のテストの描画が残らないよう、このテスト内の要素だけを見る。
    await user.selectOptions(screen.getByLabelText("接続種別"), "ssh");
    await user.type(screen.getByLabelText("ホスト"), "example.com");
    await user.type(screen.getByLabelText("パスワード"), "super-secret");
    rerender(<ConnectionDialog open={false} {...props} />);
    rerender(<ConnectionDialog open {...props} />);
    expect(screen.getByLabelText("接続種別")).toHaveValue("local");
    await user.selectOptions(screen.getByLabelText("接続種別"), "ssh");
    expect(screen.getByLabelText("ホスト")).toHaveValue("");
    expect(screen.getByLabelText("パスワード")).toHaveValue("");
  });

  it("initialValues があれば、それを入力済みの状態で開く（秘密情報は空のまま）", async () => {
    const user = userEvent.setup();
    const props = {
      onOpenChange: vi.fn(),
      onSubmit: vi.fn(),
      loadSerialPorts: vi.fn().mockResolvedValue([]),
    };
    const { rerender } = render(<ConnectionDialog open={false} {...props} />);
    rerender(
      <ConnectionDialog
        open
        {...props}
        initialValues={{
          type: "ssh",
          host: "example.com",
          port: 2200,
          username: "alice",
          authKind: "password",
        }}
      />,
    );
    expect(screen.getByLabelText("接続種別")).toHaveValue("ssh");
    expect(screen.getByLabelText("ホスト")).toHaveValue("example.com");
    expect(screen.getByLabelText("ポート")).toHaveValue(2200);
    expect(screen.getByLabelText("ユーザー名")).toHaveValue("alice");
    expect(screen.getByLabelText("パスワード")).toHaveValue("");
    await user.type(screen.getByLabelText("パスワード"), "new-pw");
    await user.click(screen.getByRole("button", { name: "接続" }));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalled());
    expect(props.onSubmit.mock.calls[0][0]).toMatchObject({
      host: "example.com",
      port: 2200,
      password: "new-pw",
    });
  });

  describe("保存済みの接続", () => {
    const profiles = [
      {
        id: "p1",
        name: "本番サーバー",
        values: {
          type: "ssh",
          encoding: "UTF-8",
          host: "prod.example.com",
          port: 2200,
          username: "alice",
          authKind: "keychain",
        },
      },
      {
        id: "p2",
        name: "ルーター",
        values: {
          type: "telnet",
          encoding: "Shift_JIS",
          host: "192.168.0.1",
          port: 23,
          txNewline: "CrLf",
          rxNewline: "LfToCrLf",
        },
      },
    ];

    function setupWithProfiles() {
      const onSubmit = vi.fn();
      const onDeleteProfile = vi.fn();
      const user = userEvent.setup();
      render(
        <ConnectionDialog
          open
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
          profiles={profiles}
          onDeleteProfile={onDeleteProfile}
          loadSerialPorts={vi.fn().mockResolvedValue([])}
        />,
      );
      return { onSubmit, onDeleteProfile, user };
    }

    it("保存済みがなければ選択欄を出さない", () => {
      setup();
      expect(screen.queryByLabelText("保存済みの接続")).not.toBeInTheDocument();
    });

    it("選ぶとフォームに読み込まれる（パスワード欄は空）", async () => {
      const { user } = setupWithProfiles();
      await user.selectOptions(screen.getByLabelText("保存済みの接続"), "p1");
      expect(screen.getByLabelText("接続種別")).toHaveValue("ssh");
      expect(screen.getByLabelText("ホスト")).toHaveValue("prod.example.com");
      expect(screen.getByLabelText("ポート")).toHaveValue(2200);
      expect(screen.getByLabelText("ユーザー名")).toHaveValue("alice");
      expect(screen.getByLabelText("認証方式")).toHaveValue("keychain");
      await user.selectOptions(screen.getByLabelText("保存済みの接続"), "p2");
      expect(screen.getByLabelText("接続種別")).toHaveValue("telnet");
      expect(screen.getByLabelText("エンコーディング")).toHaveValue(
        "Shift_JIS",
      );
      expect(screen.getByLabelText("送信改行")).toHaveValue("CrLf");
      expect(screen.getByLabelText("受信改行")).toHaveValue("LfToCrLf");
    });

    it("読み込んだ接続はそのまま接続でき、保存はしない", async () => {
      const { user, onSubmit } = setupWithProfiles();
      await user.selectOptions(screen.getByLabelText("保存済みの接続"), "p2");
      await user.click(screen.getByRole("button", { name: "接続" }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onSubmit.mock.calls[0][0]).toMatchObject({
        type: "telnet",
        host: "192.168.0.1",
      });
      expect(onSubmit.mock.calls[0][1]).toBeUndefined();
    });

    it("「この接続を保存する」で名前つきの新規保存を依頼する（秘密情報は含めない）", async () => {
      const { user, onSubmit } = setupWithProfiles();
      await user.selectOptions(screen.getByLabelText("接続種別"), "ssh");
      await user.type(screen.getByLabelText("ホスト"), "new.example.com");
      await user.type(screen.getByLabelText("ユーザー名"), "bob");
      await user.type(screen.getByLabelText("パスワード"), "top-secret");
      await user.click(screen.getByLabelText("この接続を保存する"));
      await user.type(screen.getByLabelText("保存名"), "新しいサーバー");
      await user.click(screen.getByRole("button", { name: "接続" }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      const options = onSubmit.mock.calls[0][1];
      expect(options.saveAs.name).toBe("新しいサーバー");
      expect(options.saveAs.id).toBeUndefined();
      expect(options.saveAs.values).toMatchObject({
        type: "ssh",
        host: "new.example.com",
        username: "bob",
      });
      expect(options.saveAs.values).not.toHaveProperty("password");
      expect(options.saveAs.values).not.toHaveProperty("passphrase");
      // 接続自体にはパスワードを渡す
      expect(onSubmit.mock.calls[0][0]).toMatchObject({
        password: "top-secret",
      });
    });

    it("保存済みを選んで保存すると、その接続を上書き更新する", async () => {
      const { user, onSubmit } = setupWithProfiles();
      await user.selectOptions(screen.getByLabelText("保存済みの接続"), "p1");
      await user.click(screen.getByLabelText("この接続を保存する"));
      expect(screen.getByLabelText("保存名")).toHaveValue("本番サーバー");
      await user.click(screen.getByRole("button", { name: "接続" }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onSubmit.mock.calls[0][1].saveAs).toMatchObject({
        id: "p1",
        name: "本番サーバー",
      });
    });

    it("保存名が空ならエラーで送信しない", async () => {
      const { user, onSubmit } = setupWithProfiles();
      await user.click(screen.getByLabelText("この接続を保存する"));
      await user.click(screen.getByRole("button", { name: "接続" }));
      expect(
        await screen.findByText("保存名を入力してください"),
      ).toBeInTheDocument();
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("選択中の接続を削除できる", async () => {
      const { user, onDeleteProfile } = setupWithProfiles();
      expect(
        screen.queryByRole("button", { name: "この保存済み接続を削除" }),
      ).not.toBeInTheDocument();
      await user.selectOptions(screen.getByLabelText("保存済みの接続"), "p1");
      await user.click(
        screen.getByRole("button", { name: "この保存済み接続を削除" }),
      );
      expect(onDeleteProfile).toHaveBeenCalledWith("p1");
      expect(screen.getByLabelText("保存済みの接続")).toHaveValue("");
    });
  });

  describe("シリアルポート名の手入力", () => {
    it("一覧にない機器は「手入力」で指定できる", async () => {
      const { user, onSubmit } = setup();
      await user.selectOptions(screen.getByLabelText("接続種別"), "serial");
      await screen.findByRole("option", { name: "/dev/cu.usbserial-1" });
      expect(
        screen.queryByLabelText("ポート名（手入力）"),
      ).not.toBeInTheDocument();
      await user.selectOptions(
        screen.getByLabelText("シリアルポート"),
        "手入力…",
      );
      await user.type(
        screen.getByLabelText("ポート名（手入力）"),
        "/dev/cu.custom-device",
      );
      await user.click(screen.getByRole("button", { name: "接続" }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onSubmit.mock.calls[0][0]).toMatchObject({
        type: "serial",
        serialPort: "/dev/cu.custom-device",
      });
    });

    it("/dev/ 以外のパスはエラーにする", async () => {
      const { user, onSubmit } = setup();
      await user.selectOptions(screen.getByLabelText("接続種別"), "serial");
      await screen.findByRole("option", { name: "手入力…" });
      await user.selectOptions(
        screen.getByLabelText("シリアルポート"),
        "手入力…",
      );
      await user.type(
        screen.getByLabelText("ポート名（手入力）"),
        "/etc/passwd",
      );
      await user.click(screen.getByRole("button", { name: "接続" }));
      expect(await screen.findByText(/\/dev\/ から始まる/)).toBeInTheDocument();
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("一覧にないポート名（保存済みの接続など）は、最初から手入力欄に表示される", async () => {
      const onSubmit = vi.fn();
      render(
        <ConnectionDialog
          open
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
          loadSerialPorts={vi.fn().mockResolvedValue(["/dev/cu.usbserial-1"])}
          initialValues={{
            type: "serial",
            serialPort: "/dev/cu.gone-device",
            baudRate: 9600,
          }}
        />,
      );
      expect(await screen.findByLabelText("ポート名（手入力）")).toHaveValue(
        "/dev/cu.gone-device",
      );
      expect(screen.getByLabelText("シリアルポート")).toHaveValue("__manual__");
    });

    it("一覧から選ぶと手入力欄は消える", async () => {
      const { user } = setup();
      await user.selectOptions(screen.getByLabelText("接続種別"), "serial");
      await screen.findByRole("option", { name: "/dev/cu.usbserial-1" });
      await user.selectOptions(
        screen.getByLabelText("シリアルポート"),
        "手入力…",
      );
      expect(screen.getByLabelText("ポート名（手入力）")).toBeInTheDocument();
      await user.selectOptions(
        screen.getByLabelText("シリアルポート"),
        "/dev/cu.usbserial-1",
      );
      expect(
        screen.queryByLabelText("ポート名（手入力）"),
      ).not.toBeInTheDocument();
    });
  });

  describe("~/.ssh/config と踏み台", () => {
    const aliases = ["prod", "staging"];
    function setupSsh(loadSshHosts = vi.fn().mockResolvedValue(aliases)) {
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      render(
        <ConnectionDialog
          open
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
          loadSerialPorts={vi.fn().mockResolvedValue([])}
          loadSshHosts={loadSshHosts}
        />,
      );
      return { onSubmit, user, loadSshHosts };
    }

    it("SSH を選ぶと、~/.ssh/config のホスト名が候補に出る", async () => {
      const { user, loadSshHosts } = setupSsh();
      await user.selectOptions(screen.getByLabelText("接続種別"), "ssh");
      await waitFor(() => expect(loadSshHosts).toHaveBeenCalled());
      await waitFor(() =>
        expect(
          document.querySelectorAll("#ssh-host-suggestions option"),
        ).toHaveLength(2),
      );
      expect(screen.getByLabelText("ホスト")).toHaveAttribute(
        "list",
        "ssh-host-suggestions",
      );
    });

    it("設定ファイルの別名なら、ユーザー名は空のままでも接続できる", async () => {
      const { user, onSubmit } = setupSsh();
      await user.selectOptions(screen.getByLabelText("接続種別"), "ssh");
      await user.selectOptions(screen.getByLabelText("認証方式"), "agent");
      await user.type(screen.getByLabelText("ホスト"), "prod");
      await waitFor(() =>
        expect(
          document.querySelectorAll("#ssh-host-suggestions option"),
        ).toHaveLength(2),
      );
      await user.click(screen.getByRole("button", { name: "接続" }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onSubmit.mock.calls[0][0]).toMatchObject({
        host: "prod",
        username: "",
        useSshConfig: true,
      });
    });

    it("別名でないホストでユーザー名が空なら、エラーにする", async () => {
      const { user, onSubmit } = setupSsh();
      await user.selectOptions(screen.getByLabelText("接続種別"), "ssh");
      await user.selectOptions(screen.getByLabelText("認証方式"), "agent");
      await user.type(screen.getByLabelText("ホスト"), "unknown.example.com");
      await waitFor(() =>
        expect(
          document.querySelectorAll("#ssh-host-suggestions option"),
        ).toHaveLength(2),
      );
      await user.click(screen.getByRole("button", { name: "接続" }));
      expect(
        await screen.findByText("ユーザー名を入力してください"),
      ).toBeInTheDocument();
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("~/.ssh/config を使わない設定にすると、ユーザー名が必須になる", async () => {
      const { user, onSubmit } = setupSsh();
      await user.selectOptions(screen.getByLabelText("接続種別"), "ssh");
      await user.selectOptions(screen.getByLabelText("認証方式"), "agent");
      await user.type(screen.getByLabelText("ホスト"), "prod");
      await user.click(screen.getByLabelText("~/.ssh/config を使う"));
      await user.click(screen.getByRole("button", { name: "接続" }));
      expect(
        await screen.findByText("ユーザー名を入力してください"),
      ).toBeInTheDocument();
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("踏み台を指定して接続できる。不正な指定はエラー", async () => {
      const { user, onSubmit } = setupSsh();
      await user.selectOptions(screen.getByLabelText("接続種別"), "ssh");
      await user.selectOptions(screen.getByLabelText("認証方式"), "agent");
      await user.type(screen.getByLabelText("ホスト"), "inner.example.com");
      await user.type(screen.getByLabelText("ユーザー名"), "alice");
      await user.type(screen.getByLabelText("踏み台（ProxyJump）"), "a b");
      await user.click(screen.getByRole("button", { name: "接続" }));
      expect(
        await screen.findByText("踏み台の指定が正しくありません"),
      ).toBeInTheDocument();
      expect(onSubmit).not.toHaveBeenCalled();
      await user.clear(screen.getByLabelText("踏み台（ProxyJump）"));
      await user.type(
        screen.getByLabelText("踏み台（ProxyJump）"),
        "bob@bastion:2222",
      );
      await user.click(screen.getByRole("button", { name: "接続" }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onSubmit.mock.calls[0][0]).toMatchObject({
        jumpHosts: "bob@bastion:2222",
      });
    });

    it("ホスト名の一覧を取得できなくても、入力・接続はできる", async () => {
      const { user } = setupSsh(vi.fn().mockRejectedValue("読めません"));
      await user.selectOptions(screen.getByLabelText("接続種別"), "ssh");
      await user.type(screen.getByLabelText("ホスト"), "h");
      expect(screen.getByLabelText("ホスト")).toHaveValue("h");
    });

    it("鍵のパスは、~/.ssh/config を使うなら空でもよいと案内する", async () => {
      const { user } = setupSsh();
      await user.selectOptions(screen.getByLabelText("接続種別"), "ssh");
      await user.selectOptions(screen.getByLabelText("認証方式"), "keyFile");
      expect(screen.getByLabelText("秘密鍵のパス")).toHaveAttribute(
        "placeholder",
        expect.stringContaining("IdentityFile"),
      );
    });
  });

  describe("端末の種類 (TERM)", () => {
    it("SSH では選べ、選んだ値で接続する", async () => {
      const { user, onSubmit } = setup();
      await user.selectOptions(screen.getByLabelText("接続種別"), "ssh");
      await user.type(screen.getByLabelText("ホスト"), "h");
      await user.type(screen.getByLabelText("ユーザー名"), "u");
      await user.selectOptions(screen.getByLabelText("認証方式"), "agent");
      await user.selectOptions(
        screen.getByLabelText("端末の種類 (TERM)"),
        "vt100",
      );
      await user.click(screen.getByRole("button", { name: "接続" }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onSubmit.mock.calls[0][0].termType).toBe("vt100");
    });

    it("ローカルシェル・シリアルでは表示しない", async () => {
      const { user } = setup();
      expect(screen.queryByLabelText("端末の種類 (TERM)")).toBeNull();
      await user.selectOptions(screen.getByLabelText("接続種別"), "serial");
      expect(screen.queryByLabelText("端末の種類 (TERM)")).toBeNull();
    });
  });

  it("タブの色を選んで接続でき、選ばなければ色なし", async () => {
    const { user, onSubmit } = setup();
    await user.selectOptions(screen.getByLabelText("タブの色"), "red");
    await user.click(screen.getByRole("button", { name: "接続" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].tabColor).toBe("red");
  });

  it("タブの色を「なし」にすると色は付かない", async () => {
    const { user, onSubmit } = setup();
    await user.selectOptions(screen.getByLabelText("タブの色"), "blue");
    await user.selectOptions(screen.getByLabelText("タブの色"), "");
    await user.click(screen.getByRole("button", { name: "接続" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].tabColor).toBeUndefined();
  });

  describe("最近使った接続", () => {
    const recents = [
      {
        values: connectionSchema.parse({
          type: "telnet",
          host: "router",
          port: 2323,
        }),
        usedAt: 2,
      },
      {
        values: connectionSchema.parse({
          type: "ssh",
          host: "web",
          port: 22,
          username: "alice",
          authKind: "agent",
        }),
        usedAt: 1,
      },
    ];

    it("履歴がなければ選択欄を出さない", () => {
      render(
        <ConnectionDialog open onOpenChange={() => {}} onSubmit={() => {}} />,
      );
      expect(screen.queryByLabelText("最近使った接続")).not.toBeInTheDocument();
    });

    it("選ぶと、その接続先が入力欄に入り、そのまま接続できる", async () => {
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      render(
        <ConnectionDialog
          open
          onOpenChange={() => {}}
          onSubmit={onSubmit}
          recents={recents}
        />,
      );
      await user.selectOptions(screen.getByLabelText("最近使った接続"), "0");
      expect(screen.getByLabelText("接続種別")).toHaveValue("telnet");
      expect(screen.getByLabelText("ホスト")).toHaveValue("router");
      expect(screen.getByLabelText("ポート")).toHaveValue(2323);
      await user.click(screen.getByRole("button", { name: "接続" }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onSubmit.mock.calls[0][0]).toMatchObject({
        type: "telnet",
        host: "router",
        port: 2323,
      });
    });
  });
});

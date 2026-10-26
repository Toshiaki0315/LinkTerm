import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
      screen.getByText("ユーザー名を入力してください"),
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
});

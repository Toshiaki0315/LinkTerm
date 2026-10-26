import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../lib/settings";
import { SettingsDialog } from "./SettingsDialog";

const profiles = [
  { id: "p1", name: "本番サーバー", values: { type: "ssh" } },
  { id: "p2", name: "ルーター", values: { type: "telnet" } },
];

function setup(
  over: {
    settings?: Settings;
    profiles?: typeof profiles;
    onSave?: (s: Settings) => Promise<void>;
  } = {},
) {
  const onSave = vi.fn<(s: Settings) => Promise<void>>(
    over.onSave ?? (async () => {}),
  );
  const onOpenChange = vi.fn();
  const user = userEvent.setup();
  render(
    <SettingsDialog
      open
      onOpenChange={onOpenChange}
      settings={over.settings ?? DEFAULT_SETTINGS}
      profiles={over.profiles ?? profiles}
      onSave={onSave}
    />,
  );
  return { onSave, onOpenChange, user };
}

async function replace(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  value: string,
) {
  const input = screen.getByLabelText(label);
  await user.clear(input);
  if (value !== "") await user.type(input, value);
}

describe("SettingsDialog", () => {
  it("現在の設定を表示する", () => {
    setup({
      settings: {
        fontFamily: "Osaka-Mono",
        fontSize: 16,
        scrollback: 5000,
        cursorBlink: false,
        startup: { kind: "local" },
      },
    });
    expect(screen.getByLabelText("フォント")).toHaveValue("Osaka-Mono");
    expect(screen.getByLabelText("フォントサイズ")).toHaveValue(16);
    expect(screen.getByLabelText("スクロールバック行数")).toHaveValue(5000);
    expect(screen.getByLabelText("カーソルを点滅させる")).not.toBeChecked();
    expect(screen.getByLabelText("起動時に開くターミナル")).toHaveValue(
      "local",
    );
  });

  it("入力した内容で保存し、ダイアログを閉じる", async () => {
    const { user, onSave, onOpenChange } = setup();
    await replace(user, "フォント", "SF Mono, monospace");
    await replace(user, "フォントサイズ", "18");
    await replace(user, "スクロールバック行数", "2000");
    await user.click(screen.getByLabelText("カーソルを点滅させる"));
    await user.selectOptions(
      screen.getByLabelText("起動時に開くターミナル"),
      "local",
    );
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith({
      fontFamily: "SF Mono, monospace",
      fontSize: 18,
      scrollback: 2000,
      cursorBlink: false,
      startup: { kind: "local" },
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("保存済みの接続を起動時に開く設定にできる", async () => {
    const { user, onSave } = setup();
    expect(screen.queryByLabelText("起動時の接続")).not.toBeInTheDocument();
    await user.selectOptions(
      screen.getByLabelText("起動時に開くターミナル"),
      "profile",
    );
    await user.selectOptions(screen.getByLabelText("起動時の接続"), "p2");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].startup).toEqual({
      kind: "profile",
      profileId: "p2",
    });
  });

  it("保存済みの接続を選んでいないとエラー（保存済みがない場合は案内を出す）", async () => {
    const { user, onSave } = setup();
    await user.selectOptions(
      screen.getByLabelText("起動時に開くターミナル"),
      "profile",
    );
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(
      await screen.findByText("起動時に開く接続を選択してください"),
    ).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("保存済みの接続がないときは、その旨を表示する", async () => {
    const { user } = setup({ profiles: [] });
    await user.selectOptions(
      screen.getByLabelText("起動時に開くターミナル"),
      "profile",
    );
    expect(screen.getByText(/保存済みの接続がありません/)).toBeInTheDocument();
  });

  it("範囲外・空の入力はエラーを表示して保存しない", async () => {
    const { user, onSave } = setup();
    await replace(user, "フォントサイズ", "7");
    await replace(user, "フォント", "");
    await replace(user, "スクロールバック行数", "100001");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(
      await screen.findByText("フォントサイズは8〜72の整数で入力してください"),
    ).toBeInTheDocument();
    expect(screen.getByText("フォントを入力してください")).toBeInTheDocument();
    expect(
      screen.getByText("スクロールバックは0〜100000行で入力してください"),
    ).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("プレビューが入力中のフォント・サイズを反映する", async () => {
    const { user } = setup();
    await replace(user, "フォント", "Osaka-Mono");
    await replace(user, "フォントサイズ", "20");
    const preview = screen.getByTestId("font-preview");
    expect(preview).toHaveStyle({ fontFamily: "Osaka-Mono", fontSize: "20px" });
    expect(preview).toHaveTextContent("日本語");
  });

  it("「初期設定に戻す」で入力欄だけを既定値にする（保存はしない）", async () => {
    const { user, onSave } = setup({
      settings: {
        ...DEFAULT_SETTINGS,
        fontSize: 30,
        scrollback: 1,
        startup: { kind: "local" },
      },
    });
    await user.click(screen.getByRole("button", { name: "初期設定に戻す" }));
    expect(screen.getByLabelText("フォントサイズ")).toHaveValue(
      DEFAULT_SETTINGS.fontSize,
    );
    expect(screen.getByLabelText("スクロールバック行数")).toHaveValue(
      DEFAULT_SETTINGS.scrollback,
    );
    expect(screen.getByLabelText("起動時に開くターミナル")).toHaveValue("none");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("保存に失敗したら理由を表示し、ダイアログは開いたままにする", async () => {
    const { user, onOpenChange } = setup({
      onSave: async () => {
        throw "ディスクがいっぱいです";
      },
    });
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(
      await screen.findByText(/ディスクがいっぱいです/),
    ).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("キャンセルで保存せずに閉じる", async () => {
    const { user, onSave, onOpenChange } = setup();
    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("開き直すと、編集途中の内容ではなく保存済みの設定が表示される", async () => {
    const props = {
      onOpenChange: vi.fn(),
      settings: DEFAULT_SETTINGS,
      profiles,
      onSave: vi.fn(),
    };
    const user = userEvent.setup();
    const { rerender } = render(<SettingsDialog open {...props} />);
    await replace(user, "フォントサイズ", "40");
    rerender(<SettingsDialog open={false} {...props} />);
    rerender(<SettingsDialog open {...props} />);
    expect(screen.getByLabelText("フォントサイズ")).toHaveValue(
      DEFAULT_SETTINGS.fontSize,
    );
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LogDialog } from "./LogDialog";

function setup(onSubmit = vi.fn().mockResolvedValue(undefined)) {
  const onOpenChange = vi.fn();
  const user = userEvent.setup();
  render(
    <LogDialog
      open
      onOpenChange={onOpenChange}
      defaultPath="/logs/alice.log"
      onSubmit={onSubmit}
    />,
  );
  return { onSubmit, onOpenChange, user };
}

describe("LogDialog", () => {
  it("既定のパスと設定を表示する", () => {
    setup();
    expect(screen.getByLabelText("保存先")).toHaveValue("/logs/alice.log");
    expect(screen.getByLabelText("記録形式")).toHaveValue("Text");
    expect(
      screen.getByLabelText("行頭にタイムスタンプを付ける"),
    ).not.toBeChecked();
    expect(screen.getByLabelText("既存ファイルに追記する")).toBeChecked();
  });

  it("設定を渡して記録を開始し、ダイアログを閉じる", async () => {
    const { user, onSubmit, onOpenChange } = setup();
    await user.selectOptions(screen.getByLabelText("記録形式"), "Raw");
    await user.click(screen.getByLabelText("行頭にタイムスタンプを付ける"));
    await user.click(screen.getByRole("button", { name: "記録開始" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith({
      path: "/logs/alice.log",
      mode: "Raw",
      timestamps: true,
      append: true,
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("保存先が空ならエラーを表示して送信しない", async () => {
    const { user, onSubmit } = setup();
    await user.clear(screen.getByLabelText("保存先"));
    await user.click(screen.getByRole("button", { name: "記録開始" }));
    expect(
      await screen.findByText("保存先を入力してください"),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("開始に失敗したら理由を表示し、ダイアログは開いたままにする", async () => {
    const { user, onOpenChange } = setup(
      vi.fn().mockRejectedValue("権限がありません"),
    );
    await user.click(screen.getByRole("button", { name: "記録開始" }));
    expect(await screen.findByText(/権限がありません/)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

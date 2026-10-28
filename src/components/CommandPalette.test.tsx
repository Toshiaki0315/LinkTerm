import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PaletteCommand } from "../lib/command-search";
import { CommandPalette } from "./CommandPalette";

const cmd = (
  id: string,
  title: string,
  run = vi.fn(),
  extra: Partial<PaletteCommand> = {},
): PaletteCommand => ({ id, title, group: "G", run, ...extra });

function setup(commands: PaletteCommand[], onOpenChange = vi.fn()) {
  const user = userEvent.setup();
  render(
    <CommandPalette open onOpenChange={onOpenChange} commands={commands} />,
  );
  return { user, onOpenChange };
}

describe("CommandPalette", () => {
  it("開くと入力欄にフォーカスし、全項目と補足（ショートカット・グループ）を表示する", () => {
    setup([
      cmd("a", "新しい接続", vi.fn(), { hint: "⌘T" }),
      cmd("b", "設定を開く"),
    ]);
    expect(
      screen.getByRole("combobox", { name: "コマンドを検索" }),
    ).toHaveFocus();
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getByText("⌘T")).toBeInTheDocument();
  });

  it("入力で絞り込む。一致がなければ案内を出す", async () => {
    const { user } = setup([cmd("a", "新しい接続"), cmd("b", "設定を開く")]);
    await user.type(screen.getByRole("combobox"), "設定");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option")).toHaveTextContent("設定を開く");
    await user.type(screen.getByRole("combobox"), "xyz");
    expect(
      screen.getByText("一致するコマンドがありません。"),
    ).toBeInTheDocument();
  });

  it("↑↓で選び（端で折り返す）、Enter で実行して閉じる", async () => {
    const runB = vi.fn();
    const { user, onOpenChange } = setup([
      cmd("a", "A"),
      cmd("b", "B", runB),
      cmd("c", "C"),
    ]);
    expect(screen.getAllByRole("option")[0]).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[1]).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getAllByRole("option")[0]).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(screen.getAllByRole("option")[1]).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.keyboard("{Enter}");
    expect(runB).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("絞り込むと、先頭の項目が選ばれる。一致がないときの Enter は何もしない", async () => {
    const runA = vi.fn();
    const { user } = setup([cmd("x", "X"), cmd("a", "Apple", runA)]);
    await user.keyboard("{ArrowDown}");
    await user.type(screen.getByRole("combobox"), "app");
    await user.keyboard("{Enter}");
    expect(runA).toHaveBeenCalledTimes(1);
  });

  it("項目のクリックでも実行する", async () => {
    const run = vi.fn();
    const { user, onOpenChange } = setup([cmd("a", "A", run)]);
    await user.click(screen.getByRole("option", { name: /A/ }));
    expect(run).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("閉じているときは何も表示しない。開き直すと入力は空から始まる", async () => {
    const commands = [cmd("a", "A")];
    const { rerender } = render(
      <CommandPalette
        open={false}
        onOpenChange={() => {}}
        commands={commands}
      />,
    );
    expect(screen.queryByRole("combobox")).toBeNull();
    const user = userEvent.setup();
    rerender(
      <CommandPalette open onOpenChange={() => {}} commands={commands} />,
    );
    await user.type(screen.getByRole("combobox"), "zzz");
    rerender(
      <CommandPalette
        open={false}
        onOpenChange={() => {}}
        commands={commands}
      />,
    );
    rerender(
      <CommandPalette open onOpenChange={() => {}} commands={commands} />,
    );
    expect(screen.getByRole("combobox")).toHaveValue("");
  });
});

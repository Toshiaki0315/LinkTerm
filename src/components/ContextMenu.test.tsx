import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ContextMenu } from "./ContextMenu";

function setup(
  items = [
    { label: "コピー", onSelect: vi.fn() },
    { label: "貼り付け", onSelect: vi.fn() },
    { label: "無効な項目", onSelect: vi.fn(), disabled: true },
  ],
) {
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    <div>
      <button>外側</button>
      <ContextMenu x={120} y={80} items={items} onClose={onClose} />
    </div>,
  );
  return { items, onClose, user };
}

describe("ContextMenu", () => {
  it("指定した位置に項目を表示する", () => {
    setup();
    const menu = screen.getByRole("menu");
    expect(menu).toHaveStyle({ left: "120px", top: "80px" });
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
  });

  it("項目を選ぶと、その処理を実行して閉じる", async () => {
    const { items, onClose, user } = setup();
    await user.click(screen.getByRole("menuitem", { name: "貼り付け" }));
    expect(items[1].onSelect).toHaveBeenCalledTimes(1);
    expect(items[0].onSelect).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("無効な項目は選べない", async () => {
    const { items, onClose, user } = setup();
    const disabled = screen.getByRole("menuitem", { name: "無効な項目" });
    expect(disabled).toBeDisabled();
    await user.click(disabled);
    expect(items[2].onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Esc、メニューの外のクリック、ウィンドウのスクロール・リサイズで閉じる", async () => {
    const first = setup();
    await first.user.keyboard("{Escape}");
    expect(first.onClose).toHaveBeenCalledTimes(1);

    const second = setup();
    await second.user.click(screen.getAllByRole("button", { name: "外側" })[1]);
    expect(second.onClose).toHaveBeenCalled();
  });

  it("開くと最初の項目にフォーカスし、↑↓で移動できる（無効な項目は飛ばす）", async () => {
    const { user } = setup();
    const [copy, paste] = screen.getAllByRole("menuitem");
    expect(copy).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(paste).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(copy).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(paste).toHaveFocus();
  });

  it("Enter でフォーカス中の項目を実行する", async () => {
    const { items, user } = setup();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(items[1].onSelect).toHaveBeenCalledTimes(1);
  });
});

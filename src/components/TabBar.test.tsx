import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/tabs";
import { TabBar } from "./TabBar";

const tab = (id: string, status: Tab["status"] = "connected"): Tab => ({
  id,
  title: `title-${id}`,
  values: { type: "local", encoding: "UTF-8" },
  status,
});

describe("TabBar", () => {
  it("タブ名を表示し、アクティブを aria-selected で示す", () => {
    render(
      <TabBar
        tabs={[tab("a"), tab("b")]}
        activeId="b"
        onActivate={() => {}}
        onClose={() => {}}
        onNew={() => {}}
      />,
    );
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: /title-b/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: /title-a/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("クリックで切替・×で閉じる・＋で新規", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const onClose = vi.fn();
    const onNew = vi.fn();
    render(
      <TabBar
        tabs={[tab("a"), tab("b")]}
        activeId="b"
        onActivate={onActivate}
        onClose={onClose}
        onNew={onNew}
      />,
    );
    await user.click(screen.getByRole("tab", { name: /title-a/ }));
    expect(onActivate).toHaveBeenCalledWith("a");
    await user.click(screen.getByRole("button", { name: "title-a を閉じる" }));
    expect(onClose).toHaveBeenCalledWith("a");
    expect(onActivate).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "新しい接続" }));
    expect(onNew).toHaveBeenCalled();
  });

  it("切断・エラー状態を示す", () => {
    render(
      <TabBar
        tabs={[tab("a", "closed"), tab("b", "error")]}
        activeId="a"
        onActivate={() => {}}
        onClose={() => {}}
        onNew={() => {}}
      />,
    );
    expect(
      screen.getByRole("tab", { name: /title-a/ }),
    ).toHaveAccessibleDescription("切断");
    expect(
      screen.getByRole("tab", { name: /title-b/ }),
    ).toHaveAccessibleDescription("エラー");
  });
});

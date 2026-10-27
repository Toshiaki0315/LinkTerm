import { fireEvent, render, screen } from "@testing-library/react";
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

  describe("タブ名の変更・複製・並べ替え", () => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    function setup(extra: Partial<React.ComponentProps<typeof TabBar>> = {}) {
      const handlers = {
        onActivate: vi.fn(),
        onClose: vi.fn(),
        onNew: vi.fn(),
        onRename: vi.fn(),
        onDuplicate: vi.fn(),
        onMove: vi.fn(),
      };
      const user = userEvent.setup();
      render(<TabBar tabs={tabs} activeId="a" {...handlers} {...extra} />);
      return { ...handlers, user };
    }

    it("ダブルクリックで名前を編集し、Enter で確定する", async () => {
      const { user, onRename } = setup();
      await user.dblClick(screen.getByRole("tab", { name: /title-b/ }));
      const input = screen.getByRole("textbox", { name: "タブ名" });
      expect(input).toHaveValue("title-b");
      expect(input).toHaveFocus();
      await user.clear(input);
      await user.type(input, "本番サーバー{Enter}");
      expect(onRename).toHaveBeenCalledWith("b", "本番サーバー");
      expect(
        screen.queryByRole("textbox", { name: "タブ名" }),
      ).not.toBeInTheDocument();
    });

    it("Esc で取り消す（変更を通知しない）", async () => {
      const { user, onRename } = setup();
      await user.dblClick(screen.getByRole("tab", { name: /title-a/ }));
      await user.type(
        screen.getByRole("textbox", { name: "タブ名" }),
        "xyz{Escape}",
      );
      expect(onRename).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("textbox", { name: "タブ名" }),
      ).not.toBeInTheDocument();
    });

    it("フォーカスが外れたら確定する。変更がなければ通知しない", async () => {
      const { user, onRename } = setup();
      await user.dblClick(screen.getByRole("tab", { name: /title-a/ }));
      await user.type(screen.getByRole("textbox", { name: "タブ名" }), "!");
      await user.click(screen.getByRole("button", { name: "新しい接続" }));
      expect(onRename).toHaveBeenCalledWith("a", "title-a!");

      onRename.mockClear();
      await user.dblClick(screen.getByRole("tab", { name: /title-b/ }));
      await user.click(screen.getByRole("button", { name: "新しい接続" }));
      expect(onRename).not.toHaveBeenCalled();
    });

    it("右クリックのメニューから、名前の変更・複製・閉じるを選べる", async () => {
      const { user, onDuplicate, onClose } = setup();
      fireEvent.contextMenu(screen.getByRole("tab", { name: /title-b/ }));
      expect(screen.getByRole("menu")).toBeInTheDocument();
      await user.click(screen.getByRole("menuitem", { name: "複製" }));
      expect(onDuplicate).toHaveBeenCalledWith("b");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();

      fireEvent.contextMenu(screen.getByRole("tab", { name: /title-c/ }));
      await user.click(screen.getByRole("menuitem", { name: "閉じる" }));
      expect(onClose).toHaveBeenCalledWith("c");

      fireEvent.contextMenu(screen.getByRole("tab", { name: /title-a/ }));
      await user.click(screen.getByRole("menuitem", { name: "名前を変更" }));
      expect(screen.getByRole("textbox", { name: "タブ名" })).toHaveValue(
        "title-a",
      );
    });

    it("ドラッグ＆ドロップで、ドロップしたタブの位置へ並べ替える", () => {
      const { onMove } = setup();
      const dataTransfer = {
        setData: vi.fn(),
        effectAllowed: "",
        dropEffect: "",
      };
      const from = screen.getByRole("tab", { name: /title-a/ });
      const to = screen.getByRole("tab", { name: /title-c/ });
      fireEvent.dragStart(from, { dataTransfer });
      fireEvent.dragOver(to, { dataTransfer });
      fireEvent.drop(to, { dataTransfer });
      expect(onMove).toHaveBeenCalledWith("a", 2);
    });

    it("自分自身へのドロップ・ドラッグ元のないドロップは何もしない", () => {
      const { onMove } = setup();
      const dataTransfer = {
        setData: vi.fn(),
        effectAllowed: "",
        dropEffect: "",
      };
      const a = screen.getByRole("tab", { name: /title-a/ });
      fireEvent.dragStart(a, { dataTransfer });
      fireEvent.drop(a, { dataTransfer });
      fireEvent.drop(screen.getByRole("tab", { name: /title-b/ }), {
        dataTransfer,
      });
      expect(onMove).not.toHaveBeenCalled();
    });

    it("ハンドラが渡されていなければ、編集やメニューは出ない（従来どおり）", async () => {
      const user = userEvent.setup();
      render(
        <TabBar
          tabs={tabs}
          activeId="a"
          onActivate={() => {}}
          onClose={() => {}}
          onNew={() => {}}
        />,
      );
      await user.dblClick(screen.getByRole("tab", { name: /title-a/ }));
      expect(
        screen.queryByRole("textbox", { name: "タブ名" }),
      ).not.toBeInTheDocument();
    });
  });
});

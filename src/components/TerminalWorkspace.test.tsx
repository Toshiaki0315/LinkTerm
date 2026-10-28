import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initialTabsState, tabsReducer, type Tab } from "../lib/tabs";

const mounts = vi.hoisted(() => ({ count: 0 }));
vi.mock("./TerminalTab", async () => {
  const React = await import("react");
  return {
    TerminalTab: ({ tabId }: { tabId: string }) => {
      React.useEffect(() => {
        mounts.count++;
      }, []);
      return <div data-testid={`term-${tabId}`} />;
    },
  };
});

import { TerminalWorkspace } from "./TerminalWorkspace";

const tab = (id: string): Tab => ({
  id,
  title: id,
  values: { type: "local", encoding: "UTF-8" },
  status: "connected",
});

describe("TerminalWorkspace", () => {
  it("全タブをマウントし、非アクティブは hidden で隠す", () => {
    render(
      <TerminalWorkspace
        tabs={[tab("a"), tab("b")]}
        activeId="a"
        onStatusChange={() => {}}
        onSecretsConsumed={() => {}}
        onEditAndReconnect={() => {}}
      />,
    );
    expect(
      screen.getByTestId("term-a").closest("[data-tab-id]"),
    ).not.toHaveClass("hidden");
    expect(screen.getByTestId("term-b").closest("[data-tab-id]")).toHaveClass(
      "hidden",
    );
  });

  it("タブ切替でアンマウント・再マウントしない（Keep-Alive）", () => {
    mounts.count = 0;
    const tabs = [tab("a"), tab("b")];
    const { rerender } = render(
      <TerminalWorkspace
        tabs={tabs}
        activeId="a"
        onStatusChange={() => {}}
        onSecretsConsumed={() => {}}
        onEditAndReconnect={() => {}}
      />,
    );
    rerender(
      <TerminalWorkspace
        tabs={tabs}
        activeId="b"
        onStatusChange={() => {}}
        onSecretsConsumed={() => {}}
        onEditAndReconnect={() => {}}
      />,
    );
    rerender(
      <TerminalWorkspace
        tabs={tabs}
        activeId="a"
        onStatusChange={() => {}}
        onSecretsConsumed={() => {}}
        onEditAndReconnect={() => {}}
      />,
    );
    expect(mounts.count).toBe(2);
    expect(
      screen.getByTestId("term-a").closest("[data-tab-id]"),
    ).not.toHaveClass("hidden");
    expect(screen.getByTestId("term-b").closest("[data-tab-id]")).toHaveClass(
      "hidden",
    );
  });

  it("タブがなければ案内を表示する", () => {
    render(
      <TerminalWorkspace
        tabs={[]}
        activeId={null}
        onStatusChange={() => {}}
        onSecretsConsumed={() => {}}
        onEditAndReconnect={() => {}}
      />,
    );
    expect(screen.getByText(/新しい接続/)).toBeInTheDocument();
  });

  it("端末の外側の余白も、テーマの背景色にする", () => {
    render(
      <TerminalWorkspace
        tabs={[tab("a")]}
        activeId="a"
        onStatusChange={() => {}}
        onSecretsConsumed={() => {}}
        onEditAndReconnect={() => {}}
        appearance={{
          fontFamily: "Menlo",
          fontSize: 13,
          scrollback: 10,
          cursorBlink: true,
          backgroundOpacity: 100,
          cursorStyle: "block",
          backspaceKey: "del",
          optionIsMeta: false,
          theme: "solarized-dark",
          copyOnSelect: false,
        }}
      />,
    );
    expect(
      (screen.getByTestId("term-a").closest("[data-tab-id]") as HTMLElement)
        .style.backgroundColor,
    ).toMatch(/^(#002b36|rgb\(0, 43, 54\))$/i);
  });

  it("背景を半透明にすると、各タブの背景も半透明になる", () => {
    render(
      <TerminalWorkspace
        tabs={[tab("a")]}
        activeId="a"
        onStatusChange={() => {}}
        onSecretsConsumed={() => {}}
        onEditAndReconnect={() => {}}
        appearance={{
          fontFamily: "Menlo",
          fontSize: 13,
          scrollback: 10,
          cursorBlink: true,
          backgroundOpacity: 50,
          cursorStyle: "block",
          backspaceKey: "del",
          optionIsMeta: false,
          theme: "solarized-dark",
          copyOnSelect: false,
        }}
      />,
    );
    const el = screen
      .getByTestId("term-a")
      .closest("[data-tab-id]") as HTMLElement;
    expect(el.style.backgroundColor).toBe("rgba(0, 43, 54, 0.5)");
  });

  describe("画面分割", () => {
    const base = () =>
      tabsReducer(initialTabsState, {
        type: "add",
        tab: {
          id: "a",
          title: "a",
          values: { type: "local", encoding: "UTF-8" },
        },
      });
    const splitState = () =>
      tabsReducer(base(), {
        type: "splitPane",
        tabId: "a",
        dir: "row",
        splitId: "sp",
        pane: { id: "p2", values: { type: "local", encoding: "UTF-8" } },
      });
    const props = {
      onStatusChange: () => {},
      onSecretsConsumed: () => {},
      onEditAndReconnect: () => {},
    };

    it("ペインごとに端末を置き、割合で位置を指定する", () => {
      const s = splitState();
      render(<TerminalWorkspace tabs={s.tabs} activeId="a" {...props} />);
      const left = screen.getByTestId("term-a").closest("[data-pane-id]");
      const right = screen.getByTestId("term-p2").closest("[data-pane-id]");
      expect((left as HTMLElement).style.width).toBe("50%");
      expect((right as HTMLElement).style.left).toBe("50%");
      expect(screen.getByRole("separator")).toBeInTheDocument();
    });

    it("分割してもすでにある端末は作り直さない", () => {
      mounts.count = 0;
      const { rerender } = render(
        <TerminalWorkspace tabs={base().tabs} activeId="a" {...props} />,
      );
      expect(mounts.count).toBe(1);
      rerender(
        <TerminalWorkspace tabs={splitState().tabs} activeId="a" {...props} />,
      );
      expect(mounts.count).toBe(2);
    });

    it("ペインを押すと操作対象になる", () => {
      const onActivatePane = vi.fn();
      render(
        <TerminalWorkspace
          tabs={splitState().tabs}
          activeId="a"
          {...props}
          onActivatePane={onActivatePane}
        />,
      );
      fireEvent.mouseDown(
        screen.getByTestId("term-a").closest("[data-pane-id]") as HTMLElement,
      );
      expect(onActivatePane).toHaveBeenCalledWith("a", "a");
    });

    it("境目のドラッグで比率を変える", () => {
      const onResizeSplit = vi.fn();
      render(
        <TerminalWorkspace
          tabs={splitState().tabs}
          activeId="a"
          {...props}
          onResizeSplit={onResizeSplit}
        />,
      );
      const sep = screen.getByRole("separator");
      const area = sep.parentElement as HTMLElement;
      area.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 1000, height: 500 }) as DOMRect;
      fireEvent.pointerDown(sep, { pointerId: 1, clientX: 500, clientY: 10 });
      window.dispatchEvent(
        new MouseEvent("pointermove", { clientX: 300, clientY: 10 }),
      );
      window.dispatchEvent(new MouseEvent("pointerup"));
      expect(onResizeSplit).toHaveBeenCalledWith("a", "sp", 0.3);
    });
  });
});

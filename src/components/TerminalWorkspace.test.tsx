import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/tabs";

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
    expect(screen.getByTestId("term-a").parentElement).not.toHaveClass(
      "hidden",
    );
    expect(screen.getByTestId("term-b").parentElement).toHaveClass("hidden");
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
    expect(screen.getByTestId("term-a").parentElement).not.toHaveClass(
      "hidden",
    );
    expect(screen.getByTestId("term-b").parentElement).toHaveClass("hidden");
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
});

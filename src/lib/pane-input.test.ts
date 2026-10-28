import { describe, expect, it, vi } from "vitest";
import { registerPaneInput, sendToPane } from "./pane-input";

describe("pane-input", () => {
  it("登録したペインへ送れ、解除すると送れない", () => {
    const send = vi.fn();
    const off = registerPaneInput("p1", send);
    expect(sendToPane("p1", "ls\r")).toBe(true);
    expect(send).toHaveBeenCalledWith("ls\r");
    off();
    expect(sendToPane("p1", "x")).toBe(false);
  });

  it("未登録のペインへは送れない", () => {
    expect(sendToPane("none", "x")).toBe(false);
  });

  it("後から同じ ID で登録した入力口を、古い解除が消さない", () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = registerPaneInput("p2", first);
    const offSecond = registerPaneInput("p2", second);
    offFirst();
    expect(sendToPane("p2", "a")).toBe(true);
    expect(second).toHaveBeenCalledWith("a");
    offSecond();
  });
});

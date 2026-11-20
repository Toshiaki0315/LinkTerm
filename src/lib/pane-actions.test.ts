import { describe, expect, it, vi } from "vitest";
import {
  pasteToPane,
  registerPaneActions,
  runPaneAction,
} from "./pane-actions";

describe("pane-actions", () => {
  it("登録したペインの操作を呼べ、解除すると呼べない", () => {
    const exportText = vi.fn();
    const off = registerPaneActions("p1", { exportText, paste: vi.fn() });
    expect(runPaneAction("p1", "exportText")).toBe(true);
    expect(exportText).toHaveBeenCalledTimes(1);
    off();
    expect(runPaneAction("p1", "exportText")).toBe(false);
    expect(runPaneAction("none", "exportText")).toBe(false);
  });

  it("後から同じ ID で登録したものを、古い解除が消さない", () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = registerPaneActions("p2", {
      exportText: first,
      paste: vi.fn(),
    });
    const offSecond = registerPaneActions("p2", {
      exportText: second,
      paste: vi.fn(),
    });
    offFirst();
    expect(runPaneAction("p2", "exportText")).toBe(true);
    expect(second).toHaveBeenCalled();
    offSecond();
  });

  it("ペインへ文字列を貼り付けられる。ペインがなければ false", () => {
    const paste = vi.fn();
    const off = registerPaneActions("p3", { exportText: vi.fn(), paste });
    expect(pasteToPane("p3", "abc ")).toBe(true);
    expect(paste).toHaveBeenCalledWith("abc ");
    off();
    expect(pasteToPane("p3", "x")).toBe(false);
  });
});

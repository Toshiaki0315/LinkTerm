import { describe, expect, it, vi } from "vitest";
import {
  pasteToPane,
  registerPaneActions,
  runMacroOnPane,
  runPaneAction,
  stopMacroOnPane,
  type PaneActions,
} from "./pane-actions";

const stub = (): PaneActions => ({
  exportText: vi.fn(),
  paste: vi.fn(),
  runMacro: vi.fn(),
  stopMacro: vi.fn(),
});

describe("pane-actions", () => {
  it("登録したペインの操作を呼べ、解除すると呼べない", () => {
    const exportText = vi.fn();
    const off = registerPaneActions("p1", { ...stub(), exportText });
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
      ...stub(),
      exportText: first,
    });
    const offSecond = registerPaneActions("p2", {
      ...stub(),
      exportText: second,
    });
    offFirst();
    expect(runPaneAction("p2", "exportText")).toBe(true);
    expect(second).toHaveBeenCalled();
    offSecond();
  });

  it("ペインへ文字列を貼り付けられる。ペインがなければ false", () => {
    const paste = vi.fn();
    const off = registerPaneActions("p3", { ...stub(), paste });
    expect(pasteToPane("p3", "abc ")).toBe(true);
    expect(paste).toHaveBeenCalledWith("abc ");
    off();
    expect(pasteToPane("p3", "x")).toBe(false);
  });

  it("ペインでマクロを実行・停止できる。ペインがなければ false", () => {
    const runMacro = vi.fn();
    const stopMacro = vi.fn();
    const off = registerPaneActions("p4", { ...stub(), runMacro, stopMacro });
    expect(runMacroOnPane("p4", { name: "m", text: "end" })).toBe(true);
    expect(runMacro).toHaveBeenCalledWith({ name: "m", text: "end" });
    expect(stopMacroOnPane("p4")).toBe(true);
    expect(stopMacro).toHaveBeenCalled();
    off();
    expect(runMacroOnPane("p4", { name: "m", text: "end" })).toBe(false);
    expect(stopMacroOnPane("p4")).toBe(false);
  });
});

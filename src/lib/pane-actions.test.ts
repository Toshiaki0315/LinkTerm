import { describe, expect, it, vi } from "vitest";
import { registerPaneActions, runPaneAction } from "./pane-actions";

describe("pane-actions", () => {
  it("登録したペインの操作を呼べ、解除すると呼べない", () => {
    const exportText = vi.fn();
    const off = registerPaneActions("p1", { exportText });
    expect(runPaneAction("p1", "exportText")).toBe(true);
    expect(exportText).toHaveBeenCalledTimes(1);
    off();
    expect(runPaneAction("p1", "exportText")).toBe(false);
    expect(runPaneAction("none", "exportText")).toBe(false);
  });

  it("後から同じ ID で登録したものを、古い解除が消さない", () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = registerPaneActions("p2", { exportText: first });
    const offSecond = registerPaneActions("p2", { exportText: second });
    offFirst();
    expect(runPaneAction("p2", "exportText")).toBe(true);
    expect(second).toHaveBeenCalled();
    offSecond();
  });
});

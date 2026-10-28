import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const save = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...a: unknown[]) => save(...a),
}));

import { exportText } from "./export-text";

beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockResolvedValue(undefined);
});

describe("exportText", () => {
  it("保存ダイアログで選んだ場所へ、内容を保存して、そのパスを返す", async () => {
    save.mockResolvedValue("/Users/me/out.txt");
    await expect(exportText("hello\n")).resolves.toBe("/Users/me/out.txt");
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(/^terminal-\d{8}-\d{6}\.txt$/),
      }),
    );
    expect(invoke).toHaveBeenCalledWith("save_text_file", {
      path: "/Users/me/out.txt",
      content: "hello\n",
    });
  });

  it("キャンセルしたら、何も保存しない", async () => {
    save.mockResolvedValue(null);
    await expect(exportText("x")).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

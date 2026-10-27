import { beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({ writeText: vi.fn(), readText: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => plugin);

import { copyText, pasteText } from "./clipboard";

beforeEach(() => {
  vi.clearAllMocks();
  plugin.writeText.mockResolvedValue(undefined);
  plugin.readText.mockResolvedValue("pasted");
});

describe("clipboard", () => {
  it("テキストをクリップボードへ書き込む", async () => {
    await copyText("hello 日本語");
    expect(plugin.writeText).toHaveBeenCalledWith("hello 日本語");
  });

  it("空文字のコピーは何もしない（クリップボードを空にしない）", async () => {
    await copyText("");
    expect(plugin.writeText).not.toHaveBeenCalled();
  });

  it("クリップボードのテキストを読み出す", async () => {
    await expect(pasteText()).resolves.toBe("pasted");
  });

  it("クリップボードが空・テキスト以外のときは空文字を返す", async () => {
    plugin.readText.mockRejectedValue("clipboard is empty");
    await expect(pasteText()).resolves.toBe("");
    plugin.readText.mockResolvedValue(null);
    await expect(pasteText()).resolves.toBe("");
  });

  it("書き込みの失敗は呼び出し元へ伝える", async () => {
    plugin.writeText.mockRejectedValue(new Error("denied"));
    await expect(copyText("x")).rejects.toThrow("denied");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const open = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => open(...a),
}));
const api = vi.hoisted(() => ({ readMacroFile: vi.fn() }));
vi.mock("./terminal-api", () => api);

import { pickMacroFile } from "./macro-file";

beforeEach(() => vi.clearAllMocks());

describe("pickMacroFile", () => {
  it("ファイルを選ぶダイアログ（.ttl を既定の種類に）を開き、内容と名前を返す", async () => {
    open.mockResolvedValue("/Users/me/scripts/login.ttl");
    api.readMacroFile.mockResolvedValue("sendln 'x'");
    await expect(pickMacroFile()).resolves.toEqual({
      name: "login",
      text: "sendln 'x'",
    });
    expect(open).toHaveBeenCalledWith({
      multiple: false,
      directory: false,
      filters: [
        { name: "Tera Term マクロ", extensions: ["ttl"] },
        { name: "すべてのファイル", extensions: ["*"] },
      ],
    });
    expect(api.readMacroFile).toHaveBeenCalledWith(
      "/Users/me/scripts/login.ttl",
    );
  });

  it("キャンセルなら null（何も読まない）", async () => {
    open.mockResolvedValue(null);
    await expect(pickMacroFile()).resolves.toBeNull();
    expect(api.readMacroFile).not.toHaveBeenCalled();
  });

  it("読み込みの失敗は、そのまま例外にする（画面が理由を表示する）", async () => {
    open.mockResolvedValue("/a.ttl");
    api.readMacroFile.mockRejectedValue("大きすぎます");
    await expect(pickMacroFile()).rejects.toBe("大きすぎます");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ pickMacroFile: vi.fn() }));
vi.mock("./terminal-api", () => api);

import { pickMacroFile } from "./macro-file";

beforeEach(() => vi.clearAllMocks());

describe("pickMacroFile", () => {
  it("バックエンドが選んで読んだ内容と名前を返す（画面はパスを扱わない）", async () => {
    api.pickMacroFile.mockResolvedValue({ name: "login", text: "sendln 'x'" });
    await expect(pickMacroFile()).resolves.toEqual({
      name: "login",
      text: "sendln 'x'",
    });
    expect(api.pickMacroFile).toHaveBeenCalledWith();
  });

  it("キャンセルなら null", async () => {
    api.pickMacroFile.mockResolvedValue(null);
    await expect(pickMacroFile()).resolves.toBeNull();
  });

  it("読み込みの失敗は、そのまま例外にする（画面が理由を表示する）", async () => {
    api.pickMacroFile.mockRejectedValue("大きすぎます");
    await expect(pickMacroFile()).rejects.toBe("大きすぎます");
  });
});

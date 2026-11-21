import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ saveScreenText: vi.fn() }));
vi.mock("./terminal-api", () => api);

import { exportText } from "./export-text";

beforeEach(() => vi.clearAllMocks());

describe("exportText", () => {
  it("内容と初期のファイル名だけを渡し、バックエンドが保存したパスを返す", async () => {
    api.saveScreenText.mockResolvedValue("/Users/me/out.txt");
    await expect(exportText("hello\n")).resolves.toBe("/Users/me/out.txt");
    expect(api.saveScreenText).toHaveBeenCalledWith(
      "hello\n",
      expect.stringMatching(/^terminal-\d{8}-\d{6}\.txt$/),
    );
  });

  it("キャンセルなら null", async () => {
    api.saveScreenText.mockResolvedValue(null);
    await expect(exportText("x")).resolves.toBeNull();
  });
});

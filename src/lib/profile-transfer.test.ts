import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  exportProfilesDialog: vi.fn(),
  importProfilesDialog: vi.fn(),
}));
vi.mock("./terminal-api", () => api);

import {
  describeImport,
  exportProfilesToFile,
  importProfilesFromFile,
} from "./profile-transfer";

beforeEach(() => vi.clearAllMocks());

describe("exportProfilesToFile", () => {
  it("バックエンドが書き出した先と件数を返す（画面はパスを渡さない）", async () => {
    api.exportProfilesDialog.mockResolvedValue({
      path: "/Users/me/profiles.json",
      count: 3,
    });
    await expect(exportProfilesToFile()).resolves.toEqual({
      path: "/Users/me/profiles.json",
      count: 3,
    });
    expect(api.exportProfilesDialog).toHaveBeenCalledWith();
  });

  it("キャンセルなら null", async () => {
    api.exportProfilesDialog.mockResolvedValue(null);
    await expect(exportProfilesToFile()).resolves.toBeNull();
  });
});

describe("importProfilesFromFile", () => {
  it("取り込んだ結果を返す（画面はパスを渡さない）", async () => {
    api.importProfilesDialog.mockResolvedValue({ added: 2, skipped: 1 });
    await expect(importProfilesFromFile()).resolves.toEqual({
      added: 2,
      skipped: 1,
    });
    expect(api.importProfilesDialog).toHaveBeenCalledWith();
  });

  it("キャンセルなら null", async () => {
    api.importProfilesDialog.mockResolvedValue(null);
    await expect(importProfilesFromFile()).resolves.toBeNull();
  });
});

describe("describeImport", () => {
  it("加えた件数と、加えなかった件数を知らせる", () => {
    expect(describeImport({ added: 2, skipped: 1 })).toBe(
      "2件を取り込みました（同じ内容の1件は取り込みませんでした）",
    );
    expect(describeImport({ added: 3, skipped: 0 })).toBe(
      "3件を取り込みました",
    );
    expect(describeImport({ added: 0, skipped: 2 })).toBe(
      "取り込む接続はありませんでした（同じ内容の2件はすでにあります）",
    );
    expect(describeImport({ added: 0, skipped: 0 })).toBe(
      "取り込む接続はありませんでした",
    );
  });
});

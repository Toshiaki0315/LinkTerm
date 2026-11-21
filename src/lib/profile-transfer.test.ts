import { beforeEach, describe, expect, it, vi } from "vitest";

const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);
const api = vi.hoisted(() => ({
  exportProfiles: vi.fn(),
  importProfiles: vi.fn(),
}));
vi.mock("./terminal-api", () => api);

import {
  describeImport,
  exportProfilesToFile,
  importProfilesFromFile,
} from "./profile-transfer";

beforeEach(() => vi.clearAllMocks());

describe("exportProfilesToFile", () => {
  it("保存ダイアログ（.json）で選んだ場所へ書き出し、件数とパスを返す", async () => {
    dialog.save.mockResolvedValue("/Users/me/profiles.json");
    api.exportProfiles.mockResolvedValue(3);
    await expect(exportProfilesToFile()).resolves.toEqual({
      path: "/Users/me/profiles.json",
      count: 3,
    });
    expect(dialog.save).toHaveBeenCalledWith({
      defaultPath: "linkterm-profiles.json",
      filters: [{ name: "LinkTerm の接続", extensions: ["json"] }],
    });
    expect(api.exportProfiles).toHaveBeenCalledWith("/Users/me/profiles.json");
  });

  it("キャンセルなら null（何も書かない）", async () => {
    dialog.save.mockResolvedValue(null);
    await expect(exportProfilesToFile()).resolves.toBeNull();
    expect(api.exportProfiles).not.toHaveBeenCalled();
  });
});

describe("importProfilesFromFile", () => {
  it("ファイルを選び、取り込んだ結果を返す", async () => {
    dialog.open.mockResolvedValue("/Users/me/profiles.json");
    api.importProfiles.mockResolvedValue({ added: 2, skipped: 1 });
    await expect(importProfilesFromFile()).resolves.toEqual({
      added: 2,
      skipped: 1,
    });
    expect(dialog.open).toHaveBeenCalledWith({
      multiple: false,
      directory: false,
      filters: [
        { name: "LinkTerm の接続", extensions: ["json"] },
        { name: "すべてのファイル", extensions: ["*"] },
      ],
    });
    expect(api.importProfiles).toHaveBeenCalledWith("/Users/me/profiles.json");
  });

  it("キャンセルなら null（何も読まない）", async () => {
    dialog.open.mockResolvedValue(null);
    await expect(importProfilesFromFile()).resolves.toBeNull();
    expect(api.importProfiles).not.toHaveBeenCalled();
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

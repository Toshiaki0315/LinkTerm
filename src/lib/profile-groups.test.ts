import { describe, expect, it } from "vitest";
import {
  NO_FOLDER,
  folderNames,
  formatTags,
  groupProfiles,
  parseTagInput,
  profileDisplayName,
  profileMatches,
  tagNames,
} from "./profile-groups";
import type { SavedProfile } from "./terminal-api";

const p = (
  id: string,
  name: string,
  folder?: string,
  tags?: string[],
): SavedProfile => ({ id, name, values: {}, folder, tags });

describe("groupProfiles", () => {
  it("フォルダーごとに分け、フォルダーは名前順・未分類は最後。中は名前順", () => {
    const groups = groupProfiles([
      p("1", "web-2", "本番"),
      p("2", "loose"),
      p("3", "web-10", "本番"),
      p("4", "db", "検証"),
      p("5", "web-1", "本番"),
    ]);
    expect(groups.map((g) => g.folder)).toEqual(["検証", "本番", NO_FOLDER]);
    expect(groups[1].profiles.map((x) => x.name)).toEqual([
      "web-1",
      "web-2",
      "web-10",
    ]);
  });

  it("空・空白だけのフォルダーは未分類として扱う。接続がなければ空", () => {
    expect(groupProfiles([p("1", "a", "  ")])[0].folder).toBe(NO_FOLDER);
    expect(groupProfiles([])).toEqual([]);
  });
});

describe("folderNames / tagNames", () => {
  const list = [
    p("1", "a", "本番", ["Web", "db"]),
    p("2", "b", "検証", ["web"]),
    p("3", "c"),
  ];
  it("使われているフォルダー（未分類を除く）とタグ（大文字小文字を区別しない）", () => {
    expect(folderNames(list)).toEqual(["検証", "本番"]);
    expect(tagNames(list)).toEqual(["db", "Web"]);
  });
});

describe("parseTagInput / formatTags", () => {
  it("カンマ（全角の読点も）で区切り、空と重複を除く", () => {
    expect(parseTagInput(" web, DB、 web ,, ")).toEqual(["web", "DB"]);
    expect(parseTagInput("")).toEqual([]);
    expect(formatTags(["a", "b"])).toBe("a, b");
    expect(formatTags(undefined)).toBe("");
  });
});

describe("profileDisplayName / profileMatches", () => {
  it("フォルダーがあれば前に付ける", () => {
    expect(profileDisplayName(p("1", "web", "本番"))).toBe("本番 / web");
    expect(profileDisplayName(p("1", "web"))).toBe("web");
  });

  it("名前・フォルダー・タグのどれかに、すべての語が含まれる（全角半角・大文字小文字を区別しない）", () => {
    const x = p("1", "Web-01", "本番", ["東京", "nginx"]);
    expect(profileMatches(x, "")).toBe(true);
    expect(profileMatches(x, "web 本番")).toBe(true);
    expect(profileMatches(x, "東京 NGINX")).toBe(true);
    expect(profileMatches(x, "ＷＥＢ")).toBe(true);
    expect(profileMatches(x, "大阪")).toBe(false);
    expect(profileMatches(x, "web 大阪")).toBe(false);
  });
});

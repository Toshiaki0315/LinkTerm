import type { SavedProfile } from "./terminal-api";

/** フォルダーに入れていない接続のグループ名。 */
export const NO_FOLDER = "";

export interface ProfileGroup {
  /** フォルダー名（`NO_FOLDER` は未分類）。 */
  folder: string;
  profiles: SavedProfile[];
}

const collator = new Intl.Collator("ja", {
  numeric: true,
  sensitivity: "base",
});

/**
 * 保存済みの接続をフォルダーごとに分ける。フォルダーは名前順で、未分類は最後。
 * 各グループの中は、名前順。
 */
export function groupProfiles(profiles: SavedProfile[]): ProfileGroup[] {
  const map = new Map<string, SavedProfile[]>();
  for (const p of profiles) {
    const key = p.folder?.trim() || NO_FOLDER;
    map.set(key, [...(map.get(key) ?? []), p]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => {
      if (a === b) return 0;
      if (a === NO_FOLDER) return 1;
      if (b === NO_FOLDER) return -1;
      return collator.compare(a, b);
    })
    .map(([folder, list]) => ({
      folder,
      profiles: [...list].sort((a, b) => collator.compare(a.name, b.name)),
    }));
}

/** 使われているフォルダー名（名前順）。 */
export function folderNames(profiles: SavedProfile[]): string[] {
  return groupProfiles(profiles)
    .map((g) => g.folder)
    .filter((f) => f !== NO_FOLDER);
}

/** 使われているタグ（大文字小文字を区別せず、名前順。表記は最初に出たもの）。 */
export function tagNames(profiles: SavedProfile[]): string[] {
  const seen = new Map<string, string>();
  for (const p of profiles) {
    for (const tag of p.tags ?? []) {
      if (!seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
    }
  }
  return [...seen.values()].sort(collator.compare);
}

/** 入力の「a, b」を、タグの配列にする（空・重複を除く）。 */
export function parseTagInput(text: string): string[] {
  const tags: string[] = [];
  for (const raw of text.split(/[,、]/)) {
    const tag = raw.trim();
    if (tag && !tags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
      tags.push(tag);
    }
  }
  return tags;
}

/** タグの配列を、入力欄の「a, b」にする。 */
export const formatTags = (tags: string[] | undefined) =>
  (tags ?? []).join(", ");

/** 表示名（フォルダーがあれば `フォルダー / 名前`）。 */
export const profileDisplayName = (p: SavedProfile) =>
  p.folder ? `${p.folder} / ${p.name}` : p.name;

/** 検索語（空白区切り）に、名前・フォルダー・タグのすべての語が一致するか。 */
export function profileMatches(p: SavedProfile, query: string): boolean {
  const tokens = query
    .normalize("NFKC")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const haystack = [p.name, p.folder ?? "", ...(p.tags ?? [])]
    .join(" ")
    .normalize("NFKC")
    .toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

import { describe, expect, it } from "vitest";
import { filterCommands, type PaletteCommand } from "./command-search";

const cmd = (
  id: string,
  title: string,
  extra: Partial<PaletteCommand> = {},
): PaletteCommand => ({ id, title, group: "G", run: () => {}, ...extra });

const ids = (list: PaletteCommand[]) => list.map((c) => c.id);

describe("filterCommands", () => {
  const all = [
    cmd("new", "新しい接続"),
    cmd("settings", "設定を開く", { keywords: "preferences" }),
    cmd("close", "タブを閉じる"),
    cmd("tab-prod", "タブへ移動: production"),
    cmd("split", "右に分割", { group: "画面分割" }),
  ];

  it("空の入力は、すべてを元の並びで返す", () => {
    expect(filterCommands(all, "")).toBe(all);
    expect(ids(filterCommands(all, "   "))).toEqual(ids(all));
  });

  it("題名に含まれるものに絞る", () => {
    expect(ids(filterCommands(all, "接続"))).toEqual(["new"]);
    expect(ids(filterCommands(all, "タブ"))).toEqual(["close", "tab-prod"]);
  });

  it("空白区切りの語は、すべて含むものだけ（AND）。順序は問わない", () => {
    expect(ids(filterCommands(all, "タブ production"))).toEqual(["tab-prod"]);
    expect(ids(filterCommands(all, "production タブ"))).toEqual(["tab-prod"]);
    expect(filterCommands(all, "タブ 存在しない")).toEqual([]);
  });

  it("別名（keywords）とグループ名でも見つかる。題名への一致を優先する", () => {
    expect(ids(filterCommands(all, "preferences"))).toEqual(["settings"]);
    expect(ids(filterCommands(all, "画面分割"))).toEqual(["split"]);
    const list = [
      cmd("a", "別の項目", { keywords: "接続" }),
      cmd("b", "新しい接続"),
    ];
    expect(ids(filterCommands(list, "接続"))).toEqual(["b", "a"]);
  });

  it("先頭一致・単語の先頭一致を、途中の一致より上に並べる", () => {
    const list = [
      cmd("mid", "reproduce it"),
      cmd("word", "go prod now"),
      cmd("head", "prod first"),
    ];
    expect(ids(filterCommands(list, "prod"))).toEqual(["head", "word", "mid"]);
  });

  it("大文字小文字・全角半角を区別しない", () => {
    const list = [cmd("a", "Tab ＡＢＣ")];
    expect(ids(filterCommands(list, "abc"))).toEqual(["a"]);
    expect(ids(filterCommands(list, "ｔａｂ"))).toEqual(["a"]);
  });

  it("点数が同じなら、元の並びを保つ", () => {
    const list = [cmd("1", "テスト A"), cmd("2", "テスト B")];
    expect(ids(filterCommands(list, "テスト"))).toEqual(["1", "2"]);
  });
});

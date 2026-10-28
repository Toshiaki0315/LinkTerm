import { describe, expect, it } from "vitest";
import { shortcutFor } from "./shortcuts";

const key = (
  k: string,
  mods: Partial<
    Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>
  > = {},
) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe("shortcutFor", () => {
  it("⌘T は新しい接続", () => {
    expect(shortcutFor(key("t", { metaKey: true }))).toEqual({ type: "new" });
  });

  it("⌘W はタブを閉じる", () => {
    expect(shortcutFor(key("w", { metaKey: true }))).toEqual({ type: "close" });
  });

  it("⌘1〜8 はその番号のタブ、⌘9 は最後のタブ", () => {
    expect(shortcutFor(key("1", { metaKey: true }))).toEqual({
      type: "select",
      index: 0,
    });
    expect(shortcutFor(key("8", { metaKey: true }))).toEqual({
      type: "select",
      index: 7,
    });
    expect(shortcutFor(key("9", { metaKey: true }))).toEqual({
      type: "select",
      index: "last",
    });
  });

  it("⌘⇧] / ⌘⇧[ で次・前のタブ（Shift 押下時の記号にも対応）", () => {
    expect(shortcutFor(key("]", { metaKey: true, shiftKey: true }))).toEqual({
      type: "next",
    });
    expect(shortcutFor(key("}", { metaKey: true, shiftKey: true }))).toEqual({
      type: "next",
    });
    expect(shortcutFor(key("[", { metaKey: true, shiftKey: true }))).toEqual({
      type: "previous",
    });
    expect(shortcutFor(key("{", { metaKey: true, shiftKey: true }))).toEqual({
      type: "previous",
    });
  });

  it("大文字（CapsLock）でも動く", () => {
    expect(shortcutFor(key("T", { metaKey: true }))).toEqual({ type: "new" });
  });

  it("⌘ なしの入力はターミナルへ渡すので無視する", () => {
    expect(shortcutFor(key("t"))).toBeNull();
    expect(shortcutFor(key("w"))).toBeNull();
    expect(shortcutFor(key("1"))).toBeNull();
  });

  it("Ctrl 単独（Ctrl+W など）はターミナルのキーなので無視する", () => {
    expect(shortcutFor(key("w", { ctrlKey: true }))).toBeNull();
    expect(shortcutFor(key("t", { ctrlKey: true }))).toBeNull();
  });

  it("他の修飾キーとの組み合わせ・未割り当てのキーは無視する", () => {
    expect(shortcutFor(key("t", { metaKey: true, altKey: true }))).toBeNull();
    expect(shortcutFor(key("t", { metaKey: true, shiftKey: true }))).toBeNull();
    expect(shortcutFor(key("0", { metaKey: true }))).toBeNull();
    expect(shortcutFor(key("c", { metaKey: true }))).toBeNull();
    expect(shortcutFor(key("v", { metaKey: true }))).toBeNull();
  });

  it("⌘F は検索（⌘⇧F や Ctrl+F は無視）", () => {
    expect(shortcutFor(key("f", { metaKey: true }))).toEqual({ type: "find" });
    expect(shortcutFor(key("F", { metaKey: true }))).toEqual({ type: "find" });
    expect(shortcutFor(key("f", { metaKey: true, shiftKey: true }))).toBeNull();
    expect(shortcutFor(key("f", { ctrlKey: true }))).toBeNull();
    expect(shortcutFor(key("f"))).toBeNull();
  });

  it("⌘D は左右に分割、⌘⇧D は上下に分割", () => {
    expect(shortcutFor(key("d", { metaKey: true }))).toEqual({
      type: "split",
      dir: "row",
    });
    expect(shortcutFor(key("D", { metaKey: true, shiftKey: true }))).toEqual({
      type: "split",
      dir: "column",
    });
    expect(shortcutFor(key("d", { ctrlKey: true }))).toBeNull();
  });

  it("⌘] / ⌘[ で次・前のペイン（⇧付きはタブ移動のまま）", () => {
    expect(shortcutFor(key("]", { metaKey: true }))).toEqual({
      type: "nextPane",
    });
    expect(shortcutFor(key("[", { metaKey: true }))).toEqual({
      type: "previousPane",
    });
    expect(shortcutFor(key("]", { metaKey: true, shiftKey: true }))).toEqual({
      type: "next",
    });
  });

  it("⌘⇧I は同時入力の切り替え（⇧なしや Ctrl 付きは無視）", () => {
    expect(shortcutFor(key("I", { metaKey: true, shiftKey: true }))).toEqual({
      type: "broadcast",
    });
    expect(shortcutFor(key("i", { metaKey: true }))).toBeNull();
    expect(shortcutFor(key("I", { ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it("⌘⇧P はコマンドパレット（⇧なしは無視）", () => {
    expect(shortcutFor(key("P", { metaKey: true, shiftKey: true }))).toEqual({
      type: "palette",
    });
    expect(shortcutFor(key("p", { metaKey: true }))).toBeNull();
  });
});

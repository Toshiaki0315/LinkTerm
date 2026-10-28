import { describe, expect, it } from "vitest";
import {
  DEFAULT_BINDINGS,
  SHORTCUT_DEFS,
  bindingFromEvent,
  formatBinding,
  overridesOf,
  resolveBindings,
  shortcutFor,
  validateBinding,
} from "./shortcuts";

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

describe("bindingFromEvent", () => {
  it("⌘ を伴う入力を、キーの組み合わせにする（Shift の記号は元のキーに戻す）", () => {
    expect(bindingFromEvent(key("p", { metaKey: true, shiftKey: true }))).toBe(
      "Cmd+Shift+p",
    );
    expect(bindingFromEvent(key("P", { metaKey: true, shiftKey: true }))).toBe(
      "Cmd+Shift+p",
    );
    expect(bindingFromEvent(key("{", { metaKey: true, shiftKey: true }))).toBe(
      "Cmd+Shift+[",
    );
    expect(bindingFromEvent(key("t", { metaKey: true }))).toBe("Cmd+t");
    expect(bindingFromEvent(key("Enter", { metaKey: true }))).toBe("Cmd+enter");
  });

  it("⌘ なし・Ctrl / Option 付き・修飾キーだけの入力は扱わない", () => {
    expect(bindingFromEvent(key("t"))).toBeNull();
    expect(
      bindingFromEvent(key("t", { metaKey: true, ctrlKey: true })),
    ).toBeNull();
    expect(
      bindingFromEvent(key("t", { metaKey: true, altKey: true })),
    ).toBeNull();
    expect(bindingFromEvent(key("Meta", { metaKey: true }))).toBeNull();
    expect(
      bindingFromEvent(key("Shift", { metaKey: true, shiftKey: true })),
    ).toBeNull();
  });
});

describe("formatBinding", () => {
  it("記号で表す", () => {
    expect(formatBinding("Cmd+Shift+p")).toBe("⇧⌘P");
    expect(formatBinding("Cmd+Shift+]")).toBe("⇧⌘]");
    expect(formatBinding("Cmd+enter")).toBe("⌘↩");
    expect(formatBinding("Cmd+arrowleft")).toBe("⌘←");
    expect(formatBinding("Cmd+f5")).toBe("⌘f5");
    expect(formatBinding("Cmd+Shift++")).toBe("⇧⌘+");
  });
});

describe("validateBinding", () => {
  const cur = DEFAULT_BINDINGS;
  it("使えるキーは null", () => {
    expect(validateBinding("palette", "Cmd+k", cur)).toBeNull();
    expect(validateBinding("palette", "Cmd+Shift+p", cur)).toBeNull();
    expect(validateBinding("new", "Cmd+enter", cur)).toBeNull();
  });
  it("⌘ なし・形が違うものは拒否する", () => {
    expect(validateBinding("new", "t", cur)).toMatch(/⌘/);
    expect(validateBinding("new", "Ctrl+t", cur)).toMatch(/⌘/);
    expect(validateBinding("new", "Cmd+", cur)).toMatch(/⌘/);
  });
  it("コピーなどシステムの操作と、番号でタブを選ぶキーは拒否する", () => {
    expect(validateBinding("new", "Cmd+c", cur)).toMatch(/システム/);
    expect(validateBinding("new", "Cmd+,", cur)).toMatch(/システム/);
    expect(validateBinding("new", "Cmd+5", cur)).toMatch(/番号/);
  });
  it("ほかの操作と重複するときは、その操作名を示して拒否する。自分自身との重複は許す", () => {
    expect(validateBinding("new", "Cmd+w", cur)).toMatch(
      /タブ／ペインを閉じる/,
    );
    expect(validateBinding("new", "Cmd+t", cur)).toBeNull();
  });
});

describe("resolveBindings / overridesOf", () => {
  it("保存された割り当てを、初期値に重ねる。変えていないものは初期値のまま", () => {
    const b = resolveBindings([{ id: "palette", binding: "Cmd+k" }]);
    expect(b.palette).toBe("Cmd+k");
    expect(b.new).toBe("Cmd+t");
  });

  it("未知の操作・不正な値・重複は無視する（初期値のまま）", () => {
    const b = resolveBindings([
      { id: "nope", binding: "Cmd+k" },
      { id: "new", binding: "Cmd+c" },
      { id: "find", binding: "Cmd+w" },
      { id: "palette", binding: "Cmd+k" },
      { id: "broadcast", binding: "Cmd+k" },
    ]);
    expect(b.new).toBe("Cmd+t");
    expect(b.find).toBe("Cmd+f");
    expect(b.palette).toBe("Cmd+k");
    expect(b.broadcast).toBe("Cmd+Shift+i");
  });

  it("overridesOf は、変えたものだけを返し、resolveBindings で元に戻る", () => {
    expect(overridesOf(DEFAULT_BINDINGS)).toEqual([]);
    const changed = { ...DEFAULT_BINDINGS, palette: "Cmd+k" };
    expect(overridesOf(changed)).toEqual([{ id: "palette", binding: "Cmd+k" }]);
    expect(resolveBindings(overridesOf(changed))).toEqual(changed);
  });

  it("初期値どうしは重複せず、すべて検証を通る", () => {
    for (const d of SHORTCUT_DEFS) {
      expect(validateBinding(d.id, d.binding, DEFAULT_BINDINGS)).toBeNull();
    }
  });
});

describe("shortcutFor（割り当てを変えたとき）", () => {
  const custom = resolveBindings([{ id: "palette", binding: "Cmd+k" }]);
  it("新しいキーで動き、古いキーは動かない", () => {
    expect(shortcutFor(key("k", { metaKey: true }), custom)).toEqual({
      type: "palette",
    });
    expect(
      shortcutFor(key("P", { metaKey: true, shiftKey: true }), custom),
    ).toBeNull();
  });
  it("⌘1〜9 は、割り当てを変えても固定", () => {
    expect(shortcutFor(key("9", { metaKey: true }), custom)).toEqual({
      type: "select",
      index: "last",
    });
  });
});

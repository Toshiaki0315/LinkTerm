import { describe, expect, it } from "vitest";

/** 生の `<input>` / `<textarea>` を、タグの終わりまで切り出す。 */
function elements(source: string): string[] {
  const found: string[] = [];
  const re = /<(input|textarea)\b/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let depth = 0;
    let i = m.index;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    found.push(source.slice(m.index, i + 1));
  }
  return found;
}

const NON_TEXT = /type="(checkbox|radio|range|number|password|file)"/;

describe("入力欄の自動補正の停止（macOS の自動大文字化など）", () => {
  const sources = import.meta.glob<string>(
    ["../components/*.tsx", "!../components/*.test.tsx"],
    { query: "?raw", import: "default", eager: true },
  );

  it("文字を入れる生の input / textarea は、すべて PLAIN_TEXT_PROPS を付けている", () => {
    const missing: string[] = [];
    let checked = 0;
    for (const [file, source] of Object.entries(sources)) {
      for (const el of elements(source)) {
        if (NON_TEXT.test(el)) continue;
        checked += 1;
        if (!el.includes("PLAIN_TEXT_PROPS")) {
          missing.push(`${file}: ${el.slice(0, 60).replace(/\s+/g, " ")}`);
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3); // 走査が空振りしていないこと
    expect(missing).toEqual([]);
  });
});

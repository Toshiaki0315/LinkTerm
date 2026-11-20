import { describe, expect, it } from "vitest";
import { dropText, quotePath } from "./shell-quote";

describe("quotePath", () => {
  it("安全な文字だけのパスは、そのまま", () => {
    expect(quotePath("/Users/me/file.txt")).toBe("/Users/me/file.txt");
    expect(quotePath("/a/b-c_d.e@f+g=h:i,j%k~")).toBe(
      "/a/b-c_d.e@f+g=h:i,j%k~",
    );
  });

  it("空白・記号は、ターミナル（Terminal.app）と同じく、バックスラッシュで退避する", () => {
    expect(quotePath("/Users/me/My File.txt")).toBe("/Users/me/My\\ File.txt");
    expect(quotePath("/tmp/a&b;c|d")).toBe("/tmp/a\\&b\\;c\\|d");
    expect(quotePath("/tmp/$HOME `x` (y) 'z' \"w\" *?[]{}<>!#\\")).toBe(
      "/tmp/\\$HOME\\ \\`x\\`\\ \\(y\\)\\ \\'z\\'\\ \\\"w\\\"\\ \\*\\?\\[\\]\\{\\}\\<\\>\\!\\#\\\\",
    );
  });

  it("日本語など ASCII 以外の文字は、そのまま", () => {
    expect(quotePath("/Users/me/資料/報告書 最終.pdf")).toBe(
      "/Users/me/資料/報告書\\ 最終.pdf",
    );
  });

  it("改行・制御文字を含むパスは、入力すると実行されてしまうので、使わない", () => {
    expect(quotePath("/tmp/a\nrm -rf ~")).toBeNull();
    expect(quotePath("/tmp/a\rb")).toBeNull();
    expect(quotePath("/tmp/a\u001bb")).toBeNull();
    expect(quotePath("/tmp/a\u007fb")).toBeNull();
    expect(quotePath("/tmp/a\u0000b")).toBeNull();
  });

  it("空のパスは使わない", () => {
    expect(quotePath("")).toBeNull();
  });
});

describe("dropText", () => {
  it("複数のパスは空白で区切り、最後に空白を付ける（続けて打てるように。実行はしない）", () => {
    expect(dropText(["/a/b", "/c d"])).toBe("/a/b /c\\ d ");
  });

  it("使えないパスは除く。すべて使えなければ空", () => {
    expect(dropText(["/a\nb", "/ok"])).toBe("/ok ");
    expect(dropText(["/a\nb"])).toBe("");
    expect(dropText([])).toBe("");
  });

  it("末尾に改行を付けない", () => {
    expect(dropText(["/x"])).not.toMatch(/[\r\n]/);
  });
});

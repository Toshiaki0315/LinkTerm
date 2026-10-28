import { describe, expect, it } from "vitest";
import {
  baseName,
  formatModified,
  formatSize,
  joinPath,
  parentPath,
  progressPercent,
} from "./sftp";

describe("sftp helpers", () => {
  it("parentPath", () => {
    expect(parentPath("/a/b/c")).toBe("/a/b");
    expect(parentPath("/a/b/")).toBe("/a");
    expect(parentPath("/a")).toBe("/");
    expect(parentPath("/")).toBe("/");
    expect(parentPath("")).toBe("/");
  });

  it("joinPath", () => {
    expect(joinPath("/", "a")).toBe("/a");
    expect(joinPath("/x", "a")).toBe("/x/a");
    expect(joinPath("/x/", "a")).toBe("/x/a");
  });

  it("baseName はローカルのパスからファイル名を取り出す", () => {
    expect(baseName("/Users/me/file.txt")).toBe("file.txt");
    expect(baseName("C:\\dir\\file.txt")).toBe("file.txt");
    expect(baseName("file.txt")).toBe("file.txt");
    expect(baseName("/dir/")).toBe("dir");
  });

  it("formatSize", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1024)).toBe("1 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(1024 * 1024 * 250)).toBe("250 MB");
    expect(formatSize(5 * 1024 ** 4)).toBe("5 TB");
    expect(formatSize(-1)).toBe("");
    expect(formatSize(NaN)).toBe("");
  });

  it("formatModified", () => {
    expect(formatModified(null)).toBe("");
    const s = new Date(2024, 0, 2, 3, 4).getTime() / 1000;
    expect(formatModified(s)).toBe("2024-01-02 03:04");
  });

  it("progressPercent", () => {
    expect(progressPercent(50, 200)).toBe(25);
    expect(progressPercent(300, 200)).toBe(100);
    expect(progressPercent(0, 0)).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const opener = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => opener);

import { isOpenableUrl, openExternalUrl } from "./open-url";

beforeEach(() => {
  vi.clearAllMocks();
  opener.openUrl.mockResolvedValue(undefined);
});

describe("isOpenableUrl", () => {
  it("http / https だけを開ける", () => {
    expect(isOpenableUrl("https://example.com/path?q=1#frag")).toBe(true);
    expect(isOpenableUrl("http://localhost:8080")).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "ftp://example.com",
    "mailto:a@example.com",
    "data:text/html,<script>1</script>",
    "tauri://localhost",
    "//example.com",
    "example.com",
    "",
    "   ",
    "https://",
    "not a url",
  ])("%s は開かない", (url) => {
    expect(isOpenableUrl(url)).toBe(false);
  });
});

describe("openExternalUrl", () => {
  it("開けるURLだけを OS の既定のアプリで開く", async () => {
    await openExternalUrl("https://example.com");
    expect(opener.openUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("開けないURLは、プラグインを呼ばずにエラーにする", async () => {
    await expect(openExternalUrl("javascript:alert(1)")).rejects.toThrow(
      /開けません/,
    );
    expect(opener.openUrl).not.toHaveBeenCalled();
  });

  it("開く処理の失敗は呼び出し元へ伝える", async () => {
    opener.openUrl.mockRejectedValue(new Error("no handler"));
    await expect(openExternalUrl("https://example.com")).rejects.toThrow(
      "no handler",
    );
  });
});

import { test, expect, type Page } from "@playwright/test";
import conf from "../src-tauri/tauri.conf.json" with { type: "json" };
import { openApp, openLocalTab, output, openSettings } from "./helpers";

// 製品の CSP（tauri.conf.json）を、製品と同じ形にバンドルした画面へ付けて、
// 違反（読み込み・実行の拒否）が1件も出ないことを確かめる。
const CSP: string = conf.app.security.csp;

test.use({ baseURL: "http://127.0.0.1:1521" });

async function withCsp(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.route("**/e2e/index.html", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), "content-security-policy": CSP },
    });
  });
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __csp: string[] }).__csp.push(
        `${e.violatedDirective}: ${e.blockedURI} @ ${e.sourceFile}:${e.lineNumber}:${e.columnNumber} ${e.sample}`,
      );
    });
  });
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) {
      violations.push(m.text());
    }
  });
  return violations;
}

const collected = (page: Page) =>
  page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);

test.describe("CSP（tauri.conf.json）", () => {
  test("CSP が設定されていて、危険な指定を含まない", () => {
    expect(CSP).toBeTruthy();
    expect(CSP).toContain("default-src 'self'");
    expect(CSP).toContain("object-src 'none'");
    expect(CSP).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(CSP).not.toMatch(/script-src[^;]*'unsafe-eval'/);
    expect(CSP).not.toMatch(/\*/);
  });

  test("画面・端末・設定・画像表示が、CSP の違反なしで動く", async ({
    page,
  }) => {
    const violations = await withCsp(page);
    await openApp(page);
    await openLocalTab(page);
    await output(page, "hello csp\r\n");
    await expect(page.locator(".xterm-rows").first()).toContainText(
      "hello csp",
    );
    // sixel 画像（WebAssembly・blob の使用）
    await output(page, '\x1bPq"1;1;20;12#0;2;100;0;0#0!20~-!20~\x1b\\\r\n');
    await expect(page.locator(".xterm canvas").first()).toBeAttached();
    await openSettings(page);
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await collected(page)).toEqual([]);
    expect(violations).toEqual([]);
  });
});

import { test, expect } from "@playwright/test";
import { openApp, openLocalTab, output, screenText, written } from "./helpers";

test("ローカルシェルを開き、入力が届いて画面に出る", async ({ page }) => {
  await openApp(page);
  await openLocalTab(page);
  await expect(screenText(page)).toContainText("$");
  await page.locator(".xterm").first().click();
  await page.keyboard.type("echo hi");
  await page.keyboard.press("Enter");
  await expect(screenText(page)).toContainText("echo hi");
  expect(await written(page)).toBe("echo hi\r");
});

test("出力が画面に出る", async ({ page }) => {
  await openApp(page);
  await openLocalTab(page);
  await output(page, "hello\r\nworld\r\n");
  await expect(screenText(page)).toContainText("hello");
  await expect(screenText(page)).toContainText("world");
});

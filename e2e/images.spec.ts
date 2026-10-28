import { test, expect } from "@playwright/test";
import { openApp, openLocalTab, output, screenText } from "./helpers";

// 1x1 の赤い PNG。
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const images = (page: import("@playwright/test").Page) =>
  page.locator(".xterm canvas");

test.describe("画像表示", () => {
  test("iTerm2 方式（imgcat）のインライン画像が端末内に表示される", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await expect(images(page)).toHaveCount(0);
    const size = atob(PNG).length;
    await output(
      page,
      `\x1b]1337;File=inline=1;size=${size};width=4;height=2:${PNG}\x07\r\n`,
    );
    await expect(images(page).first()).toBeAttached();
  });

  test("sixel の画像が端末内に表示される", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await output(page, '\x1bPq"1;1;20;12#0;2;100;0;0#0!20~-!20~\x1b\\\r\n');
    await expect(images(page).first()).toBeAttached();
  });

  test("巨大な画像を指定されても、アプリは固まらず、その後の出力も表示される", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    // 50000 x 50000 画素を名乗る sixel。
    await output(page, '\x1bPq"1;1;50000;50000#0;2;100;0;0#0!50000~\x1b\\\r\n');
    await output(page, "still alive\r\n");
    await expect(screenText(page)).toContainText("still alive");
  });
});

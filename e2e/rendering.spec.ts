import { test, expect } from "@playwright/test";
import {
  clickCell,
  openApp,
  openLocalTab,
  openedUrls,
  output,
  screenText,
} from "./helpers";

const rule = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  pattern: "ERROR",
  regex: false,
  caseSensitive: false,
  color: "red",
  notify: false,
  ...over,
});

test.describe("ハイライト", () => {
  test("一致した部分に色が付く。大文字小文字は規則に従う", async ({ page }) => {
    await openApp(page, { highlights: [rule()] });
    await openLocalTab(page);
    await output(page, "an ERROR here\r\n");
    await expect(page.locator(".xterm-decoration")).toHaveCount(1);
    await output(page, "an error here\r\n");
    await expect(page.locator(".xterm-decoration")).toHaveCount(2);
  });

  test("大文字小文字を区別する規則では、小文字は塗らない", async ({ page }) => {
    await openApp(page, { highlights: [rule({ caseSensitive: true })] });
    await openLocalTab(page);
    await output(page, "error\r\nERROR\r\n");
    await expect(page.locator(".xterm-decoration")).toHaveCount(1);
  });

  test("正規表現が効く", async ({ page }) => {
    await openApp(page, {
      highlights: [rule({ pattern: "fail(ed)?", regex: true })],
    });
    await openLocalTab(page);
    await output(page, "fail\r\nfailed\r\nfine\r\n");
    await expect(page.locator(".xterm-decoration")).toHaveCount(2);
  });

  test("一致した文字は、規則の色（赤）で実際に塗られる", async ({ page }) => {
    await openApp(page, { highlights: [rule()] });
    await openLocalTab(page);
    await output(page, "\r\nan ERROR here\r\n");
    const painted = () =>
      page.evaluate(() =>
        [...document.querySelectorAll(".xterm-rows span")]
          .filter(
            (e) => getComputedStyle(e).backgroundColor === "rgb(239, 68, 68)",
          )
          .map((e) => e.textContent)
          .join(""),
      );
    await expect.poll(painted).toBe("ERROR");
  });

  test("全角を含む行でも、塗る位置と幅がずれない", async ({ page }) => {
    await openApp(page, { highlights: [rule()] });
    await openLocalTab(page);
    await output(page, "\r\n日本語ERROR\r\n");
    const painted = () =>
      page.evaluate(() =>
        [...document.querySelectorAll(".xterm-rows span")]
          .filter(
            (e) => getComputedStyle(e).backgroundColor === "rgb(239, 68, 68)",
          )
          .map((e) => e.textContent)
          .join(""),
      );
    // 全角の「日本語」には掛からず、ERROR だけ。
    await expect.poll(painted).toBe("ERROR");
    const geometry = await page.evaluate(() => {
      // 入力用の欄の幅が、1セルの幅。
      const cell = document
        .querySelector(".xterm-helper-textarea")!
        .getBoundingClientRect().width;
      const rowEl = document.querySelectorAll(".xterm-rows > div")[1];
      const span = [...rowEl.querySelectorAll("span")].find(
        (e) => getComputedStyle(e).backgroundColor === "rgb(239, 68, 68)",
      )!;
      const rect = span.getBoundingClientRect();
      return {
        cell,
        offset: rect.x - rowEl.getBoundingClientRect().x,
      };
    });
    // 全角3文字 = 6セルのあとから始まる。
    expect(Math.abs(geometry.offset - geometry.cell * 6)).toBeLessThan(1);
  });

  test("規則を消すと、塗られていた色が消える", async ({ page }) => {
    await openApp(page, { highlights: [rule()] });
    await openLocalTab(page);
    await output(page, "ERROR\r\n");
    await expect(page.locator(".xterm-decoration")).toHaveCount(1);
    await page.getByRole("button", { name: "キーワードの強調・通知" }).click();
    await page.getByRole("button", { name: "ERROR を削除" }).click();
    await expect(page.locator(".xterm-decoration")).toHaveCount(0);
  });
});

test.describe("タイムスタンプ", () => {
  test("オンにした後の行にだけ、右端へ時刻が出る。オフで消える", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await output(page, "before\r\n");
    await page.getByRole("button", { name: "タイムスタンプ表示" }).click();
    await output(page, "after one\r\nafter two\r\n");
    const stamps = page.locator(".xterm-decoration", {
      hasText: /\d\d:\d\d:\d\d/,
    });
    await expect(stamps).toHaveCount(2);
    for (const t of await stamps.allTextContents()) {
      expect(t).toMatch(/^\d\d:\d\d:\d\d$/);
    }
    await page.getByRole("button", { name: "タイムスタンプ表示" }).click();
    await expect(stamps).toHaveCount(0);
  });

  test("コピーした文字列に時刻が混ざらない", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openApp(page);
    await openLocalTab(page);
    await page.getByRole("button", { name: "タイムスタンプ表示" }).click();
    await output(page, "plain text\r\n");
    await expect(
      page.locator(".xterm-decoration", { hasText: /\d\d:\d\d:\d\d/ }),
    ).toHaveCount(1);
    await page.locator(".xterm").first().click({ button: "right" });
    await page.getByText("すべて選択").click();
    const selected = await page.evaluate(
      () => window.getSelection()?.toString() ?? "",
    );
    expect(selected).not.toMatch(/\d\d:\d\d:\d\d/);
  });

  test("右端近くまで文字がある行には時刻を出さない", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.getByRole("button", { name: "タイムスタンプ表示" }).click();
    const cols = await page.evaluate(() => {
      const w = document
        .querySelector(".xterm-screen")!
        .getBoundingClientRect().width;
      return Math.floor(w / 8);
    });
    await output(page, "x".repeat(Math.max(10, cols - 3)) + "\r\n");
    await page.waitForTimeout(300);
    await expect(
      page.locator(".xterm-decoration", { hasText: /\d\d:\d\d:\d\d/ }),
    ).toHaveCount(0);
  });
});

test.describe("リンク", () => {
  const link = "\x1b]8;;https://example.com/\x1b\\リンク\x1b]8;;\x1b\\\r\n";

  test("OSC 8 のリンクは ⌘+クリックで開き、⌘なしでは開かない", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    // 先頭行は「$ 」のあと（2列目から）。
    await output(page, link);
    await expect(screenText(page)).toContainText("リンク");
    await clickCell(page, 0, 3);
    expect(await openedUrls(page)).toEqual([]);
    await clickCell(page, 0, 3, ["Meta"]);
    await expect
      .poll(() => openedUrls(page))
      .toEqual([expect.stringContaining("https://example.com/")]);
  });

  test("本文中の URL も ⌘+クリックで開く", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await output(page, "see https://example.org/docs now\r\n");
    await expect(screenText(page)).toContainText("example.org");
    await clickCell(page, 0, 10, ["Meta"]);
    await expect
      .poll(() => openedUrls(page))
      .toEqual([expect.stringContaining("https://example.org/docs")]);
  });
});

test.describe("ベル", () => {
  test("見ているタブでは画面が一瞬光る", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await output(page, "\x07");
    await expect(page.getByTestId("bell-flash")).toBeVisible();
    await expect(page.getByTestId("bell-flash")).toHaveCount(0);
  });
});

test.describe("見た目の設定", () => {
  test("背景の不透明度 60% で、端末の背景が半透明になる", async ({ page }) => {
    await openApp(page, { settings: { backgroundOpacity: 60 } });
    await openLocalTab(page);
    const bg = await page.evaluate(
      () =>
        getComputedStyle(document.querySelector(".xterm-scrollable-element")!)
          .backgroundColor,
    );
    expect(bg).toMatch(/rgba\(.*0\.6\)/);
  });

  test("100% では完全に不透明", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    const bg = await page.evaluate(
      () =>
        getComputedStyle(document.querySelector(".xterm-scrollable-element")!)
          .backgroundColor,
    );
    expect(bg).not.toMatch(/rgba/);
  });

  for (const [style, cls] of [
    ["bar", "xterm-cursor-bar"],
    ["underline", "xterm-cursor-underline"],
    ["block", "xterm-cursor-block"],
  ] as const) {
    test(`カーソルの形 ${style} が反映される`, async ({ page }) => {
      await openApp(page, {
        settings: { cursorStyle: style, cursorBlink: false },
      });
      await openLocalTab(page);
      await output(page, "x");
      await expect(page.locator(`.${cls}`).first()).toBeVisible();
    });
  }
});

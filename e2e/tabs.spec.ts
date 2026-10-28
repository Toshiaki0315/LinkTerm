import { test, expect, type Page } from "@playwright/test";
import { openApp, openLocalTab, output, restart, screenText } from "./helpers";

const tabs = (page: Page) => page.getByRole("tab");

test.describe("検索", () => {
  test("⌘F で検索バーが開き、入力でハイライト、Enter / ⇧Enter で移動、Esc で閉じる", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await output(page, "alpha beta\r\nalpha gamma\r\n");
    await page.locator(".xterm").first().click();
    await page.keyboard.press("Meta+f");
    const box = page.getByRole("textbox", { name: "検索" });
    await expect(box).toBeVisible();
    await box.fill("alpha");
    await box.press("Enter");
    // 一致した部分が選択（強調）される。
    await expect(page.locator(".xterm-selection div").first()).toBeAttached();
    await box.press("Shift+Enter");
    await box.press("Escape");
    await expect(box).toHaveCount(0);
  });
});

test.describe("タブ", () => {
  test("⌘T で接続ダイアログ、接続でタブが増える。⌘W で閉じる", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await expect(tabs(page)).toHaveCount(1);
    await page.keyboard.press("Meta+t");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await expect(tabs(page)).toHaveCount(2);
    await page.keyboard.press("Meta+w");
    await expect(tabs(page)).toHaveCount(1);
  });

  test("⌘1〜9 と ⌘⇧[ ] でタブを切り替える", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press("Meta+t");
      await page.getByRole("button", { name: "接続", exact: true }).click();
    }
    await expect(tabs(page)).toHaveCount(3);
    await page.keyboard.press("Meta+1");
    await expect(tabs(page).nth(0)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Meta+3");
    await expect(tabs(page).nth(2)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Meta+Shift+[");
    await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Meta+Shift+]");
    await expect(tabs(page).nth(2)).toHaveAttribute("aria-selected", "true");
  });

  test("ダブルクリックで名前を変更できる", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await tabs(page).first().dblclick();
    const input = page.getByRole("textbox", { name: "タブ名" });
    await input.fill("本番サーバー");
    await input.press("Enter");
    await expect(tabs(page).first()).toContainText("本番サーバー");
  });

  test("右クリックの「名前を変更」と「複製」", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await tabs(page).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "複製" }).click();
    await expect(tabs(page)).toHaveCount(2);
    await tabs(page).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "名前を変更" }).click();
    await expect(page.getByRole("textbox", { name: "タブ名" })).toBeVisible();
  });

  test("タブの色を付ける・外す", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await tabs(page).first().click({ button: "right" });
    await page.getByRole("menuitemradio", { name: "色: 赤" }).click();
    await expect(page.locator('[data-tab-color="red"]')).toBeVisible();
    await tabs(page).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "色を外す" }).click();
    await expect(page.locator("[data-tab-color]")).toHaveCount(0);
  });

  test("タブをドラッグして並べ替える", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await tabs(page).first().dblclick();
    const input = page.getByRole("textbox", { name: "タブ名" });
    await input.fill("一番目");
    await input.press("Enter");
    await page.keyboard.press("Meta+t");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await tabs(page).nth(1).dblclick();
    await input.fill("二番目");
    await input.press("Enter");
    const first = page.getByRole("tab", { name: /一番目/ });
    const second = page.getByRole("tab", { name: /二番目/ });
    await first.dragTo(second);
    await expect(tabs(page).first()).toContainText("二番目");
  });

  test("接続したあと、「最近使った接続」に出る。履歴を消去できる", async ({
    page,
  }) => {
    await openApp(page);
    await page.getByRole("button", { name: "新しい接続" }).click();
    await page.getByLabel("接続種別").selectOption("telnet");
    await page.getByLabel("ホスト").fill("example.com");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await expect(tabs(page)).toHaveCount(1);
    const recent = page.getByRole("button", { name: "最近使った接続" });
    await expect(recent).toBeVisible();
    await recent.click();
    await expect(
      page.getByRole("menuitem", { name: "履歴を消去" }),
    ).toBeVisible();
    await page.getByRole("menuitem", { name: "履歴を消去" }).click();
    await expect(recent).toHaveCount(0);
  });

  test("接続の履歴にパスワードを保存しない", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "新しい接続" }).click();
    await page.getByLabel("接続種別").selectOption("ssh");
    await page.getByLabel("ホスト").fill("example.com");
    await page.getByLabel("ユーザー名").fill("alice");
    await page.getByLabel("パスワード", { exact: true }).fill("hunter2");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await expect(tabs(page)).toHaveCount(1);
    const saved = await page.evaluate(() =>
      JSON.stringify([window.__e2e.recent, window.__e2e.session]),
    );
    expect(saved).not.toContain("hunter2");
  });

  test("再起動後も設定（テーマ・フォント）が保たれる", async ({ page }) => {
    await openApp(page, {
      settings: { fontSize: 17, theme: "solarized-dark" },
    });
    await openLocalTab(page);
    await restart(page);
    await openLocalTab(page);
    const size = await page.evaluate(
      () => getComputedStyle(document.querySelector(".xterm-rows")!).fontSize,
    );
    expect(size).toBe("17px");
    await expect(screenText(page)).toBeVisible();
  });
});

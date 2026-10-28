import { test, expect } from "@playwright/test";
import {
  openApp,
  openLocalTab,
  openSettings,
  openSshTab,
  output,
  restart,
  written,
} from "./helpers";

const dialog = (page: import("@playwright/test").Page) =>
  page.getByRole("dialog");

async function save(page: import("@playwright/test").Page) {
  await dialog(page).getByRole("button", { name: "保存" }).click();
  await expect(dialog(page)).toHaveCount(0);
}

test.describe("設定画面から変更", () => {
  test("配色テーマを変えると、端末と余白の背景がそろって変わる。再起動後も保たれる", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await openSettings(page);
    await dialog(page).getByLabel("配色テーマ").selectOption("solarized-dark");
    await save(page);
    const bg = () =>
      page.evaluate(() => ({
        term: getComputedStyle(
          document.querySelector(".xterm-scrollable-element")!,
        ).backgroundColor,
        tab: getComputedStyle(document.querySelector("[data-tab-id]")!)
          .backgroundColor,
      }));
    await expect.poll(async () => (await bg()).term).toBe("rgb(0, 43, 54)");
    expect((await bg()).tab).toBe("rgb(0, 43, 54)");
    await restart(page);
    await openLocalTab(page);
    expect((await bg()).term).toBe("rgb(0, 43, 54)");
  });

  test("カーソルの形を変えると、即座に反映される", async ({ page }) => {
    await openApp(page, { settings: { cursorBlink: false } });
    await openLocalTab(page);
    await output(page, "x");
    await openSettings(page);
    await dialog(page).getByLabel("カーソルの形").selectOption("bar");
    await save(page);
    await page.locator(".xterm").first().click();
    await expect(page.locator(".xterm-cursor-bar").first()).toBeVisible();
  });

  test("バックスペースキーを BS にすると ^H、DEL に戻すと ^? が送られる", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await openSettings(page);
    await dialog(page).getByLabel("バックスペースキー").selectOption("bs");
    await save(page);
    await page.locator(".xterm").first().click();
    await page.keyboard.press("Backspace");
    expect(await written(page)).toBe("\b");
    await openSettings(page);
    await dialog(page).getByLabel("バックスペースキー").selectOption("del");
    await save(page);
    await page.locator(".xterm").first().click();
    await page.keyboard.press("Backspace");
    expect(await written(page)).toBe("\b\x7f");
  });

  test("Option を Meta として使う設定のオン・オフ", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await openSettings(page);
    await dialog(page)
      .getByLabel(/Option キーを Meta/)
      .check();
    await save(page);
    await page.locator(".xterm").first().click();
    await page.keyboard.press("Alt+f");
    expect(await written(page)).toBe("\x1bf");
  });

  test("「選択したらコピー」の設定が反映される", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await output(page, "\r\ncopy-me\r\n");
    await openSettings(page);
    await dialog(page)
      .getByLabel("選択したテキストを自動的にコピーする")
      .check();
    await save(page);
    const box = (await page.locator(".xterm-screen").boundingBox())!;
    const y = box.y + 15 * 1.5;
    await page.mouse.move(box.x + 1, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 7.83 * 7, y, { steps: 4 });
    await page.mouse.up();
    await expect
      .poll(() => page.evaluate(() => window.__e2e.clipboard))
      .toBe("copy-me");
  });

  test("背景の不透明度のスライダー: 60% で半透明、100% に戻すと不透明", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await openSettings(page);
    await dialog(page)
      .getByLabel(/背景の不透明度/)
      .fill("60");
    await save(page);
    const bg = () =>
      page.evaluate(
        () =>
          getComputedStyle(document.querySelector(".xterm-scrollable-element")!)
            .backgroundColor,
      );
    await expect.poll(bg).toMatch(/rgba\(.*0\.6\)/);
    await openSettings(page);
    await dialog(page)
      .getByLabel(/背景の不透明度/)
      .fill("100");
    await save(page);
    await expect.poll(bg).not.toMatch(/rgba/);
  });

  test("再起動後も設定（フォント・テーマ）が保たれる", async ({ page }) => {
    await openApp(page);
    await openSettings(page);
    await dialog(page).getByLabel("フォントサイズ").fill("19");
    await dialog(page).getByLabel("配色テーマ").selectOption("solarized-dark");
    await save(page);
    await restart(page);
    await openSettings(page);
    await expect(dialog(page).getByLabel("フォントサイズ")).toHaveValue("19");
    await expect(dialog(page).getByLabel("配色テーマ")).toHaveValue(
      "solarized-dark",
    );
  });
});

test.describe("タブの色・履歴・複製", () => {
  test("接続ダイアログの「タブの色」で選ぶと、開いたタブに色が付き、保存済みの接続・画面復元でも残る", async ({
    page,
  }) => {
    await openApp(page, { settings: { startup: { kind: "restore" } } });
    await page.getByRole("button", { name: "新しい接続" }).click();
    await page.getByLabel("接続種別").selectOption("telnet");
    await page.getByLabel("ホスト").fill("device.example.com");
    await page.getByLabel("タブの色").selectOption("green");
    await page.getByLabel("この接続を保存する").check();
    await page.getByLabel("保存名").fill("緑の機器");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await expect(page.locator('[data-tab-color="green"]')).toBeVisible();
    // 保存済みの接続に残っている。
    expect(
      await page.evaluate(() => JSON.stringify(window.__e2e.profiles)),
    ).toContain('"tabColor":"green"');
    // 画面復元でも残る。
    await expect
      .poll(() => page.evaluate(() => JSON.stringify(window.__e2e.session)))
      .toContain('"tabColor":"green"');
    await page.reload();
    await expect(page.locator('[data-tab-color="green"]')).toBeVisible();
  });

  test("「最近使った接続」から選ぶと、再接続する", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "新しい接続" }).click();
    await page.getByLabel("接続種別").selectOption("telnet");
    await page.getByLabel("ホスト").fill("recent.example.com");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await expect(page.getByRole("tab")).toHaveCount(1);
    await page.getByRole("button", { name: "最近使った接続" }).click();
    await page.getByRole("menuitem", { name: /recent\.example\.com/ }).click();
    await expect(page.getByRole("tab")).toHaveCount(2);
  });

  test("タブの複製: 同じ接続先で新しいタブ（SSH のパスワードは入力し直し）", async ({
    page,
  }) => {
    await openApp(page);
    await openSshTab(page);
    await page.getByRole("tab").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "複製" }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByLabel("ホスト")).toHaveValue("example.com");
    await expect(
      dialog(page).getByLabel("パスワード", { exact: true }),
    ).toHaveValue("");
    await dialog(page).getByLabel("パスワード", { exact: true }).fill("again");
    await dialog(page)
      .getByRole("button", { name: "接続", exact: true })
      .click();
    await expect(page.getByRole("tab")).toHaveCount(2);
  });

  test("ローカルシェルにはエコー切替がない（シェル自身がエコーする）", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await expect(
      page.getByRole("button", { name: "ローカルエコーの切り替え" }),
    ).toHaveCount(0);
  });
});

test.describe("履歴にパスワードを保存しない（SSH のパスワードと Keychain 保存）", () => {
  test("保存される内容（設定・履歴・画面復元・プロファイル）にパスワードが無い", async ({
    page,
  }) => {
    await openApp(page, { settings: { startup: { kind: "restore" } } });
    await page.getByRole("button", { name: "新しい接続" }).click();
    await page.getByLabel("接続種別").selectOption("ssh");
    await page.getByLabel("ホスト").fill("example.com");
    await page.getByLabel("ユーザー名").fill("alice");
    await page.getByLabel("パスワード", { exact: true }).fill("TopSecret-123");
    await page.getByLabel("この接続を保存する").check();
    await page.getByLabel("保存名").fill("秘密");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await expect(page.getByRole("tab")).toHaveCount(1);
    await page.waitForTimeout(300);
    const stored = await page.evaluate(() =>
      JSON.stringify({
        settings: window.__e2e.settings,
        recent: window.__e2e.recent,
        session: window.__e2e.session,
        profiles: window.__e2e.profiles,
      }),
    );
    expect(stored).not.toContain("TopSecret-123");
    expect(stored).not.toContain('"password":');
  });
});

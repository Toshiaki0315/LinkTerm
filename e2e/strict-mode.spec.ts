import { test, expect } from "@playwright/test";
import { openApp, written } from "./helpers";

// 開発モード（make dev）は React の StrictMode で動く。二重実行でも壊れないことを確かめる。
test("StrictMode でも、自動ログインが最後まで進み、接続は1回だけ", async ({
  page,
}) => {
  await openApp(page, {}, { strict: true });
  await page.evaluate(() => {
    window.__e2e.echo = false;
  });
  await page.getByRole("button", { name: "新しい接続" }).click();
  await page.getByLabel("接続種別").selectOption("telnet");
  await page.getByLabel("ホスト").fill("device.example.com");
  await page
    .getByLabel("自動ログイン（任意）")
    .fill("login: => alice\nPassword: => {password}");
  await page.getByLabel("ログイン用パスワード").fill("pw!");
  await page.getByRole("button", { name: "接続", exact: true }).click();
  await expect(page.locator(".xterm").first()).toBeVisible();
  expect(await page.evaluate(() => window.__e2e.sessions.length)).toBe(1);
  await page.evaluate(() =>
    window.__e2e.output(window.__e2e.sessions[0], "login: "),
  );
  await expect.poll(() => written(page)).toBe("alice\r");
  await page.evaluate(() =>
    window.__e2e.output(window.__e2e.sessions[0], "Password: "),
  );
  await expect.poll(() => written(page)).toBe("alice\rpw!\r");
});

import { test, expect } from "@playwright/test";
import { openApp, openLocalTab, panes, screenText, written } from "./helpers";

test.describe("画面分割", () => {
  test("⌘D で左右、⌘⇧D で上下に分割。元のペインの表示は消えない", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await expect(screenText(page)).toContainText("$");
    await page.locator(".xterm").first().click();
    await page.keyboard.type("keep");
    await page.keyboard.press("Meta+d");
    await expect(panes(page)).toHaveCount(2);
    await expect(page.locator(".xterm").first()).toContainText("keep");
    await page.keyboard.press("Meta+Shift+d");
    await expect(panes(page)).toHaveCount(3);
    const sessions = await page.evaluate(() => window.__e2e.sessions.length);
    expect(sessions).toBe(3);
  });

  test("操作中のペインだけに入力が届く。⌘] / ⌘[ で操作対象が切り替わる", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.keyboard.press("Meta+d");
    await expect(panes(page)).toHaveCount(2);
    // 新しいペイン（2つ目）が操作対象。
    await page.keyboard.type("b");
    expect(await written(page, 1)).toBe("b");
    expect(await written(page, 0)).toBe("");
    await page.keyboard.press("Meta+[");
    await page.keyboard.type("a");
    expect(await written(page, 0)).toBe("a");
    await page.keyboard.press("Meta+]");
    await page.keyboard.type("c");
    expect(await written(page, 1)).toBe("bc");
  });

  test("ペインをクリックすると、操作対象が移る", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.keyboard.press("Meta+d");
    await expect(panes(page)).toHaveCount(2);
    await panes(page).first().click();
    await page.keyboard.type("x");
    expect(await written(page, 0)).toBe("x");
  });

  test("境目をドラッグして大きさを変えられる", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.keyboard.press("Meta+d");
    await expect(panes(page)).toHaveCount(2);
    const before = (await panes(page).first().boundingBox())!.width;
    const sep = page.getByRole("separator");
    const box = (await sep.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 200, box.y + box.height / 2, {
      steps: 5,
    });
    await page.mouse.up();
    const after = (await panes(page).first().boundingBox())!.width;
    expect(after).toBeLessThan(before - 100);
  });

  test("ウィンドウを広げると、ペインが追従する", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.keyboard.press("Meta+d");
    const before = (await panes(page).first().boundingBox())!.width;
    await page.setViewportSize({ width: 1600, height: 800 });
    await expect
      .poll(async () => (await panes(page).first().boundingBox())!.width)
      .toBeGreaterThan(before + 100);
  });

  test("⌘W で操作中のペインだけ閉じ、最後の1つを閉じるとタブが閉じる", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.keyboard.press("Meta+d");
    await expect(panes(page)).toHaveCount(2);
    await page.keyboard.press("Meta+w");
    await expect(panes(page)).toHaveCount(1);
    await page.keyboard.press("Meta+w");
    await expect(page.getByRole("tab")).toHaveCount(0);
  });

  test("右クリックに「右に分割／下に分割／ペインを閉じる」がある", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.keyboard.press("Meta+d");
    await expect(panes(page)).toHaveCount(2);
    await page.locator(".xterm").first().click({ button: "right" });
    for (const name of [
      "右に分割（⌘D）",
      "下に分割（⌘⇧D）",
      "ペインを閉じる",
    ]) {
      await expect(page.getByRole("menuitem", { name })).toBeVisible();
    }
  });

  test("パスワード認証の SSH で分割すると、パスワード入力が出る", async ({
    page,
  }) => {
    await openApp(page);
    await page.getByRole("button", { name: "新しい接続" }).click();
    await page.getByLabel("接続種別").selectOption("ssh");
    await page.getByLabel("ホスト").fill("example.com");
    await page.getByLabel("ユーザー名").fill("alice");
    await page.getByLabel("パスワード", { exact: true }).fill("pw");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await expect(page.locator(".xterm").first()).toBeVisible();
    await page.keyboard.press("Meta+d");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByLabel("パスワード", { exact: true })).toBeVisible();
    await page.getByLabel("パスワード", { exact: true }).fill("pw2");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await expect(panes(page)).toHaveCount(2);
  });

  test("分割した配置・操作中のペインが、再起動で復元される（接続は自動で始まらない）", async ({
    page,
  }) => {
    await openApp(page, { settings: { startup: { kind: "restore" } } });
    await openLocalTab(page);
    await page.keyboard.press("Meta+d");
    await expect(panes(page)).toHaveCount(2);
    await page.keyboard.press("Meta+[");
    // 保存が行われるのを待つ。
    await expect
      .poll(() =>
        page.evaluate(() => {
          const s = window.__e2e.session as {
            tabs: Array<{ panes?: unknown[] }>;
          };
          return s.tabs[0]?.panes?.length ?? 0;
        }),
      )
      .toBe(2);
    const sessionsBefore = await page.evaluate(
      () => window.__e2e.sessions.length,
    );
    expect(sessionsBefore).toBe(2);
    await page.reload();
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expect(panes(page)).toHaveCount(2);
    // パスワードの要らないローカルシェルは、復元と同時に始まる。
    await expect
      .poll(() => page.evaluate(() => window.__e2e.sessions.length))
      .toBe(2);
  });

  test("パスワード認証の SSH は、復元しても接続を始めない（入力を求める）", async ({
    page,
  }) => {
    await openApp(page, { settings: { startup: { kind: "restore" } } });
    await page.getByRole("button", { name: "新しい接続" }).click();
    await page.getByLabel("接続種別").selectOption("ssh");
    await page.getByLabel("ホスト").fill("example.com");
    await page.getByLabel("ユーザー名").fill("alice");
    await page.getByLabel("パスワード", { exact: true }).fill("secret-pw");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await expect(page.locator(".xterm").first()).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window.__e2e.session as { tabs: unknown[] }).tabs.length,
        ),
      )
      .toBe(1);
    await page.reload();
    await expect(page.getByRole("tab")).toHaveCount(1);
    expect(await page.evaluate(() => window.__e2e.sessions.length)).toBe(0);
    // 保存した内容に、パスワードは含まれない。
    expect(
      await page.evaluate(() => JSON.stringify(window.__e2e.session)),
    ).not.toContain("secret-pw");
  });
});

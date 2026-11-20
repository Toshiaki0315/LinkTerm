import { test, expect } from "@playwright/test";
import {
  openApp,
  openLocalTab,
  openPaneMenu,
  openSshTab,
  paneMenuLabels,
  paneMenuState,
  panes,
  pickPaneMenu,
} from "./helpers";

async function openTelnetTab(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "新しい接続" }).click();
  await page.getByLabel("接続種別").selectOption("telnet");
  await page.getByLabel("ホスト").fill("device.example.com");
  await page.getByRole("button", { name: "接続", exact: true }).click();
  await expect(page.locator(".xterm").last()).toBeVisible();
}

async function openSerialTab(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "新しい接続" }).click();
  await page.getByLabel("接続種別").selectOption("serial");
  await page.getByLabel("シリアルポート").selectOption("__manual__");
  await page.getByLabel("ポート名（手入力）").fill("/dev/cu.test");
  await page.getByRole("button", { name: "接続", exact: true }).click();
  await expect(page.locator(".xterm").last()).toBeVisible();
}

test.describe("タブバー右端の「⋯」（操作中のペインの操作）", () => {
  test("端末の中には、操作用のボタンが出ない。「⋯」はタブバーの右端にある", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    // 端末のペインの中に、ボタンは1つもない（文字に重ならない）。
    await expect(page.locator("[data-pane-id] button")).toHaveCount(0);
    const buttons = page.getByRole("button");
    const last = buttons.last();
    await expect(last).toHaveAccessibleName("ペインの操作");
    const bar = (await page.getByRole("tablist").boundingBox())!;
    const box = (await last.boundingBox())!;
    const term = (await page.locator(".xterm").first().boundingBox())!;
    // タブバーの帯の中にあり、端末の領域より上。
    expect(box.y + box.height).toBeLessThanOrEqual(term.y + 1);
    expect(box.x).toBeGreaterThan(bar.x);
  });

  test("接続（タブ）がなければ、「⋯」は出ない", async ({ page }) => {
    await openApp(page);
    await expect(
      page.getByRole("button", { name: /^ペインの操作/ }),
    ).toHaveCount(0);
  });

  test("ローカルシェル: 時刻・検索・ログ", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    expect(await paneMenuLabels(page)).toEqual([
      "タイムスタンプ表示",
      "検索…（⌘F）",
      "ログ記録を開始…",
    ]);
  });

  test("SSH: SFTP が加わる。Telnet: ローカルエコーが加わる", async ({
    page,
  }) => {
    await openApp(page);
    await openSshTab(page);
    expect(await paneMenuLabels(page)).toContain("ファイル転送（SFTP）…");
    await openTelnetTab(page);
    const labels = await paneMenuLabels(page);
    expect(labels).not.toContain("ファイル転送（SFTP）…");
    expect(labels.filter((l) => l.startsWith("ローカルエコー"))).toHaveLength(
      3,
    );
  });

  test("シリアル: DTR・RTS・ブレーク・HEX表示が加わる", async ({ page }) => {
    await openApp(page);
    await openSerialTab(page);
    const labels = await paneMenuLabels(page);
    for (const l of ["DTR", "RTS", "ブレーク送信", "HEX表示"])
      expect(labels).toContain(l);
  });

  test("分割しているときは、操作中のペインの項目が出る（ペインを替えると替わる）", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.keyboard.press("Meta+d");
    await expect(panes(page)).toHaveCount(1 + 1);
    // 新しいペイン（ローカル）が操作中。
    expect(await paneMenuLabels(page)).not.toContain("DTR");
    // ペイン間の切り替えで、メニューが追従する（同じローカル同士なので項目は同じ）。
    await page.keyboard.press("Meta+[");
    expect(await paneMenuLabels(page)).toContain("ログ記録を開始…");
  });

  test("検索: 項目から検索バーを開ける", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await pickPaneMenu(page, "検索…（⌘F）");
    await expect(page.getByRole("textbox", { name: "検索" })).toBeVisible();
  });

  test("タイムスタンプ表示: 項目の印が切り替わり、時刻が出る", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    expect(await paneMenuState(page, "タイムスタンプ表示")).toMatchObject({
      checked: false,
    });
    await pickPaneMenu(page, "タイムスタンプ表示");
    await expect
      .poll(
        async () => (await paneMenuState(page, "タイムスタンプ表示")).checked,
      )
      .toBe(true);
  });

  test("ログ記録: 開始 → 「⋯」に記録中の印 → 停止", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.evaluate(() => {
      window.__e2e.overrides["default_log_path"] = () => "/tmp/linkterm.log";
    });
    await expect
      .poll(async () => (await paneMenuState(page, "ログ記録を開始…")).disabled)
      .toBe(false);
    await pickPaneMenu(page, "ログ記録を開始…");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "記録開始" }).click();
    await expect(
      page.getByRole("button", { name: "ペインの操作（ログ記録中）" }),
    ).toBeVisible();
    await expect(page.getByTestId("recording-dot")).toBeVisible();
    await pickPaneMenu(page, "ログ記録を停止");
    await expect(
      page.getByRole("button", { name: "ペインの操作" }),
    ).toBeVisible();
    await expect(page.getByTestId("recording-dot")).toHaveCount(0);
  });

  test("ログの書き込みエラーは、ペインの上に表示し、記録中の印を消す", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await expect
      .poll(async () => (await paneMenuState(page, "ログ記録を開始…")).disabled)
      .toBe(false);
    await pickPaneMenu(page, "ログ記録を開始…");
    await page.getByRole("button", { name: "記録開始" }).click();
    await expect(page.getByTestId("recording-dot")).toBeVisible();
    await page.evaluate(() =>
      window.__e2e.emit("terminal-log-error", {
        id: window.__e2e.sessions[0],
        message: "disk full",
      }),
    );
    await expect(page.getByRole("alert")).toContainText("disk full");
    await expect(page.getByTestId("recording-dot")).toHaveCount(0);
  });

  test("Esc で閉じる。メニューは画面の右端からはみ出さない", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await openPaneMenu(page);
    const menu = (await page.getByRole("menu").boundingBox())!;
    const width = page.viewportSize()!.width;
    expect(menu.x + menu.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  });
});

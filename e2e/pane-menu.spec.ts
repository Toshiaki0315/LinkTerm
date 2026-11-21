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

test.describe("タブの名前の右の「⋯」（操作中のペインの操作）", () => {
  test("端末の中には、操作用のボタンが出ない。「⋯」は、操作中のタブの名前の右にある", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    // 端末のペインの中に、ボタンは1つもない（文字に重ならない）。
    await expect(page.locator("[data-pane-id] button")).toHaveCount(0);
    const tab = page.getByRole("tab").first();
    const more = page.getByRole("button", { name: "ペインの操作" });
    const close = page.getByRole("button", { name: /を閉じる$/ });
    const t = (await tab.boundingBox())!;
    const m = (await more.boundingBox())!;
    const c = (await close.boundingBox())!;
    const term = (await page.locator(".xterm").first().boundingBox())!;
    // タブの名前の右、×の左。タブバーの帯の中（端末より上）。
    expect(m.x).toBeGreaterThanOrEqual(t.x + t.width - 1);
    expect(m.x + m.width).toBeLessThanOrEqual(c.x + 1);
    expect(m.y + m.height).toBeLessThanOrEqual(term.y + 1);
    // タブバーの右端のボタン（スニペットなど）の列には、「⋯」はない。
    const buttons = page.getByRole("button");
    await expect(buttons.last()).not.toHaveAccessibleName(/ペインの操作/);
  });

  test("「⋯」は操作中のタブにだけ出る。タブを替えると、そのタブに移る", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.keyboard.press("Meta+t");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await expect(page.getByRole("tab")).toHaveCount(2);
    const more = page.getByRole("button", { name: /^ペインの操作/ });
    await expect(more).toHaveCount(1);
    const second = (await page.getByRole("tab").nth(1).boundingBox())!;
    expect((await more.boundingBox())!.x).toBeGreaterThan(second.x);
    await page.keyboard.press("Meta+1");
    await expect(more).toHaveCount(1);
    const first = (await page.getByRole("tab").first().boundingBox())!;
    const box = (await more.boundingBox())!;
    expect(box.x).toBeLessThan(second.x);
    expect(box.x).toBeGreaterThan(first.x);
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

  test("ログ記録: 開始 → タブに「REC」→ 停止（接続状態の丸とは別の札）", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await expect
      .poll(async () => (await paneMenuState(page, "ログ記録を開始…")).disabled)
      .toBe(false);
    await pickPaneMenu(page, "ログ記録を開始…");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "記録開始" }).click();
    const badge = page.getByTestId("rec-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("REC");
    await expect(
      page.getByRole("button", { name: "ペインの操作（ログ記録中）" }),
    ).toBeVisible();
    // 名前の右にあり、接続状態の丸（名前の左）とは離れている。丸ではなく四角い札。
    const dot = (await page
      .getByRole("tab")
      .first()
      .locator("span")
      .first()
      .boundingBox())!;
    const rec = (await badge.boundingBox())!;
    expect(rec.x).toBeGreaterThan(dot.x + dot.width);
    expect(
      await badge.evaluate((el) => getComputedStyle(el).borderRadius),
    ).not.toBe("9999px");
    await pickPaneMenu(page, "ログ記録を停止");
    await expect(page.getByTestId("rec-badge")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "ペインの操作" }),
    ).toBeVisible();
  });

  test("別のタブへ移っても、記録中のタブには「REC」が残る", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await expect
      .poll(async () => (await paneMenuState(page, "ログ記録を開始…")).disabled)
      .toBe(false);
    await pickPaneMenu(page, "ログ記録を開始…");
    await page.getByRole("button", { name: "記録開始" }).click();
    await expect(page.getByTestId("rec-badge")).toHaveCount(1);
    await page.keyboard.press("Meta+t");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await expect(page.getByRole("tab")).toHaveCount(2);
    // 2つ目のタブが操作中。REC は1つ目のタブに残り、2つ目には付かない。
    const badge = page.getByTestId("rec-badge");
    await expect(badge).toHaveCount(1);
    const first = (await page.getByRole("tab").first().boundingBox())!;
    const second = (await page.getByRole("tab").nth(1).boundingBox())!;
    const box = (await badge.boundingBox())!;
    expect(box.x).toBeGreaterThan(first.x);
    expect(box.x).toBeLessThan(second.x);
  });

  test("分割しているとき、記録中のペインがあるタブに「REC」が出る", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.keyboard.press("Meta+d");
    await expect(panes(page)).toHaveCount(2);
    await expect
      .poll(async () => (await paneMenuState(page, "ログ記録を開始…")).disabled)
      .toBe(false);
    await pickPaneMenu(page, "ログ記録を開始…");
    await page.getByRole("button", { name: "記録開始" }).click();
    await expect(page.getByTestId("rec-badge")).toHaveCount(1);
    // もう一方のペインへ移っても、タブの REC は残る（「⋯」の名前は、操作中のペインの状態）。
    await page.keyboard.press("Meta+[");
    await expect(page.getByTestId("rec-badge")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "ペインの操作" }),
    ).toBeVisible();
  });

  test("ログの書き込みエラーは、ペインの上に表示し、REC を消す", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await expect
      .poll(async () => (await paneMenuState(page, "ログ記録を開始…")).disabled)
      .toBe(false);
    await pickPaneMenu(page, "ログ記録を開始…");
    await page.getByRole("button", { name: "記録開始" }).click();
    await expect(page.getByTestId("rec-badge")).toBeVisible();
    await page.evaluate(() =>
      window.__e2e.emit("terminal-log-error", {
        id: window.__e2e.sessions[0],
        message: "disk full",
      }),
    );
    await expect(page.getByRole("alert")).toContainText("disk full");
    await expect(page.getByTestId("rec-badge")).toHaveCount(0);
  });

  test("Esc で閉じる。メニューは画面の右端からはみ出さない", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await openPaneMenu(page);
    const menu = (await page.getByRole("menu").boundingBox())!;
    const width = page.viewportSize()!.width;
    expect(menu.x).toBeGreaterThanOrEqual(0);
    expect(menu.x + menu.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  });
});

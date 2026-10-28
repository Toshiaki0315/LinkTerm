import { test, expect, type Page } from "@playwright/test";
import { openApp, openLocalTab, profile, screenText, written } from "./helpers";

const tabs = (page: Page) => page.getByRole("tab");

const web = profile(
  "p1",
  "Web サーバー",
  { type: "telnet", host: "web.example.com", port: 23 },
  { folder: "本番", tags: ["web", "東京"] },
);
const plain = profile("p2", "旧い接続", {
  type: "telnet",
  host: "old.example.com",
  port: 23,
});

async function openPalette(page: Page, query: string) {
  await page.keyboard.press("Meta+Shift+p");
  const box = page.getByRole("combobox", { name: "コマンドを検索" });
  await box.fill(query);
  return box;
}

test.describe("接続の保存と整理", () => {
  test("フォルダーとタグつきで保存でき、次回の選択肢がフォルダーごとにまとまる", async ({
    page,
  }) => {
    await openApp(page);
    await page.getByRole("button", { name: "新しい接続" }).click();
    await page.getByLabel("接続種別").selectOption("telnet");
    await page.getByLabel("ホスト").fill("web.example.com");
    await page.getByLabel("この接続を保存する").check();
    await page.getByLabel("保存名").fill("Web サーバー");
    await page.getByLabel(/^フォルダー/).fill("本番");
    await page.getByLabel(/^タグ/).fill("web, 東京");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await expect(tabs(page)).toHaveCount(1);

    const saved = await page.evaluate(() => window.__e2e.profiles[0]);
    expect(saved).toMatchObject({
      name: "Web サーバー",
      folder: "本番",
      tags: ["web", "東京"],
    });

    await page.keyboard.press("Meta+t");
    const select = page.getByLabel("保存済みの接続");
    await expect(select.locator('optgroup[label="本番"] option')).toHaveText([
      "Web サーバー",
    ]);
    await select.selectOption({ label: "Web サーバー" });
    await page.getByLabel("この接続を保存する").check();
    await expect(page.getByLabel(/^フォルダー/)).toHaveValue("本番");
    await expect(page.getByLabel(/^タグ/)).toHaveValue("web, 東京");
  });

  test("以前に保存した接続（フォルダー・タグなし）は「未分類」に出る", async ({
    page,
  }) => {
    await openApp(page, { profiles: [web, plain] });
    await page.keyboard.press("Meta+Shift+p");
    await page
      .getByRole("combobox", { name: "コマンドを検索" })
      .fill("保存済みの接続を管理");
    await page.keyboard.press("Enter");
    await expect(
      page
        .getByRole("heading", { name: "未分類" })
        .or(page.getByText("未分類")),
    ).toBeVisible();
    await expect(page.getByText("旧い接続")).toBeVisible();
    await expect(page.getByText("本番", { exact: true })).toBeVisible();
  });

  test("管理画面で、検索・編集・削除（確認つき）・接続ができる", async ({
    page,
  }) => {
    await openApp(page, { profiles: [web, plain] });
    await openPalette(page, "保存済みの接続を管理");
    await page.keyboard.press("Enter");
    // 検索
    await page.getByLabel("接続を検索").fill("東京");
    await expect(page.getByText("Web サーバー")).toBeVisible();
    await expect(page.getByText("旧い接続")).toHaveCount(0);
    await page.getByLabel("接続を検索").fill("");
    // 編集
    await page.getByRole("button", { name: "Web サーバー を編集" }).click();
    await page.getByLabel("名前").fill("Web 本番");
    await page.getByLabel(/^フォルダー/).fill("運用");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByText("Web 本番")).toBeVisible();
    // 削除は確認が出る
    await page.getByRole("button", { name: "旧い接続 を削除" }).click();
    await expect(page.getByText(/削除しますか|削除します/)).toBeVisible();
    await page.getByRole("button", { name: /^削除$|削除する/ }).click();
    await expect(page.getByText("旧い接続")).toHaveCount(0);
    // 接続
    await page.getByRole("button", { name: "Web 本番 に接続" }).click();
    await expect(tabs(page)).toHaveCount(1);
  });

  test("パレットで、タグやフォルダー名から保存済みの接続が見つかる", async ({
    page,
  }) => {
    await openApp(page, { profiles: [web, plain] });
    for (const q of ["東京", "本番"]) {
      const box = await openPalette(page, q);
      await expect(
        page.getByRole("option", { name: /Web サーバー/ }),
      ).toBeVisible();
      await box.press("Escape");
    }
    const box = await openPalette(page, "Web");
    await box.press("Enter");
    await expect(tabs(page)).toHaveCount(1);
  });

  test("~/.ssh/config の Host 名が出て、選ぶと接続ダイアログが開く", async ({
    page,
  }) => {
    await openApp(page);
    const box = await openPalette(page, "myalias");
    await expect(
      page.getByRole("option", { name: /SSH 接続（~\/\.ssh\/config）/ }),
    ).toBeVisible();
    await box.press("Enter");
    await expect(page.getByLabel("ホスト")).toHaveValue("myalias");
  });

  test("「管理…」ボタンから管理画面が開く", async ({ page }) => {
    await openApp(page, { profiles: [web] });
    await page.getByRole("button", { name: "新しい接続" }).click();
    await page.getByRole("button", { name: "管理…" }).click();
    await expect(page.getByLabel("接続を検索")).toBeVisible();
  });
});

test.describe("自動ログイン", () => {
  async function openTelnet(page: Page) {
    await page.getByRole("button", { name: "新しい接続" }).click();
    await page.getByLabel("接続種別").selectOption("telnet");
    await page.getByLabel("ホスト").fill("device.example.com");
    await page
      .getByLabel(/ログイン.*スクリプト|自動ログイン/)
      .first()
      .fill("login: => alice\nPassword: => {password}");
    await page.getByLabel("ログイン用パスワード").fill("s3cret!");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await expect(page.locator(".xterm").first()).toBeVisible();
  }

  test("待つ文字列が出たら ID とパスワードが送られる。パスワードは画面に出ない", async ({
    page,
  }) => {
    await openApp(page);
    await page.addInitScript(() => {
      // 本物のサーバーはパスワードをエコーしない。
      const t = setInterval(() => {
        if (window.__e2e) {
          window.__e2e.echo = false;
          clearInterval(t);
        }
      }, 1);
    });
    await openTelnet(page);
    await page.evaluate(() =>
      window.__e2e.output(window.__e2e.sessions[0], "login: "),
    );
    await expect.poll(() => written(page)).toBe("alice\r");
    await page.evaluate(() =>
      window.__e2e.output(window.__e2e.sessions[0], "Password: "),
    );
    await expect.poll(() => written(page)).toBe("alice\rs3cret!\r");
    await expect(screenText(page)).not.toContainText("s3cret!");
    // 保存される内容に、ログイン用パスワードは含まれない。
    const stored = await page.evaluate(() =>
      JSON.stringify([
        window.__e2e.recent,
        window.__e2e.session,
        window.__e2e.profiles,
      ]),
    );
    expect(stored).not.toContain("s3cret!");
    expect(stored).not.toContain("loginPassword");
  });

  test("待つ文字列が出ないまま約30秒たつと、中断したと表示される", async ({
    page,
  }) => {
    await page.clock.install();
    await openApp(page);
    await openTelnet(page);
    await page.clock.fastForward(31_000);
    await expect(page.locator(".xterm-rows")).toContainText("中断しました");
  });
});

test.describe("履歴・復元から開くとき", () => {
  test("ログイン用パスワードが要る接続は、入力のダイアログが出る", async ({
    page,
  }) => {
    await openApp(page, {
      recent: [
        {
          usedAt: 1,
          values: {
            type: "telnet",
            host: "device.example.com",
            port: 23,
            loginScript: "Password: => {password}",
          },
        },
      ],
    });
    await page.getByRole("button", { name: "最近使った接続" }).click();
    await page.getByRole("menuitem", { name: /device\.example\.com/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByLabel("ログイン用パスワード")).toBeVisible();
    expect(await page.evaluate(() => window.__e2e.sessions.length)).toBe(0);
  });
});

test.describe("見た目・コピー", () => {
  test("テーマを変えると、端末と余白の背景がそろって変わる", async ({
    page,
  }) => {
    await openApp(page, { settings: { theme: "solarized-dark" } });
    await openLocalTab(page);
    const bg = await page.evaluate(() => {
      const colorOf = (el: Element | null) =>
        el ? getComputedStyle(el).backgroundColor : "";
      return {
        term: colorOf(document.querySelector(".xterm-scrollable-element")),
        // 端末の外側（余白）：タブ全体と、端末を包む要素。
        tab: colorOf(document.querySelector("[data-tab-id]")),
        wrap: colorOf(document.querySelector(".xterm")?.parentElement ?? null),
      };
    });
    expect(bg.term).toBe("rgb(0, 43, 54)");
    expect(bg.tab).toBe(bg.term);
    expect(bg.wrap).toBe(bg.term);
  });
});

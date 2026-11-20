import { test, expect, type Page } from "@playwright/test";
import {
  calls,
  openApp,
  openLocalTab,
  openSshTab,
  output,
  panes,
  written,
} from "./helpers";

const drop = (page: Page, paths: string[], x = 50, y = 50) =>
  page.evaluate(
    ({ paths, x, y }) =>
      window.__e2e.emit("tauri://drag-drop", {
        paths,
        // macOS では、論理座標（CSS ピクセル）がそのまま届く。
        position: { x, y },
      }),
    { paths, x, y },
  );

test.describe("Finder からのドラッグ＆ドロップ（ターミナルと同じ）", () => {
  test("ファイルをドロップすると、パスが入力される（実行はしない）", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await drop(page, ["/Users/me/My File (1).txt"]);
    await expect
      .poll(() => written(page))
      .toBe("/Users/me/My\\ File\\ \\(1\\).txt ");
    expect(await written(page)).not.toMatch(/[\r\n]/);
  });

  test("フォルダーや複数のファイル、日本語のパスも入力できる", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await drop(page, ["/Users/me/資料", "/Users/me/報告 書.pdf"]);
    await expect
      .poll(() => written(page))
      .toBe("/Users/me/資料 /Users/me/報告\\ 書.pdf ");
  });

  test("改行を含むパスは入力されず、お知らせが出る", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await drop(page, ["/tmp/x\nrm -rf ~", "/ok"]);
    await expect.poll(() => written(page)).toBe("/ok ");
    await expect(page.getByText(/使えない文字/)).toBeVisible();
  });

  test("分割しているときは、ドロップした位置のペインへ入力される", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.keyboard.press("Meta+d");
    await expect(panes(page)).toHaveCount(2);
    const left = (await panes(page).first().boundingBox())!;
    const right = (await panes(page).last().boundingBox())!;
    await drop(page, ["/left"], left.x + 20, left.y + 20);
    await drop(page, ["/right"], right.x + 20, right.y + 20);
    await expect.poll(() => written(page, 0)).toBe("/left ");
    await expect.poll(() => written(page, 1)).toBe("/right ");
  });

  test("アプリが貼り付けモード（ブラケットペースト）を有効にしていれば、貼り付けとして渡す", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await output(page, "\x1b[?2004h");
    await drop(page, ["/a b"]);
    await expect.poll(() => written(page)).toBe("\x1b[200~/a\\ b \x1b[201~");
  });

  test("SFTP の画面が開いている間は、アップロードに使い、端末へは入力しない", async ({
    page,
  }) => {
    await openApp(page);
    await openSshTab(page);
    await page.getByRole("button", { name: "ファイル転送（SFTP）" }).click();
    await expect(page.getByRole("dialog")).toContainText("a.txt");
    await drop(page, ["/Users/me/dropped.txt"]);
    await expect
      .poll(async () => (await calls(page, "sftp_upload")).length)
      .toBe(1);
    expect(await written(page)).toBe("");
  });

  test("SFTP の画面を閉じると、また端末へ入力される", async ({ page }) => {
    await openApp(page);
    await openSshTab(page);
    await page.getByRole("button", { name: "ファイル転送（SFTP）" }).click();
    await expect(page.getByRole("dialog")).toContainText("a.txt");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await drop(page, ["/after"]);
    await expect.poll(() => written(page)).toBe("/after ");
  });

  test("接続ダイアログなど、ほかのダイアログが開いている間は入力しない", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.getByRole("button", { name: "新しい接続" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await drop(page, ["/ignored"]);
    await page.waitForTimeout(300);
    expect(await written(page)).toBe("");
  });

  test("接続（タブ）がなくても、エラーにならない", async ({ page }) => {
    await openApp(page);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await drop(page, ["/a"]);
    await page.waitForTimeout(200);
    expect(errors).toEqual([]);
  });
});

// Retina（拡大率 2）でも、落とした位置のペインに入ること。
test.describe("Retina ディスプレイ", () => {
  test.use({ deviceScaleFactor: 2 });

  test("分割画面で右のペインに落とすと、右のペインへ入る", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.keyboard.press("Meta+d");
    await expect(panes(page)).toHaveCount(2);
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
    // 操作中のペインを左にしておく（右へ入るのが、操作中だからではないことを確かめる）。
    await page.keyboard.press("Meta+[");
    const right = (await panes(page).last().boundingBox())!;
    await drop(page, ["/right"], right.x + 20, right.y + 20);
    await expect.poll(() => written(page, 1)).toBe("/right ");
    expect(await written(page, 0)).toBe("");
  });
});

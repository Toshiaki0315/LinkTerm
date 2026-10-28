import { test, expect, type Page } from "@playwright/test";
import { calls, openApp, openLocalTab, openSshTab, panes } from "./helpers";

async function openSftp(page: Page) {
  await openApp(page);
  await openSshTab(page);
  await page.getByRole("button", { name: "ファイル転送（SFTP）" }).click();
  await expect(page.getByRole("dialog")).toContainText("a.txt");
}

test.describe("SFTP", () => {
  test("SSH ペインにだけ SFTP ボタンがある", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await expect(
      page.getByRole("button", { name: "ファイル転送（SFTP）" }),
    ).toHaveCount(0);
  });

  test("ホームフォルダーの一覧が出る。フォルダーを開く・上へ・パス入力で移動できる", async ({
    page,
  }) => {
    await openSftp(page);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("パス")).toHaveValue("/home/alice");
    await expect(dialog).toContainText("docs");
    await dialog.getByRole("button", { name: "docs", exact: true }).click();
    await expect(dialog.getByLabel("パス")).toHaveValue("/home/alice/docs");
    await expect(dialog).toContainText("b.md");
    await dialog.getByRole("button", { name: "上のフォルダーへ" }).click();
    await expect(dialog.getByLabel("パス")).toHaveValue("/home/alice");
    await dialog.getByLabel("パス").fill("/home");
    await dialog.getByLabel("パス").press("Enter");
    await expect(dialog).toContainText("alice");
  });

  test("存在しないパスは、画面にエラーが出る", async ({ page }) => {
    await openSftp(page);
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("パス").fill("/nowhere");
    await dialog.getByLabel("パス").press("Enter");
    await expect(dialog).toContainText("/nowhere");
  });

  test("ファイルのダウンロードを要求し、保存先が表示される", async ({
    page,
  }) => {
    await openSftp(page);
    await page.getByRole("button", { name: "a.txt をダウンロード" }).click();
    await expect(page.getByRole("dialog")).toContainText(
      "保存先: /Users/me/Downloads/a.txt",
    );
    expect(await calls(page, "sftp_download")).toEqual([
      expect.objectContaining({ remotePath: "/home/alice/a.txt" }),
    ]);
  });

  test("フォルダーのダウンロードでは、完了表示にファイル数が出る", async ({
    page,
  }) => {
    await openSftp(page);
    await page.getByRole("button", { name: "docs をダウンロード" }).click();
    await expect(page.getByRole("dialog")).toContainText("3");
  });

  test("「アップロード」で送れる。同名があれば上書き確認が出て、はいで上書きする", async ({
    page,
  }) => {
    await openSftp(page);
    await page.evaluate(() => {
      window.__e2e.existing = ["up.txt"];
    });
    await page.getByRole("button", { name: /アップロード/ }).click();
    await expect(page.getByText(/上書き/).first()).toBeVisible();
    await page.getByRole("button", { name: /^上書き|はい/ }).click();
    await expect
      .poll(async () => (await calls(page, "sftp_upload")).length)
      .toBe(2);
    const second = (await calls(page, "sftp_upload"))[1] as {
      req: { overwrite: boolean };
    };
    expect(second.req.overwrite).toBe(true);
  });

  test("Finder からのドラッグ＆ドロップでもアップロードされる", async ({
    page,
  }) => {
    await openSftp(page);
    await page.evaluate(() =>
      window.__e2e.emit("tauri://drag-drop", {
        paths: ["/Users/me/dropped.txt"],
        position: { x: 10, y: 10 },
      }),
    );
    await expect
      .poll(async () => (await calls(page, "sftp_upload")).length)
      .toBe(1);
    expect(await calls(page, "sftp_upload")).toEqual([
      expect.objectContaining({
        req: expect.objectContaining({ localPath: "/Users/me/dropped.txt" }),
      }),
    ]);
  });

  test("新しいフォルダーを作れる", async ({ page }) => {
    await openSftp(page);
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "新しいフォルダー" }).click();
    await dialog.getByLabel("新しいフォルダーの名前").fill("新規");
    await dialog.getByLabel("新しいフォルダーの名前").press("Enter");
    await expect(dialog).toContainText("新規");
  });

  test("削除は確認つき。確認すると一覧から消える", async ({ page }) => {
    await openSftp(page);
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "a.txt を削除" }).click();
    await expect(page.getByText(/削除しますか|削除します/)).toBeVisible();
    // 確認の前には、まだ消えていない。
    expect(await calls(page, "sftp_remove")).toHaveLength(0);
    await page.getByRole("button", { name: /^削除$|削除する/ }).click();
    await expect(dialog).not.toContainText("a.txt");
    expect(await calls(page, "sftp_remove")).toHaveLength(1);
  });

  test("分割したペインでも SFTP が使える", async ({ page }) => {
    await openApp(page);
    await openSshTab(page);
    // パスワード認証の分割は、パスワードを求められる。
    await page.keyboard.press("Meta+d");
    await page.getByLabel("パスワード", { exact: true }).fill("pw");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await expect(panes(page)).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: "ファイル転送（SFTP）" }),
    ).toHaveCount(2);
  });
});

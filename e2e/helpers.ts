import { expect, type Locator, type Page } from "@playwright/test";

export interface Init {
  settings?: Record<string, unknown>;
  highlights?: unknown[];
  snippets?: unknown[];
  profiles?: unknown[];
  recent?: unknown[];
}

/** 画面を開く。`init` で、保存済みの設定などを最初から入れておける。 */
export async function openApp(
  page: Page,
  init: Init = {},
  options: { strict?: boolean } = {},
): Promise<void> {
  await page.addInitScript((i) => {
    (window as unknown as { __e2eInit: unknown }).__e2eInit = i;
  }, init);
  await page.goto(
    options.strict ? "/e2e/index.html?strict" : "/e2e/index.html",
  );
}

/** 再読み込み（アプリの再起動）。保存した内容は残る。 */
export async function restart(page: Page): Promise<void> {
  await page.reload();
}

/** ローカルシェルを新しいタブで開く。 */
export async function openLocalTab(page: Page): Promise<void> {
  await page.getByRole("button", { name: "新しい接続" }).click();
  await page.getByRole("button", { name: "接続", exact: true }).click();
  await expect(page.locator(".xterm").first()).toBeVisible();
}

/** 表示中の端末の画面テキスト。 */
export function screenText(page: Page): Locator {
  return page.locator(".xterm-rows").first();
}

/** 偽のバックエンドから、最後に開いたセッションへ出力を届ける。 */
export async function output(
  page: Page,
  text: string,
  index = -1,
): Promise<void> {
  await page.evaluate(
    async ({ text, index }) => {
      const e = window.__e2e;
      const id = e.sessions[index < 0 ? e.sessions.length + index : index];
      await e.output(id, text);
    },
    { text, index },
  );
}

/** 端末へ届いた入力を連結したもの（セッション指定なしなら全部）。 */
export async function written(page: Page, index?: number): Promise<string> {
  return page.evaluate((index) => {
    const e = window.__e2e;
    const id =
      index === undefined
        ? undefined
        : index < 0
          ? e.sessions[e.sessions.length + index]
          : e.sessions[index];
    return e.written
      .filter((w) => id === undefined || w.id === id)
      .map((w) => w.data)
      .join("");
  }, index);
}

export async function calls(page: Page, cmd: string): Promise<unknown[]> {
  return page.evaluate(
    (cmd) => window.__e2e.calls.filter((c) => c.cmd === cmd).map((c) => c.args),
    cmd,
  );
}

/**
 * 端末の画面の (行, 列) のセルをクリックする。
 * 描画の層はポインターを受けない（下の画面が受ける）ので、座標で押す。
 */
export async function clickCell(
  page: Page,
  row: number,
  col: number,
  modifiers: Array<"Meta" | "Shift" | "Alt" | "Control"> = [],
): Promise<void> {
  const geometry = await page.evaluate(() => {
    const screen = document
      .querySelector(".xterm-screen")!
      .getBoundingClientRect();
    const rows = document.querySelectorAll(".xterm-rows > div");
    // 入力用の欄の幅が、1セルの幅。
    const cell = document
      .querySelector(".xterm-helper-textarea")!
      .getBoundingClientRect().width;
    return {
      x: screen.x,
      y: screen.y,
      cell,
      rowHeight: rows[0].getBoundingClientRect().height,
    };
  });
  await page.mouse.move(
    geometry.x + geometry.cell * (col + 0.5),
    geometry.y + geometry.rowHeight * (row + 0.5),
  );
  await page.keyboard.down(modifiers[0] ?? "Shift");
  await page.keyboard.up(modifiers[0] ?? "Shift");
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.down();
  await page.mouse.up();
  for (const m of modifiers) await page.keyboard.up(m);
}

/** 開いた外部リンクの URL（opener プラグインの呼び出し）。 */
export async function openedUrls(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    window.__e2e.calls
      .filter((c) => c.cmd.includes("opener"))
      .map((c) => JSON.stringify(c.args)),
  );
}

/** メニューバーの「設定…」を選んだことにして、設定画面を開く。 */
export async function openSettings(page: Page): Promise<void> {
  await page.evaluate(() => window.__e2e.emit("menu-open-settings"));
  await expect(page.getByRole("dialog")).toBeVisible();
}

export const panes = (page: Page): Locator => page.locator("[data-pane-id]");

/** 保存済みの接続を、画面を通さずに入れておく。 */
export const profile = (
  id: string,
  name: string,
  values: Record<string, unknown>,
  extra: { folder?: string; tags?: string[] } = {},
) => ({ id, name, values, ...extra });

/** パスワード認証の SSH を開く。 */
export async function openSshTab(page: Page): Promise<void> {
  await page.getByRole("button", { name: "新しい接続" }).click();
  await page.getByLabel("接続種別").selectOption("ssh");
  await page.getByLabel("ホスト").fill("example.com");
  await page.getByLabel("ユーザー名").fill("alice");
  await page.getByLabel("パスワード", { exact: true }).fill("pw");
  await page.getByRole("button", { name: "接続", exact: true }).click();
  await expect(page.locator(".xterm").first()).toBeVisible();
}

/** タブバー右端の「⋯」を開く（操作中のペインの操作メニュー）。 */
export async function openPaneMenu(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^ペインの操作/ }).click();
  await expect(page.getByRole("menu")).toBeVisible();
}

/** 「⋯」を開いて、項目を選ぶ。 */
export async function pickPaneMenu(
  page: Page,
  name: string | RegExp,
): Promise<void> {
  await openPaneMenu(page);
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name })
    .or(page.getByRole("menu").getByRole("menuitemradio", { name }))
    .click();
}

/** 「⋯」を開いて、並んでいる項目の名前を返し、閉じる。 */
export async function paneMenuLabels(page: Page): Promise<string[]> {
  await openPaneMenu(page);
  const labels = await page
    .getByRole("menu")
    .locator("button")
    .allTextContents();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  return labels.map((l) => l.replace("✓", "").trim());
}

/** 「⋯」を開いて、項目の状態（選択中か・押せるか）を返し、閉じる。 */
export async function paneMenuState(
  page: Page,
  name: string | RegExp,
): Promise<{ checked: boolean | null; disabled: boolean }> {
  await openPaneMenu(page);
  const item = page
    .getByRole("menu")
    .getByRole("menuitem", { name })
    .or(page.getByRole("menu").getByRole("menuitemradio", { name }));
  const checked = await item.getAttribute("aria-checked");
  const disabled = await item.isDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  return { checked: checked === null ? null : checked === "true", disabled };
}

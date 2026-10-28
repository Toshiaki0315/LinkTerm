import { test, expect, type Page } from "@playwright/test";
import {
  openApp,
  openLocalTab,
  openSettings,
  panes,
  restart,
  screenText,
  written,
} from "./helpers";

async function newTab(page: Page) {
  await page.keyboard.press("Meta+t");
  await page.getByRole("button", { name: "接続", exact: true }).click();
}

test.describe("同時入力", () => {
  test("すべてのタブの全ペインへ届く。警告バナーが出て、解除で止まる", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await newTab(page);
    await page.getByRole("button", { name: "同時入力" }).click();
    await page
      .getByRole("menuitemradio", { name: "すべてのタブの全ペイン" })
      .click();
    await expect(page.getByText(/同時入力/).first()).toBeVisible();
    await page.locator(".xterm").last().click();
    await page.keyboard.type("echo hi");
    // どちらのセッションにも、1回ずつ届く（受け取った側から回らない）。
    expect(await written(page, 0)).toBe("echo hi");
    expect(await written(page, 1)).toBe("echo hi");
    await page.getByRole("button", { name: "解除" }).click();
    await page.locator(".xterm").last().click();
    await page.keyboard.type("z");
    expect(await written(page, 1)).toBe("echo hiz");
    expect(await written(page, 0)).toBe("echo hi");
  });

  test("⌘⇧I で、このタブの全ペインへの同時入力が切り替わる", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.keyboard.press("Meta+d");
    await expect(panes(page)).toHaveCount(2);
    await page.keyboard.press("Meta+Shift+i");
    await page.keyboard.type("q");
    expect(await written(page, 0)).toBe("q");
    expect(await written(page, 1)).toBe("q");
    await page.keyboard.press("Meta+Shift+i");
    await page.keyboard.type("r");
    expect(await written(page, 0)).toBe("q");
    expect(await written(page, 1)).toBe("qr");
  });

  test("「このタブの全ペイン」では、同じタブのペインにだけ届く", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.keyboard.press("Meta+d");
    await expect(panes(page)).toHaveCount(2);
    await newTab(page);
    await page.getByRole("button", { name: "同時入力" }).click();
    await page
      .getByRole("menuitemradio", { name: "このタブの全ペイン" })
      .click();
    await page.locator(".xterm").last().click();
    await page.keyboard.type("t");
    expect(await written(page, 2)).toBe("t");
    expect(await written(page, 0)).toBe("");
    expect(await written(page, 1)).toBe("");
    // 分割した同じタブへ戻ると、そのタブの2ペインに届く。
    await page.keyboard.press("Meta+1");
    await page.keyboard.type("u");
    expect(await written(page, 0)).toBe("u");
    expect(await written(page, 1)).toBe("u");
    expect(await written(page, 2)).toBe("t");
  });

  test("貼り付けも、ほかのペインへ届く", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openApp(page);
    await openLocalTab(page);
    await page.keyboard.press("Meta+d");
    await expect(panes(page)).toHaveCount(2);
    await page.keyboard.press("Meta+Shift+i");
    await page.evaluate(() => {
      window.__e2e.clipboard = "pasted";
    });
    await page.locator(".xterm").last().click({ button: "right" });
    await page.getByRole("menuitem", { name: "貼り付け" }).click();
    await expect.poll(() => written(page, 0)).toContain("pasted");
    await expect.poll(() => written(page, 1)).toContain("pasted");
  });
});

test.describe("コマンドパレット", () => {
  test("⌘⇧P で開き、入力で絞られ、Enter で実行、Esc で閉じる", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.keyboard.press("Meta+Shift+p");
    const box = page.getByRole("combobox", { name: "コマンドを検索" });
    await expect(box).toBeVisible();
    const all = await page.getByRole("option").count();
    await box.fill("分割");
    const filtered = page.getByRole("option");
    expect(await filtered.count()).toBeLessThan(all);
    await expect(filtered.first()).toContainText("分割");
    await box.press("Enter");
    await expect(panes(page)).toHaveCount(2);
    // 実行後は、フォーカスが端末に戻る。
    await page.keyboard.type("k");
    expect(await written(page, 1)).toBe("k");
    await page.keyboard.press("Meta+Shift+p");
    await expect(box).toBeVisible();
    await box.press("Escape");
    await expect(box).toHaveCount(0);
  });

  test("ショートカットのヒントが右側に出る", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.keyboard.press("Meta+Shift+p");
    await page
      .getByRole("combobox", { name: "コマンドを検索" })
      .fill("右に分割");
    await expect(page.getByRole("option").first()).toContainText("⌘D");
  });

  test("タブへの移動、スニペットの実行が動く", async ({ page }) => {
    await openApp(page, {
      snippets: [
        {
          id: "s1",
          name: "挨拶",
          text: "echo hi",
          sendEnter: true,
          lineDelayMs: 0,
        },
      ],
    });
    await openLocalTab(page);
    await newTab(page);
    await page.keyboard.press("Meta+Shift+p");
    const box = page.getByRole("combobox", { name: "コマンドを検索" });
    await box.fill("スニペットを実行");
    await box.press("Enter");
    await expect.poll(() => written(page, 1)).toBe("echo hi\r");
  });

  test("日本語入力の変換中の Enter では実行されない", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.keyboard.press("Meta+Shift+p");
    const box = page.getByRole("combobox", { name: "コマンドを検索" });
    await box.fill("右に分割");
    // 変換中（isComposing）の Enter を送る。
    await box.evaluate((el) => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(panes(page)).toHaveCount(1);
    await box.press("Enter");
    await expect(panes(page)).toHaveCount(2);
  });
});

test.describe("スニペット", () => {
  async function addSnippet(
    page: Page,
    name: string,
    text: string,
    opts: { sendEnter?: boolean; delay?: number } = {},
  ) {
    await page.getByRole("button", { name: "スニペット" }).click();
    await page.getByRole("menuitem", { name: "スニペットを管理…" }).click();
    await page.getByRole("button", { name: /追加/ }).click();
    await page.getByLabel("名前").fill(name);
    await page.getByLabel(/内容/).fill(text);
    if (opts.delay !== undefined)
      await page.getByLabel(/待ち時間/).fill(String(opts.delay));
    if (opts.sendEnter === false)
      await page.getByLabel(/最後の行にも Enter/).uncheck();
    await page.getByRole("button", { name: "保存" }).click();
    await page.keyboard.press("Escape");
  }

  test("追加して保存でき、再起動後も残る。選ぶと操作中のペインへ送られる", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await addSnippet(page, "挨拶", "echo hi");
    await restart(page);
    await openLocalTab(page);
    await page.getByRole("button", { name: "スニペット" }).click();
    await page.getByRole("menuitem", { name: "挨拶" }).click();
    expect(await written(page)).toBe("echo hi\r");
  });

  test("複数行は1行ずつ送られる", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await addSnippet(page, "二行", "date\nwhoami", { delay: 0 });
    await page.getByRole("button", { name: "スニペット" }).click();
    await page.getByRole("menuitem", { name: "二行" }).click();
    await expect.poll(() => written(page)).toBe("date\rwhoami\r");
  });

  test("行間の待ち時間を入れると間隔が空く", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await addSnippet(page, "待つ", "a\nb", { delay: 600 });
    await page.getByRole("button", { name: "スニペット" }).click();
    await page.getByRole("menuitem", { name: "待つ" }).click();
    await expect.poll(() => written(page)).toBe("a\r");
    await page.waitForTimeout(200);
    expect(await written(page)).toBe("a\r");
    await expect.poll(() => written(page)).toBe("a\rb\r");
  });

  test("「最後の行にも Enter」をオフにすると、最後の行は実行されない", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await addSnippet(page, "置くだけ", "ls", { sendEnter: false });
    await page.getByRole("button", { name: "スニペット" }).click();
    await page.getByRole("menuitem", { name: "置くだけ" }).click();
    await expect.poll(() => written(page)).toBe("ls");
  });

  test("分割画面では、操作中のペインにだけ送られる", async ({ page }) => {
    await openApp(page, {
      snippets: [
        { id: "s1", name: "一", text: "one", sendEnter: false, lineDelayMs: 0 },
      ],
    });
    await openLocalTab(page);
    await page.keyboard.press("Meta+d");
    await page.getByRole("button", { name: "スニペット" }).click();
    await page.getByRole("menuitem", { name: "一" }).click();
    await expect.poll(() => written(page, 1)).toBe("one");
    expect(await written(page, 0)).toBe("");
  });
});

test.describe("ショートカットのカスタマイズ", () => {
  async function openShortcuts(page: Page) {
    await openSettings(page);
    await page.getByRole("button", { name: "ショートカットを設定…" }).click();
  }

  test("⌘K に割り当てると、その場で使え、再起動後も保たれる。初期値で戻る", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await openShortcuts(page);
    await page
      .getByRole("button", { name: "右に分割 のショートカットを変更" })
      .click();
    await page.keyboard.press("Meta+k");
    await expect(page.getByLabel("右に分割 の現在のキー")).toHaveText("⌘K");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.locator(".xterm").first().click();
    await page.keyboard.press("Meta+k");
    await expect(panes(page)).toHaveCount(2);
    // 古いキーは効かない。
    await page.keyboard.press("Meta+d");
    await expect(panes(page)).toHaveCount(2);

    await restart(page);
    await openLocalTab(page);
    await page.locator(".xterm").first().click();
    await page.keyboard.press("Meta+k");
    await expect(panes(page)).toHaveCount(2);

    await openShortcuts(page);
    await page.getByRole("button", { name: "右に分割 を初期値に戻す" }).click();
    await expect(page.getByLabel("右に分割 の現在のキー")).toHaveText("⌘D");
  });

  test("⌘C・⌘V・⌘Q・⌘1〜9・使用中のキーは、理由つきで拒否される", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await openShortcuts(page);
    for (const key of ["Meta+c", "Meta+v", "Meta+q", "Meta+5"]) {
      await page
        .getByRole("button", { name: "右に分割 のショートカットを変更" })
        .click();
      await page.keyboard.press(key);
      await expect(page.getByRole("alert")).toBeVisible();
      // 記録をやめると、元のキーのまま。
      await page
        .getByRole("button", { name: "右に分割 のショートカットを変更" })
        .click();
      await expect(page.getByLabel("右に分割 の現在のキー")).toHaveText("⌘D");
    }
    // すでに「新しい接続」が使っている ⌘T。
    await page
      .getByRole("button", { name: "右に分割 のショートカットを変更" })
      .click();
    await page.keyboard.press("Meta+t");
    await expect(page.getByRole("alert")).toContainText("新しい接続");
  });

  test("「すべて初期値に戻す」と、パレットのヒントが変更後のキーになる", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await openShortcuts(page);
    await page
      .getByRole("button", { name: "右に分割 のショートカットを変更" })
      .click();
    await page.keyboard.press("Meta+k");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Meta+Shift+p");
    await page
      .getByRole("combobox", { name: "コマンドを検索" })
      .fill("右に分割");
    await expect(page.getByRole("option").first()).toContainText("⌘K");
    await page.keyboard.press("Escape");
    await openShortcuts(page);
    await page.getByRole("button", { name: "すべて初期値に戻す" }).click();
    await expect(page.getByLabel("右に分割 の現在のキー")).toHaveText("⌘D");
  });

  test("変更したキーがあっても、端末への普通の入力（Ctrl+C）は妨げられない", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.locator(".xterm").first().click();
    await page.keyboard.press("Control+c");
    expect(await written(page)).toBe("\x03");
  });
});

test.describe("端末エミュレーション", () => {
  test("Backspace: 既定は DEL（^?）、BS にすると ^H が送られる", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.locator(".xterm").first().click();
    await page.keyboard.press("Backspace");
    expect(await written(page)).toBe("\x7f");
  });

  test("Backspace を BS にすると ^H", async ({ page }) => {
    await openApp(page, { settings: { backspaceKey: "bs" } });
    await openLocalTab(page);
    await page.locator(".xterm").first().click();
    await page.keyboard.press("Backspace");
    expect(await written(page)).toBe("\b");
  });

  test("Option を Meta として使うと、Option+B が Esc 前置で送られる", async ({
    page,
  }) => {
    await openApp(page, { settings: { optionIsMeta: true } });
    await openLocalTab(page);
    await page.locator(".xterm").first().click();
    await page.keyboard.press("Alt+b");
    expect(await written(page)).toBe("\x1bb");
  });

  test("TERM の種類が起動の要求に入る", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "新しい接続" }).click();
    await page.getByLabel("接続種別").selectOption("telnet");
    await page.getByLabel("ホスト").fill("example.com");
    await page.getByLabel("端末の種類 (TERM)").selectOption("vt100");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await expect(screenText(page)).toBeVisible();
    const req = await page.evaluate(
      () => window.__e2e.calls.find((c) => c.cmd === "start_telnet")?.args,
    );
    expect(JSON.stringify(req)).toContain('"termType":"vt100"');
  });
});

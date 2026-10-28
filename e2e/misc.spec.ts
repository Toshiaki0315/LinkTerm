import { test, expect, type Page } from "@playwright/test";
import {
  calls,
  openApp,
  openLocalTab,
  openSettings,
  output,
  screenText,
  written,
} from "./helpers";

async function openTelnetTab(page: Page, host = "device.example.com") {
  await page.getByRole("button", { name: "新しい接続" }).click();
  await page.getByLabel("接続種別").selectOption("telnet");
  await page.getByLabel("ホスト").fill(host);
  await page.getByRole("button", { name: "接続", exact: true }).click();
  await expect(page.locator(".xterm").first()).toBeVisible();
}

test.describe("右クリックメニューとコピー", () => {
  test("すべて選択 → コピー で、クリップボードに入る。貼り付けは入力として送られる", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await output(page, "hello world\r\n");
    await page.locator(".xterm").first().click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "コピー" })).toBeDisabled();
    await page.getByRole("menuitem", { name: "すべて選択" }).click();
    await page.locator(".xterm").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "コピー" }).click();
    await expect
      .poll(() => page.evaluate(() => window.__e2e.clipboard))
      .toContain("hello world");

    await page.evaluate(() => {
      window.__e2e.clipboard = "from clipboard";
    });
    await page.locator(".xterm").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "貼り付け" }).click();
    await expect.poll(() => written(page)).toContain("from clipboard");
  });

  test("画面をクリアすると、画面の内容が消える", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await output(page, "visible text\r\n");
    await expect(screenText(page)).toContainText("visible text");
    await page.locator(".xterm").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "画面をクリア" }).click();
    await expect(screenText(page)).not.toContainText("visible text");
  });

  test("「選択したらコピー」がオンなら、範囲選択だけでクリップボードに入る", async ({
    page,
  }) => {
    await openApp(page, { settings: { copyOnSelect: true } });
    await openLocalTab(page);
    await output(page, "\r\nselect me\r\n");
    await expect(screenText(page)).toContainText("select me");
    const box = (await page.locator(".xterm-screen").boundingBox())!;
    const cell = await page.evaluate(
      () =>
        document
          .querySelector(".xterm-helper-textarea")!
          .getBoundingClientRect().width,
    );
    const y = box.y + 15 * 1.5;
    await page.mouse.move(box.x + 1, y);
    await page.mouse.down();
    await page.mouse.move(box.x + cell * 9, y, { steps: 4 });
    await page.mouse.up();
    await expect
      .poll(() => page.evaluate(() => window.__e2e.clipboard))
      .toBe("select me");
  });

  test("「選択したらコピー」がオフなら、選択してもコピーしない", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await output(page, "\r\nselect me\r\n");
    const box = (await page.locator(".xterm-screen").boundingBox())!;
    const y = box.y + 15 * 1.5;
    await page.mouse.move(box.x + 1, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 70, y, { steps: 4 });
    await page.mouse.up();
    expect(await page.evaluate(() => window.__e2e.clipboard)).toBe("");
  });
});

test.describe("画面をテキストで保存", () => {
  test("保存ダイアログで選んだ場所へ、画面全体のテキストを書く", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await output(page, "line one\r\nline two\r\n");
    await page.locator(".xterm").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "画面をテキストで保存…" }).click();
    await expect
      .poll(async () => (await calls(page, "save_text_file")).length)
      .toBe(1);
    const [req] = (await calls(page, "save_text_file")) as Array<{
      path: string;
      content: string;
    }>;
    expect(req.path).toBe("/Users/me/screen.txt");
    expect(req.content).toContain("line one");
    expect(req.content).toContain("line two");
    await expect(page.getByRole("status")).toContainText(
      "/Users/me/screen.txt",
    );
  });

  test("キャンセルしても何も起きない", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.evaluate(() => {
      window.__e2e.savePath = null;
    });
    await page.locator(".xterm").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "画面をテキストで保存…" }).click();
    await page.waitForTimeout(300);
    expect(await calls(page, "save_text_file")).toHaveLength(0);
  });
});

test.describe("通知", () => {
  const rule = {
    id: "n1",
    pattern: "ALERT",
    regex: false,
    caseSensitive: false,
    color: "red",
    notify: true,
  };
  const notifications = (page: Page) =>
    page.evaluate(() => window.__e2e.notifications);

  test("別のタブを見ている間に一致すると、通知とタブの印が出る。通知の本文に画面の内容は入らない", async ({
    page,
  }) => {
    await openApp(page, { highlights: [rule] });
    await openLocalTab(page);
    await page.keyboard.press("Meta+t");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    // 1つ目のタブは裏になった。
    await output(page, "secret ALERT payload\r\n", 0);
    await expect(
      page.getByRole("img", { name: "キーワードを検出しました" }),
    ).toBeVisible();
    await expect.poll(async () => (await notifications(page)).length).toBe(1);
    const body = JSON.stringify((await notifications(page))[0]);
    expect(body).toContain("ALERT");
    expect(body).not.toContain("secret");
    expect(body).not.toContain("payload");
  });

  test("見ているタブでは通知しない", async ({ page }) => {
    await openApp(page, { highlights: [rule] });
    await openLocalTab(page);
    await page.locator(".xterm").first().click();
    await output(page, "ALERT here\r\n");
    await page.waitForTimeout(300);
    expect(await notifications(page)).toHaveLength(0);
  });

  test("同じ規則の通知は5秒以内に連続しない", async ({ page }) => {
    await openApp(page, { highlights: [rule] });
    await openLocalTab(page);
    await page.keyboard.press("Meta+t");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await output(page, "ALERT 1\r\n", 0);
    await output(page, "ALERT 2\r\n", 0);
    await page.waitForTimeout(400);
    expect(await notifications(page)).toHaveLength(1);
  });

  test("ベルが別のタブで鳴ると、そのタブに印が付く", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.keyboard.press("Meta+t");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await output(page, "\x07", 0);
    await expect(
      page.getByRole("img", { name: "キーワードを検出しました" }),
    ).toBeVisible();
  });
});

test.describe("ローカルエコー", () => {
  test("切り替えボタンで 自動 → オン → オフ", async ({ page }) => {
    await openApp(page);
    await openTelnetTab(page);
    const toggle = page.getByRole("button", {
      name: "ローカルエコーの切り替え",
    });
    await expect(toggle).toContainText("自動");
    await toggle.click();
    await expect(toggle).toContainText("オン");
    await toggle.click();
    await expect(toggle).toContainText("オフ");
  });

  test("「オン」では入力した文字が画面に出る。「オフ」では出ない（エコーしない接続先）", async ({
    page,
  }) => {
    await openApp(page);
    await page.evaluate(() => {
      window.__e2e.echo = false;
    });
    await openTelnetTab(page);
    const toggle = page.getByRole("button", {
      name: "ローカルエコーの切り替え",
    });
    await page.locator(".xterm").first().click();
    await toggle.click(); // オン
    await page.locator(".xterm").first().click();
    await page.keyboard.type("abc");
    await expect(screenText(page)).toContainText("abc");
    await toggle.click(); // オフ
    await page.locator(".xterm").first().click();
    await page.keyboard.type("xyz");
    await page.waitForTimeout(200);
    await expect(screenText(page)).not.toContainText("xyz");
  });

  test("「自動」では、接続先がエコーしない（WILL ECHO が無い）と画面に出る", async ({
    page,
  }) => {
    await openApp(page);
    await page.evaluate(() => {
      window.__e2e.echo = false;
    });
    await openTelnetTab(page);
    await page.evaluate(() =>
      window.__e2e.emit("terminal-echo", {
        id: window.__e2e.sessions[0],
        remoteEcho: false,
      }),
    );
    await page.locator(".xterm").first().click();
    await page.keyboard.type("auto");
    await expect(screenText(page)).toContainText("auto");
  });

  test("接続先がエコーすると宣言したら、自動では二重にならない", async ({
    page,
  }) => {
    await openApp(page);
    await page.evaluate(() => {
      window.__e2e.echo = false;
    });
    await openTelnetTab(page);
    await page.evaluate(() =>
      window.__e2e.emit("terminal-echo", {
        id: window.__e2e.sessions[0],
        remoteEcho: true,
      }),
    );
    await page.locator(".xterm").first().click();
    await page.keyboard.type("once");
    await page.waitForTimeout(200);
    await expect(screenText(page)).not.toContainText("once");
  });
});

test.describe("シリアル", () => {
  test("ポート名を手入力して接続できる", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "新しい接続" }).click();
    await page.getByLabel("接続種別").selectOption("serial");
    await page.getByLabel("シリアルポート").selectOption("__manual__");
    await page.getByLabel("ポート名（手入力）").fill("/dev/cu.usbserial-X");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await expect(page.locator(".xterm").first()).toBeVisible();
    const req = JSON.stringify((await calls(page, "start_serial"))[0]);
    expect(req).toContain("/dev/cu.usbserial-X");
  });

  test("DTR / RTS / ブレーク / HEX表示 の操作がバックエンドへ伝わる", async ({
    page,
  }) => {
    await openApp(page);
    await page.getByRole("button", { name: "新しい接続" }).click();
    await page.getByLabel("接続種別").selectOption("serial");
    await page.getByLabel("シリアルポート").selectOption("__manual__");
    await page.getByLabel("ポート名（手入力）").fill("/dev/cu.test");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    const dtr = page.getByRole("button", { name: "DTR" });
    await expect(dtr).toBeEnabled();
    // ポートを開いた直後は両方オン。押すとオフになる。
    await expect(dtr).toHaveAttribute("aria-pressed", "true");
    await dtr.click();
    await expect(dtr).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "RTS" }).click();
    await page.getByRole("button", { name: "ブレーク送信" }).click();
    await page.getByRole("button", { name: "HEX表示" }).click();
    expect(await calls(page, "serial_set_control")).toEqual([
      expect.objectContaining({ signal: "dtr", on: false }),
      expect.objectContaining({ signal: "rts", on: false }),
    ]);
    expect(await calls(page, "serial_send_break")).toHaveLength(1);
    expect(await calls(page, "set_display_mode")).toEqual([
      expect.objectContaining({ mode: "hex" }),
    ]);
    await page.getByRole("button", { name: "HEX表示" }).click();
    const modes = await calls(page, "set_display_mode");
    expect(modes[modes.length - 1]).toEqual(
      expect.objectContaining({ mode: "text" }),
    );
  });
});

test.describe("再接続", () => {
  test("自動再接続: 異常な切断のあと、待ち時間をおいて再接続する", async ({
    page,
  }) => {
    await page.clock.install();
    await openApp(page, {
      settings: {
        autoReconnect: { enabled: true, delaySeconds: 3, maxAttempts: 2 },
      },
    });
    await openTelnetTab(page);
    await page.evaluate(() =>
      window.__e2e.emit("terminal-closed", {
        id: window.__e2e.sessions[0],
        reason: "接続が切れました",
      }),
    );
    await expect(page.getByText(/秒後に自動再接続します/)).toBeVisible();
    await page.clock.fastForward(4_000);
    await expect
      .poll(() => page.evaluate(() => window.__e2e.sessions.length))
      .toBe(2);
  });

  test("上限に達したら止める", async ({ page }) => {
    await page.clock.install();
    await openApp(page, {
      settings: {
        autoReconnect: { enabled: true, delaySeconds: 1, maxAttempts: 1 },
      },
    });
    await openTelnetTab(page);
    const drop = () =>
      page.evaluate(() =>
        window.__e2e.emit("terminal-closed", {
          id: window.__e2e.sessions[window.__e2e.sessions.length - 1],
          reason: "切れた",
        }),
      );
    await drop();
    await page.clock.fastForward(2_000);
    await expect
      .poll(() => page.evaluate(() => window.__e2e.sessions.length))
      .toBe(2);
    // 10秒未満で落ちた → 試行回数は数え直さない。
    await drop();
    await expect(page.getByText(/自動再接続を止めました/)).toBeVisible();
    expect(await page.evaluate(() => window.__e2e.sessions.length)).toBe(2);
  });

  test("正常な終了では自動再接続しない。「再接続」ボタンで再接続できる", async ({
    page,
  }) => {
    await openApp(page, {
      settings: {
        autoReconnect: { enabled: true, delaySeconds: 1, maxAttempts: 3 },
      },
    });
    await openTelnetTab(page);
    await page.evaluate(() =>
      window.__e2e.emit("terminal-closed", {
        id: window.__e2e.sessions[0],
        reason: null,
      }),
    );
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.__e2e.sessions.length)).toBe(1);
    await page.getByRole("button", { name: "再接続" }).click();
    await expect
      .poll(() => page.evaluate(() => window.__e2e.sessions.length))
      .toBe(2);
  });
});

test.describe("SSH ホスト鍵の確認", () => {
  test("未知のホスト鍵は確認ダイアログが出て、承認・拒否がバックエンドへ伝わる", async ({
    page,
  }) => {
    await openApp(page);
    await page.evaluate(() =>
      window.__e2e.emit("ssh-host-key-request", {
        requestId: "r1",
        host: "example.com",
        port: 22,
        fingerprint: "SHA256:abcdef",
      }),
    );
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("SHA256:abcdef");
    await dialog.getByRole("button", { name: "信頼して接続" }).click();
    expect(await calls(page, "respond_host_key")).toEqual([
      expect.objectContaining({ requestId: "r1", approved: true }),
    ]);
    await page.evaluate(() =>
      window.__e2e.emit("ssh-host-key-request", {
        requestId: "r2",
        host: "example.com",
        port: 22,
        fingerprint: "SHA256:xyz",
      }),
    );
    await expect(page.getByRole("dialog")).toContainText("SHA256:xyz");
    await page.keyboard.press("Escape");
    await expect
      .poll(async () => (await calls(page, "respond_host_key")).length)
      .toBe(2);
    expect((await calls(page, "respond_host_key"))[1]).toEqual(
      expect.objectContaining({ requestId: "r2", approved: false }),
    );
  });
});

test.describe("設定", () => {
  test("設定を変えて保存すると、端末に反映され、保存の要求が出る", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await openSettings(page);
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("フォントサイズ").fill("20");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            getComputedStyle(document.querySelector(".xterm-rows")!).fontSize,
        ),
      )
      .toBe("20px");
    expect(
      (await page.evaluate(() => window.__e2e.settings)) as {
        fontSize: number;
      },
    ).toMatchObject({ fontSize: 20 });
  });

  test("設定ダイアログの高さがウィンドウより長いとき、スクロールできる", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 400 });
    await openApp(page);
    await openSettings(page);
    const dialog = page.getByRole("dialog");
    const box = (await dialog.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(400);
    // 一番下のボタンまでスクロールして届く。
    await dialog.getByRole("button", { name: "保存" }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("button", { name: "保存" })).toBeInViewport();
  });
});

test.describe("そのほか", () => {
  test("パレットの「タイムスタンプ表示」で時刻表示が切り替わる", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.keyboard.press("Meta+Shift+p");
    await page
      .getByRole("combobox", { name: "コマンドを検索" })
      .fill("タイムスタンプ表示をオンにする");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "タイムスタンプ表示" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("複数タブで出力が混ざらない", async ({ page }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.keyboard.press("Meta+t");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await output(page, "ONLY-IN-FIRST\r\n", 0);
    await output(page, "ONLY-IN-SECOND\r\n", 1);
    const tabText = (n: number) =>
      page.locator("[data-tab-id]").nth(n).locator(".xterm-rows");
    await expect(tabText(1)).toContainText("ONLY-IN-SECOND");
    await expect(tabText(1)).not.toContainText("ONLY-IN-FIRST");
    await page.keyboard.press("Meta+1");
    await expect(tabText(0)).toContainText("ONLY-IN-FIRST");
    await expect(tabText(0)).not.toContainText("ONLY-IN-SECOND");
  });
});

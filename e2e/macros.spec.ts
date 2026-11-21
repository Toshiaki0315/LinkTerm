import { test, expect, type Page } from "@playwright/test";
import {
  calls,
  openApp,
  openLocalTab,
  openSshTab,
  output,
  paneMenuLabels,
  pickPaneMenu,
  restart,
  screenText,
  written,
} from "./helpers";

const macro = (id: string, name: string, text: string) => ({ id, name, text });

/** ⚡のメニューから、マクロを実行する。 */
async function runFromMenu(page: Page, name: string) {
  await page.getByRole("button", { name: "スニペット" }).click();
  await page.getByRole("menuitem", { name: `マクロ: ${name}` }).click();
}

const banner = (page: Page) => page.getByRole("status", { name: "マクロ" });

test.describe("マクロの管理", () => {
  test("追加して保存でき、⚡のメニューに出る。再起動後も残る", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.getByRole("button", { name: "スニペット" }).click();
    await page.getByRole("menuitem", { name: "マクロを管理…" }).click();
    await page.getByRole("button", { name: "追加" }).click();
    await page.getByLabel("名前").fill("ログイン");
    await page
      .getByLabel("スクリプト")
      .fill("wait 'login:'\nsendln 'admin'\n; コメント");
    await expect(page.getByText("文法: 問題ありません")).toBeVisible();
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByText("ログイン", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "閉じる" }).click();
    await page.getByRole("button", { name: "スニペット" }).click();
    await expect(
      page.getByRole("menuitem", { name: "マクロ: ログイン" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await restart(page);
    await openLocalTab(page);
    await page.getByRole("button", { name: "スニペット" }).click();
    await expect(
      page.getByRole("menuitem", { name: "マクロ: ログイン" }),
    ).toBeVisible();
  });

  test("書いている間に、文法のエラーを行番号つきで表示し、保存を止める。使えない命令も知らせる", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.getByRole("button", { name: "スニペット" }).click();
    await page.getByRole("menuitem", { name: "マクロを管理…" }).click();
    await page.getByRole("button", { name: "追加" }).click();
    await page.getByLabel("名前").fill("x");
    await page
      .getByLabel("スクリプト")
      .fill("send 'a'\nexec 'ls'\nfrobnicate 1");
    const errors = page.getByRole("list", { name: "文法のエラー" });
    await expect(errors).toContainText(
      "2行目: exec は、このアプリでは使えません",
    );
    await expect(errors).toContainText("3行目");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByRole("alert")).toContainText("2行目");
    expect(await page.evaluate(() => window.__e2e.macros)).toEqual([]);
  });

  test("Tera Term の .ttl ファイルを読み込める（名前はファイル名から）", async ({
    page,
  }) => {
    await openApp(page);
    await openLocalTab(page);
    await page.evaluate(() => {
      window.__e2e.pickedFiles = ["/Users/me/scripts/setup.ttl"];
      window.__e2e.macroFileText =
        "; setup\ntimeout = 5\nwait 'login:'\nsendln 'admin'\n";
    });
    await page.getByRole("button", { name: "スニペット" }).click();
    await page.getByRole("menuitem", { name: "マクロを管理…" }).click();
    await page.getByRole("button", { name: "追加" }).click();
    await page.getByRole("button", { name: "ファイルから読み込む…" }).click();
    await expect(page.getByLabel("名前")).toHaveValue("setup");
    await expect(page.getByLabel("スクリプト")).toHaveValue(/timeout = 5/);
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByText("setup", { exact: true })).toBeVisible();
  });
});

test.describe("マクロの実行", () => {
  test("出力を待って送る。実行中は表示と停止ボタンが出て、終わると消える", async ({
    page,
  }) => {
    await openApp(page, {
      macros: [
        macro(
          "m1",
          "ログイン",
          "wait 'login:'\nsendln 'admin'\nwait 'Password:'\nsendln 'pw'",
        ),
      ],
    });
    await openLocalTab(page);
    await page.evaluate(() => {
      window.__e2e.echo = false;
    });
    await runFromMenu(page, "ログイン");
    await expect(banner(page)).toContainText("マクロ実行中: ログイン");
    await expect(banner(page)).toContainText("1行目");
    expect(await written(page)).toBe("");
    await output(page, "Welcome\r\nlogin: ");
    await expect.poll(() => written(page)).toBe("admin\r");
    await expect(banner(page)).toContainText("3行目");
    await output(page, "Password: ");
    await expect.poll(() => written(page)).toBe("admin\rpw\r");
    await expect(
      page.getByText("マクロ「ログイン」を終了しました"),
    ).toBeVisible();
    await expect(
      banner(page).getByRole("button", { name: "マクロを停止" }),
    ).toHaveCount(0);
  });

  test("マクロが送った文字は、画面（ローカルエコー）に出ない", async ({
    page,
  }) => {
    await openApp(page, {
      macros: [macro("m1", "秘密", "sendln 'top-secret-value'")],
    });
    await openLocalTab(page);
    await page.evaluate(() => {
      window.__e2e.echo = false;
    });
    await runFromMenu(page, "秘密");
    await expect.poll(() => written(page)).toBe("top-secret-value\r");
    await expect(screenText(page)).not.toContainText("top-secret-value");
  });

  test("条件分岐・繰り返し・文字列の命令（TTL の書き方）", async ({ page }) => {
    const script = [
      "sum = 0",
      "for i 1 4",
      "  if i = 3 then continue",
      "  sum = sum + i",
      "next",
      "sprintf 'sum=%d' sum",
      "sendln inputstr",
      "s = 'Hello'",
      "toupper t s",
      "strlen t",
      "if result = 5 then",
      "  sendln t",
      "else",
      "  sendln 'NG'",
      "endif",
      "i = 0",
      "while i < 2",
      "  inc i",
      "  sendln 'loop'",
      "endwhile",
    ].join("\n");
    await openApp(page, { macros: [macro("m1", "計算", script)] });
    await openLocalTab(page);
    await runFromMenu(page, "計算");
    await expect.poll(() => written(page)).toBe("sum=7\rHELLO\rloop\rloop\r");
  });

  test("配列（intdim / strdim）と strsplit / strjoin", async ({ page }) => {
    const script = [
      "intdim n 3",
      "for i 0 2",
      "  n[i] = (i + 1) * 10",
      "next",
      "sprintf '%d,%d,%d' n[0] n[1] n[2]",
      "sendln inputstr",
      "strdim p 4",
      "strsplit p 'a-b-c' '-'",
      "sendln result + 48",
      "strjoin p '+' 3",
      "sendln inputstr",
      "p[1] = 'X'",
      "sendln p[1]",
    ].join("\n");
    await openApp(page, { macros: [macro("m1", "配列", script)] });
    await openLocalTab(page);
    await runFromMenu(page, "配列");
    await expect.poll(() => written(page)).toBe("10,20,30\r3\ra+b+c\rX\r");
  });

  test("配列の添字が範囲外なら、行番号つきのエラー", async ({ page }) => {
    await openApp(page, {
      macros: [macro("m1", "範囲外", "intdim a 2\nsendln 'ok'\na[5] = 1")],
    });
    await openLocalTab(page);
    await runFromMenu(page, "範囲外");
    await expect(page.getByRole("alert")).toContainText("3行目");
    await expect(page.getByRole("alert")).toContainText("範囲外");
  });

  test("listbox: 一覧から選んだ番号が result に入る。キャンセルは -1", async ({
    page,
  }) => {
    const script = [
      "strdim m 3",
      "m[0] = '東京'",
      "m[1] = '大阪'",
      "m[2] = '福岡'",
      "listbox '接続先' '一覧' m 1",
      "if result >= 0 then",
      "  sendln m[result]",
      "else",
      "  sendln 'cancel'",
      "endif",
      "listbox '接続先' '一覧' m",
      "if result < 0 then sendln 'cancel'",
    ].join("\n");
    await openApp(page, { macros: [macro("m1", "選ぶ", script)] });
    await openLocalTab(page);
    await runFromMenu(page, "選ぶ");
    let dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("接続先");
    // 最初に指定した（1 番目の）項目が選ばれている。
    await expect(dialog.getByRole("radio", { name: "大阪" })).toBeChecked();
    await dialog.getByRole("radio", { name: "福岡" }).check();
    await dialog.getByRole("button", { name: "OK" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "キャンセル" }).click();
    await expect.poll(() => written(page)).toBe("福岡\rcancel\r");
  });

  test("goto / call / return（サブルーチン）", async ({ page }) => {
    await openApp(page, {
      macros: [
        macro(
          "m1",
          "サブ",
          "call hello\nsendln 'end'\nend\n:hello\nsendln 'hello'\nreturn",
        ),
      ],
    });
    await openLocalTab(page);
    await runFromMenu(page, "サブ");
    await expect.poll(() => written(page)).toBe("hello\rend\r");
  });

  test("messagebox・yesnobox・inputbox・passwordbox のダイアログが出て、答えが使われる", async ({
    page,
  }) => {
    const script = [
      "messagebox 'はじめます' 'お知らせ'",
      "yesnobox '続けますか？' '確認'",
      "if result = 0 then end",
      "inputbox 'ユーザー名' 'ログイン' 'bob'",
      "sendln inputstr",
      "passwordbox 'パスワード' '認証'",
      "sendln inputstr",
    ].join("\n");
    await openApp(page, { macros: [macro("m1", "対話", script)] });
    await openLocalTab(page);
    await page.evaluate(() => {
      window.__e2e.echo = false;
    });
    await runFromMenu(page, "対話");
    let dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("はじめます");
    await dialog.getByRole("button", { name: "OK" }).click();
    await expect(dialog).toContainText("続けますか？");
    await dialog.getByRole("button", { name: "はい" }).click();
    await expect(dialog.getByLabel("ユーザー名")).toHaveValue("bob");
    await dialog.getByLabel("ユーザー名").fill("alice");
    await dialog.getByRole("button", { name: "OK" }).click();
    dialog = page.getByRole("dialog");
    const pw = dialog.getByLabel("パスワード");
    await expect(pw).toHaveAttribute("type", "password");
    await pw.fill("s3cret");
    await pw.press("Enter");
    await expect.poll(() => written(page)).toBe("alice\rs3cret\r");
    // パスワードは、画面にも、保存される内容にも残らない。
    await expect(screenText(page)).not.toContainText("s3cret");
    const stored = await page.evaluate(() =>
      JSON.stringify([
        window.__e2e.macros,
        window.__e2e.session,
        window.__e2e.recent,
      ]),
    );
    expect(stored).not.toContain("s3cret");
  });

  test("「いいえ」を選ぶと、分岐して終わる", async ({ page }) => {
    await openApp(page, {
      macros: [
        macro(
          "m1",
          "確認",
          "yesnobox '送る？' 't'\nif result = 1 then\nsendln 'yes'\nelse\nsendln 'no'\nendif",
        ),
      ],
    });
    await openLocalTab(page);
    await runFromMenu(page, "確認");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "いいえ" })
      .click();
    await expect.poll(() => written(page)).toBe("no\r");
  });

  test("timeout を過ぎたら result が 0 になり、続きを実行できる", async ({
    page,
  }) => {
    await openApp(page, {
      macros: [
        macro(
          "m1",
          "待つ",
          "timeout = 1\nwait 'never'\nif result = 0 then\nsendln 'timed out'\nendif",
        ),
      ],
    });
    await openLocalTab(page);
    await runFromMenu(page, "待つ");
    await expect.poll(() => written(page)).toBe("timed out\r");
  });

  test("waitregex と recvln", async ({ page }) => {
    await openApp(page, {
      macros: [
        macro(
          "m1",
          "正規",
          "waitregex 'id=([0-9]+)'\nsendln groupmatchstr1\nrecvln\nsendln inputstr",
        ),
      ],
    });
    await openLocalTab(page);
    await runFromMenu(page, "正規");
    await output(page, "user id=42 ok\r\nnext line\r\n");
    // 一致した所（id=42）までを消費するので、recvln は、そのあとの行（" ok"）を読む。
    await expect.poll(() => written(page)).toBe("42\r ok\r");
  });

  test("「停止」ボタンで止まる", async ({ page }) => {
    await openApp(page, {
      macros: [macro("m1", "止める", "wait 'never'\nsendln 'after'")],
    });
    await openLocalTab(page);
    await runFromMenu(page, "止める");
    await banner(page).getByRole("button", { name: "マクロを停止" }).click();
    await expect(banner(page)).toHaveCount(0);
    await expect(
      page.getByText("マクロ「止める」を停止しました"),
    ).toBeVisible();
    await output(page, "never");
    await page.waitForTimeout(200);
    expect(await written(page)).toBe("");
  });

  test("確認ダイアログを閉じる（Esc）と「いいえ」として続く。入力はキャンセルなら空", async ({
    page,
  }) => {
    await openApp(page, {
      macros: [
        macro(
          "m1",
          "閉じる",
          "yesnobox '送る？' 't'\nsendln result\ninputbox '名前' 't'\nstrlen inputstr\nsendln result",
        ),
      ],
    });
    await openLocalTab(page);
    await runFromMenu(page, "閉じる");
    await expect(page.getByRole("dialog")).toContainText("送る？");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toContainText("名前");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "キャンセル" })
      .click();
    await expect.poll(() => written(page)).toBe("\u0000\r\u0000\r");
  });

  test("「⋯」のメニューは、実行中だけ「マクロを停止」を出す", async ({
    page,
  }) => {
    await openApp(page, { macros: [macro("m1", "待つ", "wait 'never'")] });
    await openLocalTab(page);
    expect(await paneMenuLabels(page)).not.toContain("マクロを停止");
    await runFromMenu(page, "待つ");
    await expect(banner(page)).toBeVisible();
    expect(await paneMenuLabels(page)).toContain("マクロを停止");
    await pickPaneMenu(page, "マクロを停止");
    await expect(banner(page)).toHaveCount(0);
  });

  test("実行時のエラーは、マクロ名と行番号つきで表示する", async ({ page }) => {
    await openApp(page, {
      macros: [macro("m1", "壊れ", "sendln 'a'\nx = 1 / 0")],
    });
    await openLocalTab(page);
    await runFromMenu(page, "壊れ");
    await expect(page.getByRole("alert")).toContainText(
      "マクロ「壊れ」: 2行目: 0 で割れません",
    );
  });

  test("実行中に、別のマクロは実行できない", async ({ page }) => {
    await openApp(page, {
      macros: [
        macro("m1", "長い", "wait 'never'"),
        macro("m2", "短い", "sendln 'x'"),
      ],
    });
    await openLocalTab(page);
    await runFromMenu(page, "長い");
    await expect(banner(page)).toBeVisible();
    await runFromMenu(page, "短い");
    await expect(page.getByRole("alert")).toContainText("実行中です");
    expect(await written(page)).toBe("");
  });

  test("コマンドパレットからも実行・停止できる", async ({ page }) => {
    await openApp(page, {
      macros: [macro("m1", "パレット用", "wait 'never'")],
    });
    await openLocalTab(page);
    await page.keyboard.press("Meta+Shift+p");
    await page
      .getByRole("combobox", { name: "コマンドを検索" })
      .fill("マクロを実行");
    await page.keyboard.press("Enter");
    await expect(banner(page)).toContainText("パレット用");
    await page.keyboard.press("Meta+Shift+p");
    await page
      .getByRole("combobox", { name: "コマンドを検索" })
      .fill("マクロを停止");
    await page.keyboard.press("Enter");
    await expect(banner(page)).toHaveCount(0);
  });

  test("管理画面の「実行」から実行できる", async ({ page }) => {
    await openApp(page, { macros: [macro("m1", "ここから", "sendln 'hi'")] });
    await openLocalTab(page);
    await page.getByRole("button", { name: "スニペット" }).click();
    await page.getByRole("menuitem", { name: "マクロを管理…" }).click();
    await page.getByRole("button", { name: "ここから を実行" }).click();
    await expect.poll(() => written(page)).toBe("hi\r");
    await expect(page.getByRole("heading", { name: "マクロ" })).toHaveCount(0);
  });

  test("分割したペインでは、操作中のペインだけで実行する", async ({ page }) => {
    await openApp(page, {
      macros: [macro("m1", "送る", "sendln 'only-here'")],
    });
    await openLocalTab(page);
    await page.keyboard.press("Meta+d");
    await runFromMenu(page, "送る");
    await expect.poll(() => written(page, 1)).toBe("only-here\r");
    expect(await written(page, 0)).toBe("");
  });

  test("dispstr は画面にだけ出す。sendbreak（シリアル以外）はエラー", async ({
    page,
  }) => {
    await openApp(page, {
      macros: [
        macro("m1", "表示", "dispstr 'local-note'"),
        macro("m2", "ブレーク", "sendbreak"),
      ],
    });
    await openLocalTab(page);
    await runFromMenu(page, "表示");
    await expect(screenText(page)).toContainText("local-note");
    expect(await written(page)).toBe("");
    await runFromMenu(page, "ブレーク");
    await expect(page.getByRole("alert")).toContainText("ブレーク");
  });

  test("シリアルなら、sendbreak でブレークを送る", async ({ page }) => {
    await openApp(page, { macros: [macro("m1", "ブレーク", "sendbreak")] });
    await page.getByRole("button", { name: "新しい接続" }).click();
    await page.getByLabel("接続種別").selectOption("serial");
    await page.getByLabel("シリアルポート").selectOption("__manual__");
    await page.getByLabel("ポート名（手入力）").fill("/dev/cu.test");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await expect(page.locator(".xterm").first()).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(1);
    await runFromMenu(page, "ブレーク");
    await expect
      .poll(async () => (await calls(page, "serial_send_break")).length)
      .toBe(1);
  });

  test("SSH でも実行できる。接続していない間は実行しない", async ({ page }) => {
    await openApp(page, { macros: [macro("m1", "ssh", "sendln 'uptime'")] });
    await openSshTab(page);
    await runFromMenu(page, "ssh");
    await expect.poll(() => written(page)).toBe("uptime\r");
  });

  test("タブがなければ、マクロは実行できない（項目が無効）", async ({
    page,
  }) => {
    await openApp(page, { macros: [macro("m1", "x", "end")] });
    await page.getByRole("button", { name: "スニペット" }).click();
    await expect(
      page.getByRole("menuitem", { name: "マクロ: x" }),
    ).toBeDisabled();
  });
});

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  cancelMacroDialogs,
  getCurrentMacroDialog,
  showMacroDialog,
} from "../lib/macro-dialog";
import { MacroDialogHost } from "./MacroDialogHost";

afterEach(() => cancelMacroDialogs("t"));

describe("MacroDialogHost", () => {
  it("要求がなければ何も表示しない", () => {
    render(<MacroDialogHost />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("メッセージ: タイトルと本文を表示し、OK で閉じて解決する", async () => {
    const user = userEvent.setup();
    render(<MacroDialogHost />);
    let done = false;
    let p!: Promise<unknown>;
    act(() => {
      p = showMacroDialog("t", {
        kind: "message",
        message: "完了しました",
        title: "お知らせ",
      }).then(() => (done = true));
    });
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("お知らせ");
    expect(dialog).toHaveTextContent("完了しました");
    await user.click(screen.getByRole("button", { name: "OK" }));
    await p;
    expect(done).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("はい／いいえ: ボタンで答える。閉じる（Esc）は「いいえ」", async () => {
    const user = userEvent.setup();
    render(<MacroDialogHost />);
    let a!: Promise<boolean>;
    act(() => {
      a = showMacroDialog("t", {
        kind: "yesno",
        message: "続ける？",
        title: "確認",
      });
    });
    await user.click(await screen.findByRole("button", { name: "はい" }));
    await expect(a).resolves.toBe(true);
    let b!: Promise<boolean>;
    act(() => {
      b = showMacroDialog("t", {
        kind: "yesno",
        message: "続ける？",
        title: "確認",
      });
    });
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await expect(b).resolves.toBe(false);
  });

  it("入力: 初期値を入れて表示し、OK（Enter でも）で返す。キャンセルは null", async () => {
    const user = userEvent.setup();
    render(<MacroDialogHost />);
    let a!: Promise<string | null>;
    act(() => {
      a = showMacroDialog("t", {
        kind: "input",
        message: "ユーザー名",
        title: "ログイン",
        initial: "bob",
      });
    });
    const box = await screen.findByLabelText("ユーザー名");
    expect(box).toHaveValue("bob");
    await user.clear(box);
    await user.type(box, "alice{Enter}");
    await expect(a).resolves.toBe("alice");

    let b!: Promise<string | null>;
    act(() => {
      b = showMacroDialog("t", {
        kind: "input",
        message: "x",
        title: "t",
        initial: "",
      });
    });
    await user.click(await screen.findByRole("button", { name: "キャンセル" }));
    await expect(b).resolves.toBeNull();
  });

  it("パスワード: 入力欄は伏せ字で、自動入力・記憶の対象にしない。画面に値を残さない", async () => {
    const user = userEvent.setup();
    render(<MacroDialogHost />);
    let a!: Promise<string | null>;
    act(() => {
      a = showMacroDialog("t", {
        kind: "password",
        message: "パスワード",
        title: "認証",
      });
    });
    const box = await screen.findByLabelText("パスワード");
    expect(box).toHaveAttribute("type", "password");
    expect(box).toHaveAttribute("autocomplete", "off");
    await user.type(box, "s3cret{Enter}");
    await expect(a).resolves.toBe("s3cret");
    expect(screen.queryByDisplayValue("s3cret")).toBeNull();
  });

  it("次の要求は、前の答えのあとに表示する。入力欄は、前の入力を引き継がない", async () => {
    const user = userEvent.setup();
    render(<MacroDialogHost />);
    let a!: Promise<string | null>;
    let b!: Promise<string | null>;
    act(() => {
      a = showMacroDialog("t", {
        kind: "input",
        message: "一つ目",
        title: "t",
        initial: "",
      });
      b = showMacroDialog("t", {
        kind: "input",
        message: "二つ目",
        title: "t",
        initial: "",
      });
    });
    await user.type(await screen.findByLabelText("一つ目"), "aaa{Enter}");
    await a;
    const second = await screen.findByLabelText("二つ目");
    expect(second).toHaveValue("");
    await user.type(second, "bbb{Enter}");
    await expect(b).resolves.toBe("bbb");
  });

  it("マクロが止まって要求が取り消されたら、ダイアログを閉じる", async () => {
    render(<MacroDialogHost />);
    act(() => {
      void showMacroDialog("t", { kind: "message", message: "m", title: "t" });
    });
    await screen.findByRole("dialog");
    act(() => cancelMacroDialogs("t"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(getCurrentMacroDialog()).toBeUndefined();
  });
});

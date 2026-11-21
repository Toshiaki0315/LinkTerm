import { afterEach, describe, expect, it, vi } from "vitest";
import {
  answerMacroDialog,
  cancelMacroDialogs,
  getCurrentMacroDialog,
  showMacroDialog,
  subscribeMacroDialogs,
} from "./macro-dialog";

afterEach(() => {
  cancelMacroDialogs("a");
  cancelMacroDialogs("b");
});

describe("macro-dialog", () => {
  it("要求を出すと現在のダイアログになり、答えると結果が返って消える", async () => {
    const p = showMacroDialog("a", {
      kind: "yesno",
      message: "続けますか？",
      title: "確認",
    });
    const cur = getCurrentMacroDialog();
    expect(cur?.request).toMatchObject({
      kind: "yesno",
      message: "続けますか？",
    });
    answerMacroDialog(cur!.id, true);
    await expect(p).resolves.toBe(true);
    expect(getCurrentMacroDialog()).toBeUndefined();
  });

  it("入力・パスワードの答え（文字列・キャンセルは null）", async () => {
    const input = showMacroDialog("a", {
      kind: "input",
      message: "名前",
      title: "t",
      initial: "bob",
    });
    answerMacroDialog(getCurrentMacroDialog()!.id, "alice");
    await expect(input).resolves.toBe("alice");
    const pw = showMacroDialog("a", {
      kind: "password",
      message: "pw",
      title: "t",
    });
    answerMacroDialog(getCurrentMacroDialog()!.id, null);
    await expect(pw).resolves.toBeNull();
  });

  it("メッセージは、閉じると解決する", async () => {
    const p = showMacroDialog("a", {
      kind: "message",
      message: "m",
      title: "t",
    });
    answerMacroDialog(getCurrentMacroDialog()!.id, undefined);
    await expect(p).resolves.toBeUndefined();
  });

  it("複数の要求は、出した順に1つずつ出す", async () => {
    const first = showMacroDialog("a", {
      kind: "message",
      message: "1",
      title: "t",
    });
    const second = showMacroDialog("b", {
      kind: "message",
      message: "2",
      title: "t",
    });
    expect(getCurrentMacroDialog()?.request).toMatchObject({ message: "1" });
    answerMacroDialog(getCurrentMacroDialog()!.id, undefined);
    await first;
    expect(getCurrentMacroDialog()?.request).toMatchObject({ message: "2" });
    answerMacroDialog(getCurrentMacroDialog()!.id, undefined);
    await second;
  });

  it("cancelMacroDialogs: そのマクロの要求だけを取り消し、既定の答え（いいえ・キャンセル）で解決する", async () => {
    const yesno = showMacroDialog("a", {
      kind: "yesno",
      message: "?",
      title: "t",
    });
    const input = showMacroDialog("a", {
      kind: "input",
      message: "?",
      title: "t",
      initial: "",
    });
    const other = showMacroDialog("b", {
      kind: "message",
      message: "other",
      title: "t",
    });
    cancelMacroDialogs("a");
    await expect(yesno).resolves.toBe(false);
    await expect(input).resolves.toBeNull();
    expect(getCurrentMacroDialog()?.request).toMatchObject({
      message: "other",
    });
    answerMacroDialog(getCurrentMacroDialog()!.id, undefined);
    await other;
  });

  it("購読者へ、出た・消えたを知らせる。解除すると知らせない", async () => {
    const cb = vi.fn();
    const off = subscribeMacroDialogs(cb);
    const p = showMacroDialog("a", {
      kind: "message",
      message: "m",
      title: "t",
    });
    expect(cb).toHaveBeenCalledTimes(1);
    answerMacroDialog(getCurrentMacroDialog()!.id, undefined);
    await p;
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    const q = showMacroDialog("a", {
      kind: "message",
      message: "m",
      title: "t",
    });
    expect(cb).toHaveBeenCalledTimes(2);
    cancelMacroDialogs("a");
    await q;
  });

  it("存在しない ID への答えは無視する", () => {
    expect(() => answerMacroDialog(999_999, true)).not.toThrow();
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Macro } from "../lib/macros";

const file = vi.hoisted(() => ({ pickMacroFile: vi.fn() }));
vi.mock("../lib/macro-file", () => file);

import { MacrosDialog } from "./MacrosDialog";

const mc = (over: Partial<Macro> = {}): Macro => ({
  id: "a",
  name: "ログイン",
  text: "wait 'login:'\nsendln 'admin'",
  ...over,
});

function setup(
  macros: Macro[] = [],
  onSave = vi.fn(async (_: Macro[]) => {}),
  onRun?: (m: Macro) => void,
) {
  const user = userEvent.setup();
  render(
    <MacrosDialog
      open
      onOpenChange={() => {}}
      macros={macros}
      onSave={onSave}
      onRun={onRun}
    />,
  );
  return { user, onSave };
}

beforeEach(() => vi.clearAllMocks());

describe("MacrosDialog", () => {
  it("空のときは案内を出し、パスワードを書かない注意を表示する", () => {
    setup();
    expect(screen.getByText("マクロはまだありません。")).toBeInTheDocument();
    expect(screen.getByText(/passwordbox/)).toBeInTheDocument();
  });

  it("追加して保存する（名前の前後の空白は除く）", async () => {
    const { user, onSave } = setup([mc()]);
    await user.click(screen.getByRole("button", { name: "追加" }));
    await user.type(screen.getByLabelText("名前"), " 再起動 ");
    await user.type(screen.getByLabelText("スクリプト"), "sendln 'reboot'");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls[0][0];
    expect(saved).toHaveLength(2);
    expect(saved[1]).toMatchObject({ name: "再起動", text: "sendln 'reboot'" });
  });

  it("文法のエラーを、書いている間に行番号つきで表示する。直ると「問題ありません」", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "追加" }));
    const box = screen.getByLabelText("スクリプト");
    expect(screen.getByText("文法: 問題ありません")).toBeInTheDocument();
    await user.type(box, "send 'a'{Enter}frobnicate 1");
    const list = await screen.findByRole("list", { name: "文法のエラー" });
    expect(list).toHaveTextContent("2行目");
    expect(list).toHaveTextContent("frobnicate");
    await user.clear(box);
    await user.type(box, "send 'a'");
    expect(screen.getByText("文法: 問題ありません")).toBeInTheDocument();
  });

  it("文法のエラーがあるときは、保存できない（理由を表示する）", async () => {
    const { user, onSave } = setup();
    await user.click(screen.getByRole("button", { name: "追加" }));
    await user.type(screen.getByLabelText("名前"), "x");
    await user.type(screen.getByLabelText("スクリプト"), "goto nowhere");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("nowhere");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("名前が空だと保存できない", async () => {
    const { user, onSave } = setup();
    await user.click(screen.getByRole("button", { name: "追加" }));
    await user.type(screen.getByLabelText("スクリプト"), "send 'a'");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("名前");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("編集して保存する（同じ ID のものを置き換える）", async () => {
    const { user, onSave } = setup([mc(), mc({ id: "b", name: "二つ目" })]);
    await user.click(screen.getByRole("button", { name: "ログイン を編集" }));
    const name = screen.getByLabelText("名前");
    await user.clear(name);
    await user.type(name, "新しい名前");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls[0][0];
    expect(saved.map((m) => m.name)).toEqual(["新しい名前", "二つ目"]);
  });

  it("削除する", async () => {
    const { user, onSave } = setup([mc(), mc({ id: "b", name: "二つ目" })]);
    await user.click(screen.getByRole("button", { name: "ログイン を削除" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].map((m) => m.id)).toEqual(["b"]);
  });

  it("保存の失敗は、理由を表示し、編集を続けられる", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("ディスクがいっぱいです");
    });
    const { user } = setup([], onSave);
    await user.click(screen.getByRole("button", { name: "追加" }));
    await user.type(screen.getByLabelText("名前"), "x");
    await user.type(screen.getByLabelText("スクリプト"), "send 'a'");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ディスクがいっぱいです",
    );
    expect(screen.getByLabelText("名前")).toBeInTheDocument();
  });

  it("「ファイルから読み込む…」で、.ttl の内容をスクリプトに入れる。名前が空なら、ファイル名を使う", async () => {
    file.pickMacroFile.mockResolvedValue({
      name: "login",
      text: "sendln 'x'",
    });
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "追加" }));
    await user.click(
      screen.getByRole("button", { name: "ファイルから読み込む…" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("スクリプト")).toHaveValue("sendln 'x'"),
    );
    expect(screen.getByLabelText("名前")).toHaveValue("login");
  });

  it("名前を入れてあれば、読み込んでも名前を変えない。キャンセルなら何もしない", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "追加" }));
    await user.type(screen.getByLabelText("名前"), "自分の名前");
    file.pickMacroFile.mockResolvedValueOnce({
      name: "login",
      text: "send 'a'",
    });
    await user.click(
      screen.getByRole("button", { name: "ファイルから読み込む…" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("スクリプト")).toHaveValue("send 'a'"),
    );
    expect(screen.getByLabelText("名前")).toHaveValue("自分の名前");
    file.pickMacroFile.mockResolvedValueOnce(null);
    await user.click(
      screen.getByRole("button", { name: "ファイルから読み込む…" }),
    );
    expect(screen.getByLabelText("スクリプト")).toHaveValue("send 'a'");
  });

  it("ファイルの読み込みに失敗したら、理由を表示する", async () => {
    file.pickMacroFile.mockRejectedValue("ファイルが大きすぎます");
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "追加" }));
    await user.click(
      screen.getByRole("button", { name: "ファイルから読み込む…" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("大きすぎます");
  });

  it("使えない命令（exec など）は、文法のエラーとして知らせる", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "追加" }));
    await user.type(screen.getByLabelText("スクリプト"), "exec 'ls'");
    expect(
      await screen.findByRole("list", { name: "文法のエラー" }),
    ).toHaveTextContent("このアプリでは使えません");
  });

  it("実行ボタンで、そのマクロを実行する（渡されたときだけ表示）", async () => {
    const onRun = vi.fn();
    const { user } = setup([mc()], undefined, onRun);
    await user.click(screen.getByRole("button", { name: "ログイン を実行" }));
    expect(onRun).toHaveBeenCalledWith(mc());
  });

  it("実行の処理がなければ、実行ボタンを出さない", () => {
    setup([mc()]);
    expect(screen.queryByRole("button", { name: /を実行/ })).toBeNull();
  });

  it("スクリプトの欄は、自動で大文字にしない・綴りを直さない（コードを書き換えられないため）", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "追加" }));
    const box = screen.getByLabelText("スクリプト");
    expect(box).toHaveAttribute("autocapitalize", "off");
    expect(box).toHaveAttribute("autocorrect", "off");
    expect(box).toHaveAttribute("spellcheck", "false");
  });
});

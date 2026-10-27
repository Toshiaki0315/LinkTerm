import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SearchBar } from "./SearchBar";

function setup(found = true) {
  const onFind = vi.fn().mockReturnValue(found);
  const onClear = vi.fn();
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(<SearchBar onFind={onFind} onClear={onClear} onClose={onClose} />);
  return { onFind, onClear, onClose, user };
}

describe("SearchBar", () => {
  it("開いたときに検索欄にフォーカスがある", () => {
    setup();
    expect(screen.getByRole("textbox", { name: "検索" })).toHaveFocus();
  });

  it("入力するたびに（インクリメンタルに）次の一致を探す", async () => {
    const { user, onFind } = setup();
    await user.type(screen.getByRole("textbox", { name: "検索" }), "err");
    expect(onFind).toHaveBeenLastCalledWith(
      "err",
      { caseSensitive: false, regex: false },
      "next",
      true,
    );
    expect(onFind).toHaveBeenCalledTimes(3);
  });

  it("Enter で次、Shift+Enter で前の一致へ", async () => {
    const { user, onFind } = setup();
    await user.type(screen.getByRole("textbox", { name: "検索" }), "x");
    onFind.mockClear();
    await user.keyboard("{Enter}");
    expect(onFind).toHaveBeenLastCalledWith(
      "x",
      expect.anything(),
      "next",
      false,
    );
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onFind).toHaveBeenLastCalledWith(
      "x",
      expect.anything(),
      "previous",
      false,
    );
  });

  it("▼ / ▲ ボタンでも移動できる", async () => {
    const { user, onFind } = setup();
    await user.type(screen.getByRole("textbox", { name: "検索" }), "x");
    await user.click(screen.getByRole("button", { name: "前の一致" }));
    expect(onFind).toHaveBeenLastCalledWith(
      "x",
      expect.anything(),
      "previous",
      false,
    );
    await user.click(screen.getByRole("button", { name: "次の一致" }));
    expect(onFind).toHaveBeenLastCalledWith(
      "x",
      expect.anything(),
      "next",
      false,
    );
  });

  it("大文字小文字・正規表現のオプションを渡す", async () => {
    const { user, onFind } = setup();
    await user.click(
      screen.getByRole("button", { name: "大文字と小文字を区別" }),
    );
    await user.click(screen.getByRole("button", { name: "正規表現" }));
    expect(screen.getByRole("button", { name: "正規表現" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.type(screen.getByRole("textbox", { name: "検索" }), "a.b");
    expect(onFind).toHaveBeenLastCalledWith(
      "a.b",
      { caseSensitive: true, regex: true },
      "next",
      true,
    );
  });

  it("オプションを変えたら、入力済みの語を探し直す", async () => {
    const { user, onFind } = setup();
    await user.type(screen.getByRole("textbox", { name: "検索" }), "abc");
    onFind.mockClear();
    await user.click(
      screen.getByRole("button", { name: "大文字と小文字を区別" }),
    );
    expect(onFind).toHaveBeenCalledWith(
      "abc",
      { caseSensitive: true, regex: false },
      "next",
      true,
    );
  });

  it("一致がなければ、その旨を表示する", async () => {
    const { user } = setup(false);
    await user.type(screen.getByRole("textbox", { name: "検索" }), "zzz");
    expect(screen.getByText("見つかりません")).toBeInTheDocument();
  });

  it("不正な正規表現はエラーにせず「見つかりません」とする", async () => {
    const onFind = vi.fn().mockImplementation(() => {
      throw new SyntaxError("Invalid regular expression");
    });
    const user = userEvent.setup();
    render(<SearchBar onFind={onFind} onClear={vi.fn()} onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "正規表現" }));
    await user.type(screen.getByRole("textbox", { name: "検索" }), "(");
    expect(screen.getByText("正規表現が正しくありません")).toBeInTheDocument();
  });

  it("空にしたら検索結果を消す（見つかりません表示も消える）", async () => {
    const { user, onClear } = setup(false);
    const input = screen.getByRole("textbox", { name: "検索" });
    await user.type(input, "zzz");
    await user.clear(input);
    expect(onClear).toHaveBeenCalled();
    expect(screen.queryByText("見つかりません")).not.toBeInTheDocument();
  });

  it("Esc と × ボタンで閉じる", async () => {
    const { user, onClose } = setup();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "検索を閉じる" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Input } from "./input";

describe("Input", () => {
  it("自動で大文字にしない・綴りを直さない・綴りの検査をしない（ホスト名・ユーザー名などを書き換えられないため）", () => {
    render(<Input aria-label="ホスト" />);
    const box = screen.getByLabelText("ホスト");
    expect(box).toHaveAttribute("autocapitalize", "off");
    expect(box).toHaveAttribute("autocorrect", "off");
    expect(box).toHaveAttribute("spellcheck", "false");
  });

  it("呼び出し側が、明示的に指定したときは、それを使う", () => {
    render(<Input aria-label="x" autoCapitalize="words" spellCheck />);
    const box = screen.getByLabelText("x");
    expect(box).toHaveAttribute("autocapitalize", "words");
    expect(box).toHaveAttribute("spellcheck", "true");
  });

  it("入力した文字は、そのまま保たれる（先頭も小文字のまま）", () => {
    render(<Input aria-label="y" defaultValue="myserver.example.com" />);
    expect(screen.getByLabelText("y")).toHaveValue("myserver.example.com");
  });
});

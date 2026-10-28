import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { HighlightRule } from "../lib/highlight";
import { HighlightsDialog } from "./HighlightsDialog";

const rule = (over: Partial<HighlightRule> = {}): HighlightRule => ({
  id: "a",
  pattern: "ERROR",
  regex: false,
  caseSensitive: false,
  color: "red",
  notify: false,
  ...over,
});

function setup(rules: HighlightRule[] = [], onSave = vi.fn(async () => {})) {
  const user = userEvent.setup();
  render(
    <HighlightsDialog
      open
      onOpenChange={() => {}}
      rules={rules}
      onSave={onSave}
    />,
  );
  return { user, onSave };
}

describe("HighlightsDialog", () => {
  it("空のときは案内を出す。一覧には色・正規表現・通知の印が出る", () => {
    setup();
    expect(screen.getByText("規則はまだありません。")).toBeInTheDocument();
  });

  it("規則の一覧を表示する", () => {
    setup([rule({ regex: true, notify: true })]);
    expect(screen.getByText("ERROR")).toBeInTheDocument();
    expect(screen.getByText("正規表現")).toBeInTheDocument();
    expect(screen.getByText("通知")).toBeInTheDocument();
  });

  it("追加して保存する（色・通知・正規表現の指定を含む）", async () => {
    const { user, onSave } = setup([rule()]);
    await user.click(screen.getByRole("button", { name: "追加" }));
    await user.type(screen.getByLabelText("見つけたい文字列"), "fail(ed)?");
    await user.click(screen.getByLabelText("正規表現として扱う"));
    await user.selectOptions(screen.getByLabelText("色"), "yellow");
    await user.click(screen.getByLabelText(/通知する/));
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = (onSave.mock.calls[0] as unknown as [HighlightRule[]])[0];
    expect(saved).toHaveLength(2);
    expect(saved[1]).toMatchObject({
      pattern: "fail(ed)?",
      regex: true,
      color: "yellow",
      notify: true,
      caseSensitive: false,
    });
  });

  it("不正な入力（空・壊れた正規表現）は保存せず理由を表示する", async () => {
    const { user, onSave } = setup();
    await user.click(screen.getByRole("button", { name: "追加" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByRole("alert")).toHaveTextContent("文字列を入力");
    await user.type(screen.getByLabelText("見つけたい文字列"), "(");
    await user.click(screen.getByLabelText("正規表現として扱う"));
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "正規表現が正しくありません",
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it("編集と削除ができる", async () => {
    const { user, onSave } = setup([
      rule(),
      rule({ id: "b", pattern: "WARN" }),
    ]);
    await user.click(screen.getByRole("button", { name: "ERROR を編集" }));
    const input = screen.getByLabelText("見つけたい文字列");
    await user.clear(input);
    await user.type(input, "FATAL");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenLastCalledWith([
      rule({ pattern: "FATAL" }),
      rule({ id: "b", pattern: "WARN" }),
    ]);
    await user.click(screen.getByRole("button", { name: "WARN を削除" }));
    expect(onSave).toHaveBeenLastCalledWith([rule()]);
  });

  it("保存に失敗したら理由を表示し、編集中の内容を保つ", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("ディスクがいっぱい");
    });
    const { user } = setup([], onSave);
    await user.click(screen.getByRole("button", { name: "追加" }));
    await user.type(screen.getByLabelText("見つけたい文字列"), "x");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ディスクがいっぱい",
    );
    expect(screen.getByLabelText("見つけたい文字列")).toHaveValue("x");
  });
});

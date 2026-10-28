import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Snippet } from "../lib/snippets";
import { SnippetsDialog, validateSnippet } from "./SnippetsDialog";

const sn = (over: Partial<Snippet> = {}): Snippet => ({
  id: "a",
  name: "ping",
  text: "ping -c 3 8.8.8.8",
  lineDelayMs: 100,
  sendEnter: true,
  ...over,
});

function setup(snippets: Snippet[] = [], onSave = vi.fn(async () => {})) {
  const user = userEvent.setup();
  render(
    <SnippetsDialog
      open
      onOpenChange={() => {}}
      snippets={snippets}
      onSave={onSave}
    />,
  );
  return { user, onSave };
}

describe("validateSnippet", () => {
  it("問題がなければ null、あれば理由を返す", () => {
    expect(validateSnippet(sn())).toBeNull();
    expect(validateSnippet(sn({ name: "  " }))).toMatch(/名前/);
    expect(validateSnippet(sn({ text: "" }))).toMatch(/内容/);
    expect(validateSnippet(sn({ lineDelayMs: -1 }))).toMatch(/待ち時間/);
    expect(validateSnippet(sn({ lineDelayMs: NaN }))).toMatch(/待ち時間/);
    expect(validateSnippet(sn({ lineDelayMs: 10_001 }))).toMatch(/待ち時間/);
    expect(validateSnippet(sn({ name: "あ".repeat(61) }))).toMatch(/名前/);
  });
});

describe("SnippetsDialog", () => {
  it("空のときは案内を出し、秘密情報を入れない注意を表示する", () => {
    setup();
    expect(
      screen.getByText("スニペットはまだありません。"),
    ).toBeInTheDocument();
    expect(screen.getByText(/秘密情報は登録しないで/)).toBeInTheDocument();
  });

  it("追加して保存する", async () => {
    const { user, onSave } = setup([sn()]);
    await user.click(screen.getByRole("button", { name: "追加" }));
    await user.type(screen.getByLabelText("名前"), " 再起動 ");
    await user.type(screen.getByLabelText(/^内容/), "reboot");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = (onSave.mock.calls[0] as unknown as [Snippet[]])[0];
    expect(saved).toHaveLength(2);
    expect(saved[1]).toMatchObject({ name: "再起動", text: "reboot" });
  });

  it("入力が不正なら保存せず理由を表示する", async () => {
    const { user, onSave } = setup();
    await user.click(screen.getByRole("button", { name: "追加" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByRole("alert")).toHaveTextContent("名前を入力");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("編集して保存する（IDは変わらない）", async () => {
    const { user, onSave } = setup([sn()]);
    await user.click(screen.getByRole("button", { name: "ping を編集" }));
    const name = screen.getByLabelText("名前");
    await user.clear(name);
    await user.type(name, "ping2");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith([sn({ name: "ping2" })]);
  });

  it("削除する", async () => {
    const { user, onSave } = setup([sn(), sn({ id: "b", name: "x" })]);
    await user.click(screen.getByRole("button", { name: "ping を削除" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith([sn({ id: "b", name: "x" })]);
  });

  it("保存に失敗したら理由を表示し、編集中の内容を保つ", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("ディスクがいっぱい");
    });
    const { user } = setup([], onSave);
    await user.click(screen.getByRole("button", { name: "追加" }));
    await user.type(screen.getByLabelText("名前"), "a");
    await user.type(screen.getByLabelText(/^内容/), "ls");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ディスクがいっぱい",
    );
    expect(screen.getByLabelText("名前")).toHaveValue("a");
  });
});

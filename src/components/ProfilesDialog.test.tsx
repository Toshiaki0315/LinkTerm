import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SavedProfile } from "../lib/terminal-api";
import { ProfilesDialog } from "./ProfilesDialog";

const profile = (
  id: string,
  name: string,
  folder?: string,
  tags?: string[],
): SavedProfile => ({ id, name, values: { type: "local" }, folder, tags });

const profiles = [
  profile("1", "web-01", "本番", ["東京", "nginx"]),
  profile("2", "db-01", "本番"),
  profile("3", "test-box", "検証"),
  profile("4", "手元"),
];

function setup(over: Partial<Parameters<typeof ProfilesDialog>[0]> = {}) {
  const user = userEvent.setup();
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    profiles,
    onOpenProfile: vi.fn(),
    onUpdate: vi.fn(async () => {}),
    onDelete: vi.fn(),
    ...over,
  };
  render(<ProfilesDialog {...props} />);
  return { user, ...props };
}

describe("ProfilesDialog", () => {
  it("フォルダーごとに表示する（未分類は最後）。タグも表示する", () => {
    setup();
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toEqual(["検証", "本番", "未分類"]);
    const prod = screen.getByRole("region", { name: "本番" });
    expect(within(prod).getAllByRole("listitem")).toHaveLength(2);
    expect(within(prod).getByText("東京")).toBeInTheDocument();
  });

  it("名前・フォルダー・タグで絞り込む。一致がなければ案内を出す", async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText("接続を検索"), "東京");
    expect(screen.getByText("web-01")).toBeInTheDocument();
    expect(screen.queryByText("db-01")).toBeNull();
    await user.clear(screen.getByLabelText("接続を検索"));
    await user.type(screen.getByLabelText("接続を検索"), "検証 test");
    expect(screen.getByText("test-box")).toBeInTheDocument();
    await user.type(screen.getByLabelText("接続を検索"), " zzz");
    expect(screen.getByText("一致する接続がありません。")).toBeInTheDocument();
  });

  it("接続が1つもなければ、保存の仕方を案内する", () => {
    setup({ profiles: [] });
    expect(screen.getByText(/まだありません/)).toBeInTheDocument();
  });

  it("「接続」で閉じて接続する", async () => {
    const { user, onOpenProfile, onOpenChange } = setup();
    await user.click(screen.getByRole("button", { name: "web-01 に接続" }));
    expect(onOpenProfile).toHaveBeenCalledWith(profiles[0]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("名前・フォルダー・タグを編集して保存する", async () => {
    const { user, onUpdate } = setup();
    await user.click(screen.getByRole("button", { name: "手元 を編集" }));
    await user.clear(screen.getByLabelText("名前"));
    await user.type(screen.getByLabelText("名前"), "ローカル作業");
    await user.type(screen.getByLabelText("フォルダー"), "検証");
    await user.type(screen.getByLabelText(/^タグ/), "a, B、a");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    expect(onUpdate).toHaveBeenCalledWith({
      id: "4",
      name: "ローカル作業",
      folder: "検証",
      tags: ["a", "B"],
    });
  });

  it("名前が空なら保存しない。保存に失敗したら理由を表示し、編集を続けられる", async () => {
    const onUpdate = vi.fn(async () => {
      throw new Error("フォルダー名が不正です");
    });
    const { user } = setup({ onUpdate });
    await user.click(screen.getByRole("button", { name: "手元 を編集" }));
    await user.clear(screen.getByLabelText("名前"));
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByRole("alert")).toHaveTextContent("名前を入力");
    expect(onUpdate).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("名前"), "x");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "フォルダー名が不正です",
    );
    expect(screen.getByLabelText("名前")).toHaveValue("x");
  });

  it("削除は確認してから行う", async () => {
    const { user, onDelete } = setup();
    await user.click(screen.getByRole("button", { name: "手元 を削除" }));
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "やめる" }));
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "手元 を削除" }));
    await user.click(screen.getByRole("button", { name: "削除する" }));
    expect(onDelete).toHaveBeenCalledWith("4");
  });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BINDINGS,
  resolveBindings,
  type Bindings,
} from "../lib/shortcuts";
import { ShortcutsDialog } from "./ShortcutsDialog";

function setup(
  bindings: Bindings = DEFAULT_BINDINGS,
  onSave = vi.fn(async () => {}),
) {
  const user = userEvent.setup();
  render(
    <ShortcutsDialog
      open
      onOpenChange={() => {}}
      bindings={bindings}
      onSave={onSave}
    />,
  );
  return { user, onSave };
}

const pressMeta = (key: string, shift = false) =>
  fireEvent.keyDown(window, { key, metaKey: true, shiftKey: shift });

describe("ShortcutsDialog", () => {
  it("操作ごとに、いまのキーを記号で表示する", () => {
    setup();
    expect(screen.getByLabelText("新しい接続 の現在のキー")).toHaveTextContent(
      "⌘T",
    );
    expect(
      screen.getByLabelText("コマンドパレット の現在のキー"),
    ).toHaveTextContent("⇧⌘P");
  });

  it("「変更」のあとに押したキーを割り当てて保存する", async () => {
    const { user, onSave } = setup();
    await user.click(
      screen.getByRole("button", {
        name: "コマンドパレット のショートカットを変更",
      }),
    );
    expect(
      screen.getByLabelText("コマンドパレット の現在のキー"),
    ).toHaveTextContent("キーを押す…");
    pressMeta("k");
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith({
      ...DEFAULT_BINDINGS,
      palette: "Cmd+k",
    });
  });

  it("Shift 付きの記号（⌘⇧[ の { など）も記録する", async () => {
    const { user, onSave } = setup();
    await user.click(
      screen.getByRole("button", { name: "次のタブ のショートカットを変更" }),
    );
    pressMeta("}", true);
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith({
      ...DEFAULT_BINDINGS,
      "next-tab": "Cmd+Shift+]",
    });
  });

  it("使えないキー・重複は、理由を表示して保存せず、待ち続ける", async () => {
    const { user, onSave } = setup();
    await user.click(
      screen.getByRole("button", { name: "新しい接続 のショートカットを変更" }),
    );
    pressMeta("c");
    expect(screen.getByRole("alert")).toHaveTextContent("システム");
    pressMeta("w");
    expect(screen.getByRole("alert")).toHaveTextContent("タブ／ペインを閉じる");
    pressMeta("4");
    expect(screen.getByRole("alert")).toHaveTextContent("番号");
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText("新しい接続 の現在のキー")).toHaveTextContent(
      "キーを押す…",
    );
  });

  it("⌘ なしのキーは案内を出す。修飾キーだけの間は待つ。Esc で取り消す（ダイアログは閉じない）", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ShortcutsDialog
        open
        onOpenChange={onOpenChange}
        bindings={DEFAULT_BINDINGS}
        onSave={async () => {}}
      />,
    );
    await user.click(
      screen.getByRole("button", {
        name: "画面内を検索 のショートカットを変更",
      }),
    );
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.keyDown(window, { key: "a" });
    expect(screen.getByRole("status")).toHaveTextContent("⌘ を押しながら");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.getByLabelText("画面内を検索 の現在のキー"),
    ).toHaveTextContent("⌘F");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("「初期値」で1つ戻し、「すべて初期値に戻す」で全部戻す。初期値のときは押せない", async () => {
    const changed = resolveBindings([{ id: "palette", binding: "Cmd+k" }]);
    const { user, onSave } = setup(changed);
    expect(
      screen.getByRole("button", { name: "新しい接続 を初期値に戻す" }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "コマンドパレット を初期値に戻す" }),
    );
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(DEFAULT_BINDINGS));
    await user.click(
      screen.getByRole("button", { name: "すべて初期値に戻す" }),
    );
    expect(onSave).toHaveBeenLastCalledWith(DEFAULT_BINDINGS);
  });

  it("初期値が、ほかの操作に取られていれば、戻せず理由を表示する", async () => {
    const swapped: Bindings = {
      ...DEFAULT_BINDINGS,
      new: "Cmd+k",
      palette: "Cmd+t",
    };
    // new=⌘K, palette=⌘T。new を初期値（⌘T）へ戻そうとすると、palette と重複する。
    const { user, onSave } = setup(swapped);
    await user.click(
      screen.getByRole("button", { name: "新しい接続 を初期値に戻す" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("コマンドパレット");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("保存に失敗したら理由を表示する", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("ディスクがいっぱい");
    });
    const { user } = setup(DEFAULT_BINDINGS, onSave);
    await user.click(
      screen.getByRole("button", {
        name: "コマンドパレット のショートカットを変更",
      }),
    );
    pressMeta("k");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ディスクがいっぱい",
    );
  });
});

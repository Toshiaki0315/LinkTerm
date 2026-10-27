import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  setControlSignal: vi.fn(),
  sendBreak: vi.fn(),
  setDisplayMode: vi.fn(),
}));
vi.mock("../lib/terminal-api", () => api);

import { SerialControls } from "./SerialControls";

beforeEach(() => {
  vi.clearAllMocks();
  api.setControlSignal.mockResolvedValue(undefined);
  api.sendBreak.mockResolvedValue(undefined);
  api.setDisplayMode.mockResolvedValue(undefined);
});

describe("SerialControls", () => {
  it("DTR / RTS は初期状態でオン、HEX 表示はオフ", () => {
    render(<SerialControls sessionId="s1" />);
    expect(screen.getByRole("button", { name: "DTR" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "RTS" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "HEX表示" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("DTR / RTS を切り替えると、設定してから表示を更新する", async () => {
    const user = userEvent.setup();
    render(<SerialControls sessionId="s1" />);
    await user.click(screen.getByRole("button", { name: "DTR" }));
    expect(api.setControlSignal).toHaveBeenCalledWith("s1", "dtr", false);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "DTR" })).toHaveAttribute(
        "aria-pressed",
        "false",
      ),
    );
    await user.click(screen.getByRole("button", { name: "DTR" }));
    expect(api.setControlSignal).toHaveBeenLastCalledWith("s1", "dtr", true);
    await user.click(screen.getByRole("button", { name: "RTS" }));
    expect(api.setControlSignal).toHaveBeenLastCalledWith("s1", "rts", false);
  });

  it("設定に失敗したら、表示は変えずに理由を表示する", async () => {
    api.setControlSignal.mockRejectedValue("この接続では使えない操作です");
    const user = userEvent.setup();
    render(<SerialControls sessionId="s1" />);
    await user.click(screen.getByRole("button", { name: "RTS" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "この接続では使えない操作です",
    );
    expect(screen.getByRole("button", { name: "RTS" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("ブレークを送る（送信中は押せない）", async () => {
    let finish!: () => void;
    api.sendBreak.mockReturnValue(new Promise<void>((r) => (finish = r)));
    const user = userEvent.setup();
    render(<SerialControls sessionId="s1" />);
    await user.click(screen.getByRole("button", { name: "ブレーク送信" }));
    expect(api.sendBreak).toHaveBeenCalledWith("s1");
    expect(screen.getByRole("button", { name: "ブレーク送信" })).toBeDisabled();
    finish();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "ブレーク送信" }),
      ).toBeEnabled(),
    );
  });

  it("ブレーク送信の失敗を表示する", async () => {
    api.sendBreak.mockRejectedValue("ブレークを送れません");
    const user = userEvent.setup();
    render(<SerialControls sessionId="s1" />);
    await user.click(screen.getByRole("button", { name: "ブレーク送信" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ブレークを送れません",
    );
  });

  it("HEX 表示を切り替える", async () => {
    const user = userEvent.setup();
    render(<SerialControls sessionId="s1" />);
    await user.click(screen.getByRole("button", { name: "HEX表示" }));
    expect(api.setDisplayMode).toHaveBeenCalledWith("s1", "hex");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "HEX表示" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    await user.click(screen.getByRole("button", { name: "HEX表示" }));
    expect(api.setDisplayMode).toHaveBeenLastCalledWith("s1", "text");
  });

  it("接続していない間は操作できない", () => {
    render(<SerialControls sessionId={null} />);
    for (const name of ["DTR", "RTS", "ブレーク送信", "HEX表示"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });
});

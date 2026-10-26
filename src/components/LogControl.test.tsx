import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  startSessionLog: vi.fn(),
  stopSessionLog: vi.fn(),
  defaultLogPath: vi.fn(),
  onLogError: vi.fn(),
}));
vi.mock("../lib/terminal-api", () => api);

import { LogControl } from "./LogControl";

let emitError: (id: string, message: string) => void;

beforeEach(() => {
  vi.clearAllMocks();
  api.startSessionLog.mockResolvedValue(undefined);
  api.stopSessionLog.mockResolvedValue(undefined);
  api.defaultLogPath.mockResolvedValue("/logs/default.log");
  api.onLogError.mockImplementation(async (cb) => {
    emitError = cb;
    return () => {};
  });
});

describe("LogControl", () => {
  it("セッション確立前は押せない", () => {
    render(<LogControl sessionId={null} title="Local" />);
    expect(screen.getByRole("button", { name: "ログ記録" })).toBeDisabled();
  });

  it("ダイアログで開始 → 停止ボタンに変わり、停止で元に戻る", async () => {
    const user = userEvent.setup();
    render(<LogControl sessionId="s1" title="alice@h" />);
    await user.click(screen.getByRole("button", { name: "ログ記録" }));
    expect(api.defaultLogPath).toHaveBeenCalledWith("alice@h");
    expect(await screen.findByLabelText("保存先")).toHaveValue(
      "/logs/default.log",
    );
    await user.click(screen.getByRole("button", { name: "記録開始" }));
    await waitFor(() =>
      expect(api.startSessionLog).toHaveBeenCalledWith("s1", {
        path: "/logs/default.log",
        mode: "Text",
        timestamps: false,
        append: true,
      }),
    );
    const stop = await screen.findByRole("button", { name: "ログ記録を停止" });
    await user.click(stop);
    expect(api.stopSessionLog).toHaveBeenCalledWith("s1");
    expect(
      await screen.findByRole("button", { name: "ログ記録" }),
    ).toBeInTheDocument();
  });

  it("書き込みエラーを受けたら記録中表示を戻し、メッセージを表示する", async () => {
    const user = userEvent.setup();
    render(<LogControl sessionId="s1" title="t" />);
    await user.click(screen.getByRole("button", { name: "ログ記録" }));
    await user.click(await screen.findByRole("button", { name: "記録開始" }));
    await screen.findByRole("button", { name: "ログ記録を停止" });
    act(() => emitError("other", "ignored"));
    expect(
      screen.getByRole("button", { name: "ログ記録を停止" }),
    ).toBeInTheDocument();
    act(() => emitError("s1", "disk full"));
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    expect(
      screen.getByRole("button", { name: "ログ記録" }),
    ).toBeInTheDocument();
  });

  it("既定パスの取得に失敗しても手入力で開始できる", async () => {
    api.defaultLogPath.mockRejectedValue("取得失敗");
    const user = userEvent.setup();
    render(<LogControl sessionId="s1" title="t" />);
    await user.click(screen.getByRole("button", { name: "ログ記録" }));
    expect(await screen.findByLabelText("保存先")).toHaveValue("");
  });

  it("開始コマンドが失敗したら記録中にせず、理由を表示する", async () => {
    api.startSessionLog.mockRejectedValue("切り詰めに失敗しました");
    const user = userEvent.setup();
    render(<LogControl sessionId="s1" title="t" />);
    await user.click(screen.getByRole("button", { name: "ログ記録" }));
    await user.click(await screen.findByRole("button", { name: "記録開始" }));
    expect(
      await screen.findByText(/切り詰めに失敗しました/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "ログ記録を停止" }),
    ).not.toBeInTheDocument();
  });

  it("開始の応答より先に失敗イベントが届いても、記録中表示で上書きしない", async () => {
    api.startSessionLog.mockImplementation(async () => {
      emitError("s1", "切り詰めに失敗しました");
    });
    const user = userEvent.setup();
    render(<LogControl sessionId="s1" title="t" />);
    await user.click(screen.getByRole("button", { name: "ログ記録" }));
    await user.click(await screen.findByRole("button", { name: "記録開始" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "切り詰めに失敗しました",
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "ログ記録を停止" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "ログ記録" }),
    ).toBeInTheDocument();
  });
});

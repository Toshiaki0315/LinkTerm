import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  onHostKeyRequest: vi.fn(),
  respondHostKey: vi.fn(),
  pendingHostKeyRequests: vi.fn(),
  listSerialPorts: vi.fn(),
}));
vi.mock("./lib/terminal-api", () => api);
vi.mock("./components/TerminalTab", () => ({
  TerminalTab: ({ tabId }: { tabId: string }) => (
    <div data-testid={`term-${tabId}`} />
  ),
}));

import App from "./App";

let emitHostKey: (r: {
  requestId: string;
  host: string;
  port: number;
  fingerprint: string;
}) => void;

beforeEach(() => {
  vi.clearAllMocks();
  api.onHostKeyRequest.mockImplementation(async (cb) => {
    emitHostKey = cb;
    return () => {};
  });
  api.respondHostKey.mockResolvedValue(undefined);
  api.pendingHostKeyRequests.mockResolvedValue([]);
  api.listSerialPorts.mockResolvedValue([]);
});

describe("App", () => {
  it("アプリ名と空状態を表示する", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { name: "LinkTerm" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/新しい接続/)).toBeInTheDocument();
  });

  it("接続ダイアログからタブを追加・切替・閉じる", async () => {
    const user = userEvent.setup();
    render(<App />);
    for (let i = 0; i < 2; i++) {
      await user.click(screen.getByRole("button", { name: "新しい接続" }));
      await user.click(await screen.findByRole("button", { name: "接続" }));
      await waitFor(() =>
        expect(screen.getAllByRole("tab")).toHaveLength(i + 1),
      );
    }
    const tabs = screen.getAllByRole("tab");
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    await user.click(tabs[0]);
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.click(screen.getAllByRole("button", { name: /を閉じる/ })[0]);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("ホスト鍵の承認要求を表示して応答する", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(api.onHostKeyRequest).toHaveBeenCalled());
    act(() =>
      emitHostKey({
        requestId: "r9",
        host: "h",
        port: 22,
        fingerprint: "SHA256:zz",
      }),
    );
    await user.click(
      await screen.findByRole("button", { name: "信頼して接続" }),
    );
    expect(api.respondHostKey).toHaveBeenCalledWith("r9", true);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("購読前に出た未応答のホスト鍵要求も取り込んで表示する", async () => {
    api.pendingHostKeyRequests.mockResolvedValue([
      {
        requestId: "early",
        host: "early.example",
        port: 22,
        fingerprint: "SHA256:early",
      },
    ]);
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText("SHA256:early")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "信頼して接続" }));
    expect(api.respondHostKey).toHaveBeenCalledWith("early", true);
  });

  it("購読を確立してから未応答の要求を問い合わせる（取りこぼし防止）", async () => {
    const order: string[] = [];
    api.onHostKeyRequest.mockImplementation(async (cb) => {
      emitHostKey = cb;
      order.push("subscribed");
      return () => {};
    });
    api.pendingHostKeyRequests.mockImplementation(async () => {
      order.push("queried");
      return [];
    });
    render(<App />);
    await waitFor(() => expect(order).toEqual(["subscribed", "queried"]));
  });

  it("イベントと問い合わせで同じ要求が重複しても1回だけ表示・応答する", async () => {
    const req = {
      requestId: "dup",
      host: "h",
      port: 22,
      fingerprint: "SHA256:dup",
    };
    let resolvePending!: (v: unknown[]) => void;
    api.pendingHostKeyRequests.mockReturnValue(
      new Promise((r) => (resolvePending = r)),
    );
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(api.onHostKeyRequest).toHaveBeenCalled());
    act(() => emitHostKey(req));
    await act(async () => resolvePending([req]));
    await user.click(
      await screen.findByRole("button", { name: "信頼して接続" }),
    );
    expect(api.respondHostKey).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("問い合わせに失敗してもアプリは使え、後続のイベントは受け取れる", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    api.pendingHostKeyRequests.mockRejectedValue("失敗");
    render(<App />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    act(() =>
      emitHostKey({
        requestId: "later",
        host: "h",
        port: 22,
        fingerprint: "SHA256:later",
      }),
    );
    expect(await screen.findByText("SHA256:later")).toBeInTheDocument();
    spy.mockRestore();
  });
});

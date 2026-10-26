import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HostKeyDialog } from "./HostKeyDialog";

const request = {
  requestId: "r1",
  host: "example.com",
  port: 22,
  fingerprint: "SHA256:abc",
};

describe("HostKeyDialog", () => {
  it("request が null なら何も表示しない", () => {
    render(<HostKeyDialog request={null} onRespond={() => {}} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("ホストとフィンガープリントを表示する", () => {
    render(<HostKeyDialog request={request} onRespond={() => {}} />);
    expect(screen.getByText(/example\.com:22/)).toBeInTheDocument();
    expect(screen.getByText("SHA256:abc")).toBeInTheDocument();
  });

  it("信頼する → approved=true", async () => {
    const onRespond = vi.fn();
    render(<HostKeyDialog request={request} onRespond={onRespond} />);
    await userEvent.click(screen.getByRole("button", { name: "信頼して接続" }));
    expect(onRespond).toHaveBeenCalledWith("r1", true);
  });

  it("キャンセル・Esc → approved=false（安全側）", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn();
    const { rerender } = render(
      <HostKeyDialog request={request} onRespond={onRespond} />,
    );
    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(onRespond).toHaveBeenLastCalledWith("r1", false);
    rerender(
      <HostKeyDialog
        request={{ ...request, requestId: "r2" }}
        onRespond={onRespond}
      />,
    );
    await user.keyboard("{Escape}");
    expect(onRespond).toHaveBeenLastCalledWith("r2", false);
  });
});

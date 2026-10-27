import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EchoControl } from "./EchoControl";

describe("EchoControl", () => {
  it("現在のモードと実際の状態を表示する", () => {
    const { rerender } = render(
      <EchoControl mode="auto" effective={false} onChange={() => {}} />,
    );
    expect(
      screen.getByRole("button", { name: "ローカルエコーの切り替え" }),
    ).toHaveTextContent("エコー: 自動（オフ）");
    rerender(<EchoControl mode="auto" effective onChange={() => {}} />);
    expect(screen.getByRole("button")).toHaveTextContent(
      "エコー: 自動（オン）",
    );
    rerender(<EchoControl mode="on" effective onChange={() => {}} />);
    expect(screen.getByRole("button")).toHaveTextContent("エコー: オン");
    rerender(<EchoControl mode="off" effective={false} onChange={() => {}} />);
    expect(screen.getByRole("button")).toHaveTextContent("エコー: オフ");
  });

  it("押すたびに 自動 → オン → オフ → 自動 と切り替える", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <EchoControl mode="auto" effective={false} onChange={onChange} />,
    );
    await user.click(screen.getByRole("button"));
    expect(onChange).toHaveBeenLastCalledWith("on");
    rerender(<EchoControl mode="on" effective onChange={onChange} />);
    await user.click(screen.getByRole("button"));
    expect(onChange).toHaveBeenLastCalledWith("off");
    rerender(<EchoControl mode="off" effective={false} onChange={onChange} />);
    await user.click(screen.getByRole("button"));
    expect(onChange).toHaveBeenLastCalledWith("auto");
  });
});

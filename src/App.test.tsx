import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  it("アプリ名 LinkTerm を表示する", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { name: "LinkTerm" }),
    ).toBeInTheDocument();
  });
});

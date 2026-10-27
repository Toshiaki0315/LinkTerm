import { describe, expect, it } from "vitest";
import { TAB_COLORS, tabColorHex, tabColorLabel } from "./tab-colors";

describe("tab-colors", () => {
  it("色の id から表示色と名前を引ける", () => {
    expect(tabColorHex("red")).toBe("#ef4444");
    expect(tabColorLabel("blue")).toBe("青");
  });

  it("色なし・不明な値は undefined", () => {
    expect(tabColorHex("none")).toBeUndefined();
    expect(tabColorHex(undefined)).toBeUndefined();
    expect(tabColorHex("magenta")).toBeUndefined();
  });

  it("id は重複しない", () => {
    const ids = TAB_COLORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

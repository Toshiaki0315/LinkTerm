import { beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-notification", () => plugin);

import { notifyMatch, Throttle } from "./notify";

beforeEach(() => vi.clearAllMocks());

describe("Throttle", () => {
  it("同じキーは間隔が空くまで許可しない。別のキーは別に数える", () => {
    let now = 0;
    const t = new Throttle(1000, () => now);
    expect(t.allow("a")).toBe(true);
    expect(t.allow("a")).toBe(false);
    expect(t.allow("b")).toBe(true);
    now = 999;
    expect(t.allow("a")).toBe(false);
    now = 1000;
    expect(t.allow("a")).toBe(true);
  });
});

describe("notifyMatch", () => {
  it("許可済みなら通知を出す", async () => {
    plugin.isPermissionGranted.mockResolvedValue(true);
    await expect(notifyMatch("t", "b")).resolves.toBe(true);
    expect(plugin.sendNotification).toHaveBeenCalledWith({
      title: "t",
      body: "b",
    });
    expect(plugin.requestPermission).not.toHaveBeenCalled();
  });

  it("未許可なら許可を求め、許可されたら出す", async () => {
    plugin.isPermissionGranted.mockResolvedValue(false);
    plugin.requestPermission.mockResolvedValue("granted");
    await expect(notifyMatch("t", "b")).resolves.toBe(true);
    expect(plugin.sendNotification).toHaveBeenCalled();
  });

  it("許可されなければ出さない", async () => {
    plugin.isPermissionGranted.mockResolvedValue(false);
    plugin.requestPermission.mockResolvedValue("denied");
    await expect(notifyMatch("t", "b")).resolves.toBe(false);
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });
});

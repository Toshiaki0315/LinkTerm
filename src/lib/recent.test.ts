import { describe, expect, it } from "vitest";
import { connectionSchema, type ConnectionValues } from "./connection-schema";
import {
  MAX_RECENT,
  connectionKey,
  parseRecent,
  recentLabel,
  recordRecent,
  toStoredRecent,
} from "./recent";

const hostOf = (v: ConnectionValues) => ("host" in v ? v.host : "");

const ssh = (host: string, extra: Record<string, unknown> = {}) =>
  connectionSchema.parse({
    type: "ssh",
    host,
    port: 22,
    username: "alice",
    authKind: "agent",
    ...extra,
  });
const telnet = (host: string, port = 23) =>
  connectionSchema.parse({ type: "telnet", host, port });
const serial = (serialPort: string, baudRate = 115200) =>
  connectionSchema.parse({ type: "serial", serialPort, baudRate });

describe("connectionKey", () => {
  it("同じ接続先は同じキー、違う接続先は違うキー", () => {
    expect(connectionKey(ssh("a"))).toBe(connectionKey(ssh("a")));
    expect(connectionKey(ssh("a"))).not.toBe(connectionKey(ssh("b")));
    expect(connectionKey(ssh("a"))).not.toBe(
      connectionKey(ssh("a", { username: "bob" })),
    );
    expect(connectionKey(ssh("a"))).not.toBe(
      connectionKey(ssh("a", { port: 2222 })),
    );
    expect(connectionKey(telnet("a"))).not.toBe(connectionKey(ssh("a")));
    expect(connectionKey(serial("/dev/a", 9600))).not.toBe(
      connectionKey(serial("/dev/a", 115200)),
    );
  });

  it("色・パスワード・文字コードの違いでは別の接続先にならない", () => {
    expect(connectionKey(ssh("a", { tabColor: "red" }))).toBe(
      connectionKey(ssh("a")),
    );
    expect(
      connectionKey(ssh("a", { authKind: "password", password: "x" })),
    ).toBe(connectionKey(ssh("a", { authKind: "password", password: "y" })));
  });
});

describe("recordRecent", () => {
  it("新しいものを先頭に置く", () => {
    let list = recordRecent([], ssh("a"), 1);
    list = recordRecent(list, ssh("b"), 2);
    expect(list.map((r) => hostOf(r.values))).toEqual(["b", "a"]);
    expect(list[0].usedAt).toBe(2);
  });

  it("同じ接続先を使い直すと先頭へ移り、重複しない。内容は最新で置き換える", () => {
    let list = recordRecent([], ssh("a"), 1);
    list = recordRecent(list, ssh("b"), 2);
    list = recordRecent(list, ssh("a", { tabColor: "red" }), 3);
    expect(list.map((r) => hostOf(r.values))).toEqual(["a", "b"]);
    expect(list[0].values.tabColor).toBe("red");
    expect(list[0].usedAt).toBe(3);
  });

  it("パスワード・パスフレーズは保存しない", () => {
    const list = recordRecent(
      [],
      ssh("a", { authKind: "password", password: "hunter2" }),
      1,
    );
    expect(JSON.stringify(list)).not.toContain("hunter2");
    expect(toStoredRecent(list)[0].values).not.toHaveProperty("password");
  });

  it("ローカルシェルは履歴に入れない", () => {
    const local: ConnectionValues = connectionSchema.parse({ type: "local" });
    expect(recordRecent([], local, 1)).toEqual([]);
  });

  it(`${MAX_RECENT} 件を超えたら古いものから捨てる`, () => {
    let list: ReturnType<typeof recordRecent> = [];
    for (let i = 0; i < MAX_RECENT + 3; i++) {
      list = recordRecent(list, ssh(`h${i}`), i);
    }
    expect(list).toHaveLength(MAX_RECENT);
    expect(hostOf(list[0].values)).toBe(`h${MAX_RECENT + 2}`);
    expect(list.some((r) => hostOf(r.values) === "h0")).toBe(false);
  });
});

describe("parseRecent", () => {
  it("読めない項目は捨て、読める項目は検証済みの値にして返す", () => {
    const list = parseRecent([
      {
        values: {
          type: "ssh",
          host: "a",
          port: 22,
          username: "u",
          authKind: "agent",
        },
        usedAt: 5,
      },
      { values: { type: "ssh" }, usedAt: 4 },
      { values: "oops", usedAt: 3 },
      null,
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].values.type).toBe("ssh");
    expect(list[0].usedAt).toBe(5);
  });
});

describe("recentLabel", () => {
  it("接続種別ごとの表示名。SSH は標準以外のポートも示す", () => {
    expect(recentLabel(ssh("a"))).toBe("alice@a");
    expect(recentLabel(ssh("a", { port: 2222 }))).toBe("alice@a:2222");
    expect(recentLabel(telnet("r", 2323))).toBe("telnet://r:2323");
    expect(recentLabel(serial("/dev/cu.usbserial", 9600))).toBe(
      "cu.usbserial @9600",
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  connectionSchema,
  connectionTitle,
  defaultConnectionValues,
  toStartRequest,
} from "./connection-schema";

const SIZE = { cols: 80, rows: 24 };

const ssh = (over: Record<string, unknown> = {}) => ({
  ...defaultConnectionValues,
  type: "ssh",
  host: "example.com",
  username: "alice",
  authKind: "password",
  password: "pw",
  ...over,
});

describe("connectionSchema", () => {
  it("local は追加項目なしで有効", () => {
    expect(connectionSchema.safeParse({ type: "local" }).success).toBe(true);
  });

  it("ssh: ホストとユーザー名は必須", () => {
    const r = connectionSchema.safeParse(ssh({ host: "", username: "" }));
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path[0]);
      expect(paths).toContain("host");
      expect(paths).toContain("username");
    }
  });

  it.each([0, 65536, 1.5, -1])("ポート %s は不正", (port) => {
    expect(connectionSchema.safeParse(ssh({ port })).success).toBe(false);
  });

  it("ssh: パスワード認証ではパスワードが必須", () => {
    const r = connectionSchema.safeParse(ssh({ password: "" }));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path[0]).toBe("password");
  });

  it("ssh: 鍵認証では鍵パスが必須、agent/keychain は不要", () => {
    expect(
      connectionSchema.safeParse(ssh({ authKind: "keyFile", keyPath: "" }))
        .success,
    ).toBe(false);
    expect(
      connectionSchema.safeParse(
        ssh({ authKind: "keyFile", keyPath: "/home/a/.ssh/id" }),
      ).success,
    ).toBe(true);
    expect(
      connectionSchema.safeParse(ssh({ authKind: "agent", password: "" }))
        .success,
    ).toBe(true);
    expect(
      connectionSchema.safeParse(ssh({ authKind: "keychain", password: "" }))
        .success,
    ).toBe(true);
  });

  it("telnet: ホスト必須", () => {
    expect(
      connectionSchema.safeParse({
        ...defaultConnectionValues,
        type: "telnet",
        host: "",
      }).success,
    ).toBe(false);
  });

  it("serial: ポートとボーレートが必須", () => {
    const base = { ...defaultConnectionValues, type: "serial" };
    expect(
      connectionSchema.safeParse({ ...base, serialPort: "", baudRate: 115200 })
        .success,
    ).toBe(false);
    expect(
      connectionSchema.safeParse({ ...base, serialPort: "/dev/x", baudRate: 0 })
        .success,
    ).toBe(false);
    expect(
      connectionSchema.safeParse({
        ...base,
        serialPort: "/dev/x",
        baudRate: 9600,
      }).success,
    ).toBe(true);
  });

  it("エンコーディングは既定でUTF-8、未対応の値は拒否", () => {
    expect(connectionSchema.parse({ type: "local" })).toEqual({
      type: "local",
      encoding: "UTF-8",
    });
    expect(
      connectionSchema.safeParse({ type: "local", encoding: "EBCDIC" }).success,
    ).toBe(false);
    expect(
      connectionSchema.safeParse({ type: "local", encoding: "EUC-JP" }).success,
    ).toBe(true);
  });

  it("未知の type は拒否", () => {
    expect(connectionSchema.safeParse({ type: "ftp" }).success).toBe(false);
  });
});

describe("toStartRequest", () => {
  it("local", () => {
    expect(
      toStartRequest(connectionSchema.parse({ type: "local" }), SIZE),
    ).toEqual({
      type: "local",
      encoding: "UTF-8",
      ...SIZE,
    });
  });

  it("ssh パスワード", () => {
    const v = connectionSchema.parse(ssh({ remember: true }));
    expect(toStartRequest(v, SIZE)).toEqual({
      type: "ssh",
      host: "example.com",
      port: 22,
      username: "alice",
      encoding: "UTF-8",
      auth: { kind: "password", password: "pw", remember: true },
      ...SIZE,
    });
  });

  it("ssh 鍵（パスフレーズ空は null）", () => {
    const v = connectionSchema.parse(
      ssh({ authKind: "keyFile", keyPath: "/k", passphrase: "" }),
    );
    expect(toStartRequest(v, SIZE)).toMatchObject({
      auth: { kind: "keyFile", path: "/k", passphrase: null },
    });
  });

  it("ssh agent / keychain", () => {
    expect(
      toStartRequest(connectionSchema.parse(ssh({ authKind: "agent" })), SIZE),
    ).toMatchObject({ auth: { kind: "agent" } });
    expect(
      toStartRequest(
        connectionSchema.parse(ssh({ authKind: "keychain" })),
        SIZE,
      ),
    ).toMatchObject({ auth: { kind: "keychain" } });
  });

  it("telnet は改行設定を含む", () => {
    const v = connectionSchema.parse({
      ...defaultConnectionValues,
      type: "telnet",
      host: "h",
      port: 23,
      txNewline: "CrLf",
      rxNewline: "LfToCrLf",
    });
    expect(toStartRequest(v, SIZE)).toEqual({
      type: "telnet",
      host: "h",
      port: 23,
      txNewline: "CrLf",
      rxNewline: "LfToCrLf",
      encoding: "UTF-8",
      ...SIZE,
    });
  });

  it("serial はバックエンドの SerialConfig 形式に変換", () => {
    const v = connectionSchema.parse({
      ...defaultConnectionValues,
      type: "serial",
      serialPort: "/dev/cu.usbserial",
      baudRate: 9600,
      dataBits: "Seven",
      parity: "Even",
      stopBits: "Two",
      flowControl: "Hardware",
      encoding: "Shift_JIS",
    });
    expect(toStartRequest(v, SIZE)).toEqual({
      type: "serial",
      config: {
        port: "/dev/cu.usbserial",
        baud_rate: 9600,
        data_bits: "Seven",
        parity: "Even",
        stop_bits: "Two",
        flow_control: "Hardware",
      },
      encoding: "Shift_JIS",
    });
  });
});

describe("connectionTitle", () => {
  it("接続種別ごとのタブ名", () => {
    expect(connectionTitle(connectionSchema.parse({ type: "local" }))).toBe(
      "Local",
    );
    expect(connectionTitle(connectionSchema.parse(ssh()))).toBe(
      "alice@example.com",
    );
    expect(
      connectionTitle(
        connectionSchema.parse({
          ...defaultConnectionValues,
          type: "telnet",
          host: "h",
          port: 2323,
        }),
      ),
    ).toBe("telnet://h:2323");
    expect(
      connectionTitle(
        connectionSchema.parse({
          ...defaultConnectionValues,
          type: "serial",
          serialPort: "/dev/cu.usbserial",
          baudRate: 9600,
        }),
      ),
    ).toBe("cu.usbserial @9600");
  });

  it("Telnet / シリアルのローカルエコー設定（既定は自動）", () => {
    const telnet = connectionSchema.parse({
      ...defaultConnectionValues,
      type: "telnet",
      host: "h",
    });
    expect(telnet).toMatchObject({ localEcho: "auto" });
    const serial = connectionSchema.parse({
      ...defaultConnectionValues,
      type: "serial",
      serialPort: "/dev/cu.x",
      localEcho: "on",
    });
    expect(serial).toMatchObject({ localEcho: "on" });
    expect(
      connectionSchema.safeParse({
        ...defaultConnectionValues,
        type: "telnet",
        host: "h",
        localEcho: "maybe",
      }).success,
    ).toBe(false);
  });

  it("シリアルのポート名は /dev/ 以下のデバイスのパス", () => {
    const base = { ...defaultConnectionValues, type: "serial", baudRate: 9600 };
    for (const ok of [
      "/dev/cu.usbserial-1410",
      "/dev/tty.Bluetooth-Incoming-Port",
    ]) {
      expect(
        connectionSchema.safeParse({ ...base, serialPort: ok }).success,
      ).toBe(true);
    }
    for (const bad of [
      "COM3",
      "/etc/passwd",
      "/dev/",
      "/dev/../etc/passwd",
      "cu.usbserial",
    ]) {
      const r = connectionSchema.safeParse({ ...base, serialPort: bad });
      expect(r.success, bad).toBe(false);
    }
  });
});

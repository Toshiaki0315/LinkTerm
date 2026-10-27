import { describe, expect, it } from "vitest";
import {
  connectionSchema,
  connectionTitle,
  parseForwards,
  parseSocksPorts,
  parseSavedValues,
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

  it("ssh: ホストは必須。~/.ssh/config を使わないならユーザー名も必須", () => {
    const r = connectionSchema.safeParse(
      ssh({ host: "", username: "", useSshConfig: false }),
    );
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
      connectionSchema.safeParse(
        ssh({ authKind: "keyFile", keyPath: "", useSshConfig: false }),
      ).success,
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
      useSshConfig: true,
      jumpHosts: "",
      forwards: [],
      dynamicForwards: [],
      remoteForwards: [],
      termType: "xterm-256color",
      encoding: "UTF-8",
      auth: { kind: "password", password: "pw", remember: true },
      ...SIZE,
    });
  });

  it("端末の種類（TERM）を ssh / telnet の要求に含める。未指定は xterm-256color", () => {
    const sshV = connectionSchema.parse(ssh({ termType: "vt100" }));
    expect(toStartRequest(sshV, SIZE)).toMatchObject({ termType: "vt100" });
    const telnetV = connectionSchema.parse({
      type: "telnet",
      host: "h",
      port: 23,
      termType: "vt220",
    });
    expect(toStartRequest(telnetV, SIZE)).toMatchObject({ termType: "vt220" });
    expect(toStartRequest(connectionSchema.parse(ssh()), SIZE)).toMatchObject({
      termType: "xterm-256color",
    });
  });

  it("未対応の端末の種類は受け付けない", () => {
    expect(
      connectionSchema.safeParse(ssh({ termType: "foo bar" })).success,
    ).toBe(false);
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
      termType: "xterm-256color",
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
      txNewline: "CrLf",
      rxNewline: "LfToCrLf",
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
        tx_newline: "CrLf",
        rx_newline: "LfToCrLf",
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

describe("parseSavedValues（保存済みの設定の読み込み）", () => {
  it("秘密情報を含まない保存値を、そのまま接続設定として読む", () => {
    const telnet = parseSavedValues({
      type: "telnet",
      host: "h",
      port: 23,
      encoding: "Shift_JIS",
    });
    expect(telnet).toMatchObject({
      type: "telnet",
      host: "h",
      encoding: "Shift_JIS",
      localEcho: "auto",
    });
    expect(parseSavedValues({ type: "local" })).toMatchObject({
      type: "local",
      encoding: "UTF-8",
    });
    expect(
      parseSavedValues({
        type: "ssh",
        host: "h",
        port: 22,
        username: "u",
        authKind: "agent",
      }),
    ).toMatchObject({ type: "ssh", authKind: "agent" });
  });

  it("パスワード認証のSSHは、パスワードなしで読める（空文字になる）", () => {
    const v = parseSavedValues({
      type: "ssh",
      host: "h",
      port: 22,
      username: "u",
      authKind: "password",
    });
    expect(v).toMatchObject({
      type: "ssh",
      authKind: "password",
      password: "",
      passphrase: "",
    });
  });

  it("保存値に紛れた秘密情報は、読み込み時にも捨てる", () => {
    const v = parseSavedValues({
      type: "ssh",
      host: "h",
      port: 22,
      username: "u",
      authKind: "password",
      password: "leaked",
      passphrase: "leaked2",
    });
    expect(v).toMatchObject({ password: "", passphrase: "" });
  });

  it("不正な値（必須項目なし・不明な種別・オブジェクトでない）は null", () => {
    expect(
      parseSavedValues({
        type: "ssh",
        host: "",
        username: "u",
        authKind: "agent",
        port: 22,
      }),
    ).toBeNull();
    expect(parseSavedValues({ type: "ftp" })).toBeNull();
    expect(parseSavedValues("x")).toBeNull();
    expect(parseSavedValues(null)).toBeNull();
    expect(parseSavedValues([])).toBeNull();
  });

  describe("~/.ssh/config と踏み台", () => {
    it("既定では ~/.ssh/config を使い、ユーザー名・秘密鍵のパスは空でもよい（設定ファイルから補う）", () => {
      expect(defaultConnectionValues.useSshConfig).toBe(true);
      expect(connectionSchema.safeParse(ssh({ username: "" })).success).toBe(
        true,
      );
      expect(
        connectionSchema.safeParse(
          ssh({ authKind: "keyFile", keyPath: "", username: "" }),
        ).success,
      ).toBe(true);
    });

    it("~/.ssh/config を使わないなら、ユーザー名と秘密鍵のパスは必須", () => {
      const noUser = connectionSchema.safeParse(
        ssh({ username: "", useSshConfig: false }),
      );
      expect(noUser.success).toBe(false);
      const noKey = connectionSchema.safeParse(
        ssh({ authKind: "keyFile", keyPath: "", useSshConfig: false }),
      );
      expect(noKey.success).toBe(false);
      if (!noKey.success) expect(noKey.error.issues[0].path[0]).toBe("keyPath");
    });

    it("踏み台は [user@]host[:port] のカンマ区切り。空と none も可", () => {
      for (const ok of [
        "",
        "none",
        "bastion",
        "a@h1:22, h2",
        "u@[::1]:2200",
        "  gw  ",
      ]) {
        expect(
          connectionSchema.safeParse(ssh({ jumpHosts: ok })).success,
          ok,
        ).toBe(true);
      }
      for (const bad of [
        "a b",
        "h:99999",
        "h:abc",
        "@h",
        "a@",
        ",",
        "h1,,h2",
        "h:",
      ]) {
        const r = connectionSchema.safeParse(ssh({ jumpHosts: bad }));
        expect(r.success, bad).toBe(false);
        if (!r.success)
          expect(r.error.issues[0].message).toBe(
            "踏み台の指定が正しくありません",
          );
      }
    });

    it("接続要求に ~/.ssh/config の利用と踏み台（前後の空白は除く）を含める", () => {
      const v = connectionSchema.parse(
        ssh({ jumpHosts: "  user@bastion:22  " }),
      );
      expect(toStartRequest(v, SIZE)).toMatchObject({
        type: "ssh",
        useSshConfig: true,
        jumpHosts: "user@bastion:22",
      });
      const off = connectionSchema.parse(ssh({ useSshConfig: false }));
      expect(toStartRequest(off, SIZE)).toMatchObject({
        useSshConfig: false,
        jumpHosts: "",
        forwards: [],
      });
    });
  });
});

describe("parseForwards", () => {
  it("空欄は転送なし", () => {
    expect(parseForwards("")).toEqual([]);
    expect(parseForwards("  ")).toEqual([]);
  });

  it("ローカルポート:転送先ホスト:転送先ポートをカンマ区切りで読む", () => {
    expect(parseForwards("8080:db.internal:5432, 9000:localhost:90")).toEqual([
      { bindPort: 8080, destHost: "db.internal", destPort: 5432 },
      { bindPort: 9000, destHost: "localhost", destPort: 90 },
    ]);
  });

  it("不正な形式・範囲外のポートは null", () => {
    for (const bad of [
      "8080",
      "8080:host",
      "x:host:80",
      "0:host:80",
      "8080:host:70000",
      "8080::80",
      "8080:host:80,",
      "8080:ho st:80",
    ]) {
      expect(parseForwards(bad), bad).toBeNull();
    }
  });
});

describe("ssh ポートフォワード", () => {
  const base = {
    ...defaultConnectionValues,
    type: "ssh",
    host: "h",
    username: "u",
    keyPath: "",
    password: "pw",
  };

  it("リクエストに forwards として含める", () => {
    const v = connectionSchema.parse({
      ...base,
      forwards: "8080:db:5432",
    });
    const req = toStartRequest(v, SIZE);
    expect(req).toMatchObject({
      type: "ssh",
      forwards: [{ bindPort: 8080, destHost: "db", destPort: 5432 }],
    });
  });

  it("不正な指定は検証エラー", () => {
    const r = connectionSchema.safeParse({ ...base, forwards: "oops" });
    expect(r.success).toBe(false);
  });
});

describe("parseSocksPorts", () => {
  it("空欄は指定なし、カンマ区切りのポートを読む", () => {
    expect(parseSocksPorts("")).toEqual([]);
    expect(parseSocksPorts("1080, 1081")).toEqual([1080, 1081]);
  });

  it("不正なポートは null", () => {
    for (const bad of ["0", "x", "70000", "1080,", "1080:2"]) {
      expect(parseSocksPorts(bad), bad).toBeNull();
    }
  });

  it("ssh のリクエストに dynamicForwards として含める", () => {
    const v = connectionSchema.parse({
      ...defaultConnectionValues,
      type: "ssh",
      host: "h",
      username: "u",
      password: "pw",
      socksPorts: "1080",
    });
    expect(toStartRequest(v, SIZE)).toMatchObject({
      dynamicForwards: [1080],
    });
    expect(
      connectionSchema.safeParse({
        ...defaultConnectionValues,
        type: "ssh",
        host: "h",
        username: "u",
        password: "pw",
        socksPorts: "oops",
      }).success,
    ).toBe(false);
  });
});

describe("ssh リモートフォワード(-R)", () => {
  const base = {
    ...defaultConnectionValues,
    type: "ssh",
    host: "h",
    username: "u",
    password: "pw",
  };

  it("リクエストに remoteForwards として含める", () => {
    const v = connectionSchema.parse({
      ...base,
      remoteForwards: "9000:localhost:3000",
    });
    expect(toStartRequest(v, SIZE)).toMatchObject({
      remoteForwards: [
        { bindPort: 9000, destHost: "localhost", destPort: 3000 },
      ],
    });
  });

  it("不正な指定は検証エラー", () => {
    expect(
      connectionSchema.safeParse({ ...base, remoteForwards: "9000" }).success,
    ).toBe(false);
  });

  it("未指定なら空配列", () => {
    expect(toStartRequest(connectionSchema.parse(base), SIZE)).toMatchObject({
      remoteForwards: [],
    });
  });
});

describe("タブの色", () => {
  it("未指定・空・none は色なし", () => {
    for (const tabColor of [undefined, "", "none"]) {
      const v = connectionSchema.parse({ type: "local", tabColor });
      expect(v.tabColor).toBeUndefined();
    }
  });

  it("定義された色を受け付け、未知の色は拒否する", () => {
    expect(
      connectionSchema.parse({ type: "local", tabColor: "red" }).tabColor,
    ).toBe("red");
    expect(
      connectionSchema.safeParse({ type: "local", tabColor: "magenta" })
        .success,
    ).toBe(false);
  });

  it("保存済みの値（色なしの古いデータ）も読み込め、色は保たれる", () => {
    expect(parseSavedValues({ type: "local" })?.tabColor).toBeUndefined();
    expect(
      parseSavedValues({ type: "local", tabColor: "blue" })?.tabColor,
    ).toBe("blue");
  });
});

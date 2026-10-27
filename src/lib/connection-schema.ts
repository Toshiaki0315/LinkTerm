import { z } from "zod";
import { TAB_COLOR_IDS } from "./tab-colors";
import type { StartRequest } from "./terminal-api";

export interface TerminalSize {
  cols: number;
  rows: number;
}

export const ENCODINGS = [
  "UTF-8",
  "Shift_JIS",
  "EUC-JP",
  "GBK",
  "Big5",
  "EUC-KR",
  "windows-1252",
] as const;

/** 端末の種類（TERM）。Rust 側の許可リストと揃える。 */
export const TERM_TYPES = [
  "xterm-256color",
  "xterm",
  "vt100",
  "vt102",
  "vt220",
  "ansi",
  "linux",
] as const;

export const defaultConnectionValues = {
  termType: "xterm-256color",
  type: "local",
  encoding: "UTF-8",
  localEcho: "auto",
  host: "",
  port: 22,
  username: "",
  useSshConfig: true,
  jumpHosts: "",
  forwards: "",
  socksPorts: "",
  remoteForwards: "",
  authKind: "password",
  password: "",
  remember: false,
  keyPath: "",
  passphrase: "",
  txNewline: "Cr",
  rxNewline: "Raw",
  serialPort: "",
  baudRate: 115200,
  dataBits: "Eight",
  parity: "None",
  stopBits: "One",
  flowControl: "None",
} as const;

const port = z
  .number("ポート番号を入力してください")
  .int("ポート番号は整数で入力してください")
  .min(1, "ポート番号は1〜65535で入力してください")
  .max(65535, "ポート番号は1〜65535で入力してください");

const required = (label: string) =>
  z.string().trim().min(1, `${label}を入力してください`);

const encoding = z.enum(ENCODINGS).default("UTF-8");
/** タブの色（色分け用。接続には影響しない）。 */
const tabColor = z.preprocess(
  (v) => (v === "" || v === "none" ? undefined : v),
  z.enum(TAB_COLOR_IDS).optional(),
);
const localEcho = z.enum(["auto", "on", "off"]).default("auto");

const local = z.object({ type: z.literal("local"), encoding, tabColor });

/** `-L` 形式のポートフォワード1件。 */
export interface ForwardSpec {
  bindPort: number;
  destHost: string;
  destPort: number;
}

const toPort = (text: string): number | null => {
  if (!/^\d{1,5}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= 65535 ? n : null;
};

/**
 * ポートフォワードの指定（`ローカルポート:転送先ホスト:転送先ポート` のカンマ区切り）を読む。
 * 空欄は転送なし。形式が正しくなければ null。
 */
export function parseForwards(text: string): ForwardSpec[] | null {
  const spec = text.trim();
  if (spec === "") return [];
  const result: ForwardSpec[] = [];
  for (const raw of spec.split(",")) {
    const parts = raw.trim().split(":");
    if (parts.length !== 3) return null;
    const [bind, destHost, dest] = parts;
    const bindPort = toPort(bind);
    const destPort = toPort(dest);
    if (bindPort === null || destPort === null) return null;
    if (!/^[A-Za-z0-9._-]+$/.test(destHost)) return null;
    result.push({ bindPort, destHost, destPort });
  }
  return result;
}

/** SOCKS プロキシ（-D）の待ち受けポート（カンマ区切り）を読む。空欄は指定なし、不正なら null。 */
export function parseSocksPorts(text: string): number[] | null {
  const spec = text.trim();
  if (spec === "") return [];
  const ports = spec.split(",").map((p) => toPort(p.trim()));
  return ports.every((p) => p !== null) ? (ports as number[]) : null;
}

/** 踏み台の指定（`[user@]host[:port]` のカンマ区切り。空と `none` も可）。Rust 側の解析と同じ規則。 */
export function isValidJumpList(text: string): boolean {
  const spec = text.trim();
  if (spec === "" || spec.toLowerCase() === "none") return true;
  return spec.split(",").every((raw) => {
    const part = raw.trim();
    if (part === "" || /\s/.test(part)) return false;
    const at = part.indexOf("@");
    if (at === 0) return false;
    const rest = at < 0 ? part : part.slice(at + 1);
    let host: string;
    let port: string | undefined;
    if (rest.startsWith("[")) {
      const end = rest.indexOf("]");
      if (end < 0) return false;
      host = rest.slice(1, end);
      const after = rest.slice(end + 1);
      if (after !== "" && !after.startsWith(":")) return false;
      port = after === "" ? undefined : after.slice(1);
    } else {
      const colon = rest.indexOf(":");
      if (colon >= 0 && rest.indexOf(":", colon + 1) >= 0) return false;
      host = colon < 0 ? rest : rest.slice(0, colon);
      port = colon < 0 ? undefined : rest.slice(colon + 1);
    }
    if (host === "") return false;
    if (port === undefined) return true;
    return /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
  });
}

const termType = z.enum(TERM_TYPES).default("xterm-256color");

const ssh = z
  .object({
    type: z.literal("ssh"),
    encoding,
    termType,
    tabColor,
    host: required("ホスト"),
    port,
    // ~/.ssh/config を使うなら、空でもよい（設定ファイルの User を使う）。
    username: z.string().trim().default(""),
    useSshConfig: z.boolean().default(true),
    jumpHosts: z
      .string()
      .trim()
      .default("")
      .refine(isValidJumpList, "踏み台の指定が正しくありません"),
    forwards: z
      .string()
      .trim()
      .default("")
      .refine(
        (v) => parseForwards(v) !== null,
        "ポートフォワードは ローカルポート:転送先ホスト:転送先ポート の形式で指定してください",
      ),
    remoteForwards: z
      .string()
      .trim()
      .default("")
      .refine(
        (v) => parseForwards(v) !== null,
        "リモートフォワードは サーバー側ポート:転送先ホスト:転送先ポート の形式で指定してください",
      ),
    socksPorts: z
      .string()
      .trim()
      .default("")
      .refine(
        (v) => parseSocksPorts(v) !== null,
        "SOCKS プロキシのポートは 1〜65535 の数字をカンマ区切りで指定してください",
      ),
    authKind: z.enum(["password", "keychain", "keyFile", "agent"]),
    password: z.string().default(""),
    remember: z.boolean().default(false),
    keyPath: z.string().default(""),
    passphrase: z.string().default(""),
  })
  .superRefine((v, ctx) => {
    if (!v.useSshConfig && v.username === "") {
      ctx.addIssue({
        code: "custom",
        path: ["username"],
        message: "ユーザー名を入力してください",
      });
    }
    if (v.authKind === "password" && v.password === "") {
      ctx.addIssue({
        code: "custom",
        path: ["password"],
        message: "パスワードを入力してください",
      });
    }
    if (
      v.authKind === "keyFile" &&
      !v.useSshConfig &&
      v.keyPath.trim() === ""
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["keyPath"],
        message: "秘密鍵のパスを入力してください",
      });
    }
  });

const telnet = z.object({
  type: z.literal("telnet"),
  encoding,
  termType,
  tabColor,
  localEcho,
  host: required("ホスト"),
  port,
  txNewline: z.enum(["Cr", "Lf", "CrLf"]).default("Cr"),
  rxNewline: z.enum(["Raw", "LfToCrLf", "CrToCrLf"]).default("Raw"),
});

const serial = z.object({
  type: z.literal("serial"),
  encoding,
  tabColor,
  localEcho,
  serialPort: required("ポート").refine(
    (v) => v.startsWith("/dev/") && v.length > 5 && !v.includes(".."),
    "ポート名は /dev/ から始まるデバイスのパスで入力してください",
  ),
  baudRate: z
    .number("ボーレートを入力してください")
    .int("ボーレートは整数で入力してください")
    .min(1, "ボーレートは1以上で入力してください"),
  dataBits: z.enum(["Five", "Six", "Seven", "Eight"]).default("Eight"),
  parity: z.enum(["None", "Odd", "Even"]).default("None"),
  stopBits: z.enum(["One", "Two"]).default("One"),
  flowControl: z.enum(["None", "Software", "Hardware"]).default("None"),
  txNewline: z.enum(["Cr", "Lf", "CrLf"]).default("Cr"),
  rxNewline: z.enum(["Raw", "LfToCrLf", "CrToCrLf"]).default("Raw"),
});

export const connectionSchema = z.discriminatedUnion("type", [
  local,
  ssh,
  telnet,
  serial,
]);

export type ConnectionValues = z.infer<typeof connectionSchema>;

export function toStartRequest(
  v: ConnectionValues,
  size: TerminalSize,
): StartRequest {
  switch (v.type) {
    case "local":
      return { type: "local", encoding: v.encoding, ...size };
    case "ssh": {
      const base = {
        type: "ssh" as const,
        host: v.host,
        port: v.port,
        username: v.username,
        useSshConfig: v.useSshConfig,
        jumpHosts: v.jumpHosts,
        forwards: parseForwards(v.forwards ?? "") ?? [],
        remoteForwards: parseForwards(v.remoteForwards ?? "") ?? [],
        dynamicForwards: parseSocksPorts(v.socksPorts ?? "") ?? [],
        termType: v.termType,
        encoding: v.encoding,
        ...size,
      };
      switch (v.authKind) {
        case "password":
          return {
            ...base,
            auth: {
              kind: "password",
              password: v.password,
              remember: v.remember,
            },
          };
        case "keyFile":
          return {
            ...base,
            auth: {
              kind: "keyFile",
              path: v.keyPath,
              passphrase: v.passphrase === "" ? null : v.passphrase,
            },
          };
        case "keychain":
          return { ...base, auth: { kind: "keychain" } };
        case "agent":
          return { ...base, auth: { kind: "agent" } };
      }
      break;
    }
    case "telnet":
      return {
        type: "telnet",
        host: v.host,
        port: v.port,
        txNewline: v.txNewline,
        rxNewline: v.rxNewline,
        termType: v.termType,
        encoding: v.encoding,
        ...size,
      };
    case "serial":
      return {
        type: "serial",
        config: {
          port: v.serialPort,
          baud_rate: v.baudRate,
          data_bits: v.dataBits,
          parity: v.parity,
          stop_bits: v.stopBits,
          flow_control: v.flowControl,
          tx_newline: v.txNewline,
          rx_newline: v.rxNewline,
        },
        encoding: v.encoding,
      };
  }
}

export function connectionTitle(v: ConnectionValues): string {
  switch (v.type) {
    case "local":
      return "Local";
    case "ssh":
      return `${v.username}@${v.host}`;
    case "telnet":
      return `telnet://${v.host}:${v.port}`;
    case "serial":
      return `${v.serialPort.split("/").pop()} @${v.baudRate}`;
  }
}

/**
 * 保存済みの設定（プロファイル・前回のタブ構成）を接続設定として読む。
 *
 * 秘密情報は保存しないため、パスワード認証の SSH はパスワード欄が空のまま読めるようにする
 * （接続時に入力してもらう）。保存値に紛れたパスワード類は捨てる。不正な値は `null`。
 */
export function parseSavedValues(raw: unknown): ConnectionValues | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const {
    password: _password,
    passphrase: _passphrase,
    ...rest
  } = raw as Record<string, unknown>;
  // 検証を通すためだけの仮の値。読み込み後に空へ戻す。
  const candidate =
    rest.type === "ssh" && rest.authKind === "password"
      ? { ...rest, password: "placeholder" }
      : rest;
  const parsed = connectionSchema.safeParse(candidate);
  if (!parsed.success) return null;
  const values = parsed.data;
  return values.type === "ssh"
    ? { ...values, password: "", passphrase: "" }
    : values;
}

/** 保存・表示に使う値から、パスワード類を取り除く。 */
export function stripSecrets(
  values: ConnectionValues,
): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...values };
  delete rest.password;
  delete rest.passphrase;
  return rest;
}

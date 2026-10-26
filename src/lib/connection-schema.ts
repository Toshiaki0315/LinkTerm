import { z } from "zod";
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

export const defaultConnectionValues = {
  type: "local",
  encoding: "UTF-8",
  host: "",
  port: 22,
  username: "",
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

const local = z.object({ type: z.literal("local"), encoding });

const ssh = z
  .object({
    type: z.literal("ssh"),
    encoding,
    host: required("ホスト"),
    port,
    username: required("ユーザー名"),
    authKind: z.enum(["password", "keychain", "keyFile", "agent"]),
    password: z.string().default(""),
    remember: z.boolean().default(false),
    keyPath: z.string().default(""),
    passphrase: z.string().default(""),
  })
  .superRefine((v, ctx) => {
    if (v.authKind === "password" && v.password === "") {
      ctx.addIssue({
        code: "custom",
        path: ["password"],
        message: "パスワードを入力してください",
      });
    }
    if (v.authKind === "keyFile" && v.keyPath.trim() === "") {
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
  host: required("ホスト"),
  port,
  txNewline: z.enum(["Cr", "Lf", "CrLf"]),
  rxNewline: z.enum(["Raw", "LfToCrLf", "CrToCrLf"]),
});

const serial = z.object({
  type: z.literal("serial"),
  encoding,
  serialPort: required("ポート"),
  baudRate: z
    .number("ボーレートを入力してください")
    .int("ボーレートは整数で入力してください")
    .min(1, "ボーレートは1以上で入力してください"),
  dataBits: z.enum(["Five", "Six", "Seven", "Eight"]),
  parity: z.enum(["None", "Odd", "Even"]),
  stopBits: z.enum(["One", "Two"]),
  flowControl: z.enum(["None", "Software", "Hardware"]),
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

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Settings } from "./settings";

export type NewlineTx = "Cr" | "Lf" | "CrLf";
export type NewlineRx = "Raw" | "LfToCrLf" | "CrToCrLf";

export type SshAuthRequest =
  | { kind: "password"; password: string; remember: boolean }
  | { kind: "keychain" }
  | { kind: "keyFile"; path: string; passphrase: string | null }
  | { kind: "agent" };

export interface SerialConfig {
  port: string;
  baud_rate: number;
  data_bits: "Five" | "Six" | "Seven" | "Eight";
  parity: "None" | "Odd" | "Even";
  stop_bits: "One" | "Two";
  flow_control: "None" | "Software" | "Hardware";
  tx_newline?: NewlineTx;
  rx_newline?: NewlineRx;
}

export type StartRequest =
  | { type: "local"; cols: number; rows: number; encoding?: string }
  | {
      type: "ssh";
      host: string;
      port: number;
      username: string;
      auth: SshAuthRequest;
      cols: number;
      rows: number;
      encoding?: string;
      /** ~/.ssh/config を使う（別名・User・IdentityFile・ProxyJump の解決）。 */
      useSshConfig?: boolean;
      /** 踏み台（`[user@]host[:port],...`）。空なら ~/.ssh/config の設定。 */
      jumpHosts?: string;
      /** SOCKS5 プロキシ（-D）の待ち受けポート。127.0.0.1 のみ。 */
      dynamicForwards?: number[];
      /** リモートフォワード（-R）。サーバー側のループバックで待ち受ける。 */
      remoteForwards?: Array<{
        bindPort: number;
        destHost: string;
        destPort: number;
      }>;
      /** ローカルポートフォワード（-L）。127.0.0.1 でのみ待ち受ける。 */
      forwards?: Array<{
        bindPort: number;
        destHost: string;
        destPort: number;
      }>;
    }
  | {
      type: "telnet";
      host: string;
      port: number;
      cols: number;
      rows: number;
      encoding?: string;
      txNewline?: NewlineTx;
      rxNewline?: NewlineRx;
    }
  | { type: "serial"; config: SerialConfig; encoding?: string };

export interface LogConfig {
  path: string;
  mode: "Raw" | "Text";
  timestamps: boolean;
  append: boolean;
}

export interface SavedProfile {
  id: string;
  name: string;
  /** 接続フォームの値（パスワード類は含まれない）。 */
  values: Record<string, unknown>;
}

export interface FontFamily {
  name: string;
  /** 等幅フォントか（ターミナルに向いているか）。 */
  monospace: boolean;
}

/** 終了時のタブ構成（接続先のみ。パスワード類は含まれない）。 */
export interface SessionState {
  tabs: Array<{ title: string; values: Record<string, unknown> }>;
  active: number | null;
}

export interface HostKeyRequest {
  requestId: string;
  host: string;
  port: number;
  fingerprint: string;
}

interface DataPayload {
  id: string;
  data: string;
}

interface ClosedPayload {
  id: string;
  reason: string | null;
}

export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function startSession(req: StartRequest): Promise<string> {
  switch (req.type) {
    case "local": {
      const { type: _type, ...rest } = req;
      return invoke<string>("start_local_shell", { req: rest });
    }
    case "ssh": {
      const { type: _type, ...rest } = req;
      return invoke<string>("start_ssh", { req: rest });
    }
    case "telnet": {
      const { type: _type, ...rest } = req;
      return invoke<string>("start_telnet", { req: rest });
    }
    case "serial":
      return invoke<string>("start_serial", {
        config: req.config,
        encoding: req.encoding,
      });
  }
}

export const writeToSession = (id: string, data: string) =>
  invoke<void>("terminal_write", { id, data });

export const resizeSession = (id: string, cols: number, rows: number) =>
  invoke<void>("terminal_resize", { id, cols, rows });

export const closeSession = (id: string) =>
  invoke<void>("terminal_close", { id });

export const startSessionLog = (id: string, config: LogConfig) =>
  invoke<void>("start_session_log", { id, config });

export const stopSessionLog = (id: string) =>
  invoke<void>("stop_session_log", { id });

export const defaultLogPath = (title: string) =>
  invoke<string>("default_log_path", { title });

export const listSerialPorts = () => invoke<string[]>("list_serial_ports");

export const respondHostKey = (requestId: string, approved: boolean) =>
  invoke<void>("respond_host_key", { requestId, approved });

export const listFonts = () => invoke<FontFamily[]>("list_fonts");

export const getSessionState = () => invoke<SessionState>("get_session_state");

export const saveSessionState = (session: SessionState) =>
  invoke<void>("save_session_state", { session });

/** ~/.ssh/config の Host の別名（接続ダイアログのホスト名の候補）。 */
export const listSshHosts = () => invoke<string[]>("list_ssh_hosts");

export const getSettings = () => invoke<Settings>("get_settings");

export const saveSettings = (settings: Settings) =>
  invoke<Settings>("save_settings", { settings });

/** メニューバーの「設定…」（⌘,）が選ばれた。 */
export const onOpenSettings = (cb: () => void): Promise<UnlistenFn> =>
  listen<null>("menu-open-settings", () => cb());

/** 最近使った接続先（新しい順）。 */
export const getRecentConnections = () =>
  invoke<Array<{ values: Record<string, unknown>; usedAt: number }>>(
    "get_recent_connections",
  );

/** 最近使った接続先を保存する（パスワード類は渡さない）。 */
export const saveRecentConnections = (
  entries: Array<{ values: Record<string, unknown>; usedAt: number }>,
) => invoke<void>("save_recent_connections", { entries });

export const listProfiles = () => invoke<SavedProfile[]>("list_profiles");

export const saveProfile = (profile: {
  id?: string;
  name: string;
  values: Record<string, unknown>;
}) =>
  invoke<SavedProfile>("save_profile", {
    id: profile.id ?? null,
    name: profile.name,
    values: profile.values,
  });

export const deleteProfile = (id: string) =>
  invoke<boolean>("delete_profile", { id });

export const pendingHostKeyRequests = () =>
  invoke<HostKeyRequest[]>("pending_host_key_requests");

export const onTerminalData = (
  cb: (id: string, data: Uint8Array) => void,
): Promise<UnlistenFn> =>
  listen<DataPayload>("terminal-data", (e) =>
    cb(e.payload.id, decodeBase64(e.payload.data)),
  );

export const onTerminalClosed = (
  cb: (id: string, reason: string | null) => void,
): Promise<UnlistenFn> =>
  listen<ClosedPayload>("terminal-closed", (e) =>
    cb(e.payload.id, e.payload.reason),
  );

export const onHostKeyRequest = (
  cb: (req: HostKeyRequest) => void,
): Promise<UnlistenFn> =>
  listen<HostKeyRequest>("ssh-host-key-request", (e) => cb(e.payload));

export const onLogError = (
  cb: (id: string, message: string) => void,
): Promise<UnlistenFn> =>
  listen<{ id: string; message: string }>("terminal-log-error", (e) =>
    cb(e.payload.id, e.payload.message),
  );

/** 接続先のエコー状態（Telnet の ECHO 交渉など）が変わった。 */
export const onTerminalEcho = (
  cb: (id: string, remoteEcho: boolean) => void,
): Promise<UnlistenFn> =>
  listen<{ id: string; remoteEcho: boolean }>("terminal-echo", (e) =>
    cb(e.payload.id, e.payload.remoteEcho),
  );

export type ControlSignal = "dtr" | "rts";
export type DisplayMode = "text" | "hex";

/** シリアルの制御信号（DTR/RTS）を設定する。 */
export const setControlSignal = (
  id: string,
  signal: ControlSignal,
  on: boolean,
) => invoke<void>("serial_set_control", { id, signal, on });

/** シリアルにブレーク信号を送る。 */
export const sendBreak = (id: string) =>
  invoke<void>("serial_send_break", { id });

/** 受信データの表示方法（テキスト／16進ダンプ）。 */
export const setDisplayMode = (id: string, mode: DisplayMode) =>
  invoke<void>("set_display_mode", { id, mode });

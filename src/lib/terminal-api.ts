import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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

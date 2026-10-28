import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { DEFAULT_SETTINGS } from "../src/lib/settings";

type Args = Record<string, unknown>;

/** 試験から操作・確認するための口（`window.__e2e`）。 */
interface E2E {
  calls: Array<{ cmd: string; args: Args }>;
  settings: Record<string, unknown>;
  snippets: unknown[];
  highlights: unknown[];
  keybindings: unknown[];
  profiles: Array<Record<string, unknown>>;
  recent: unknown[];
  session: unknown;
  clipboard: string;
  /** 指定したコマンドの戻り値を差し替える。 */
  overrides: Record<string, (args: Args) => unknown>;
  /** 端末にデータを届ける（バックエンドからの出力）。 */
  output(id: string, text: string | Uint8Array): Promise<void>;
  /** バックエンドのイベント（メニューの選択など）を送る。 */
  emit(event: string, payload?: unknown): Promise<void>;
  sessions: string[];
  /** 端末へ届いた入力（`terminal_write`）。 */
  written: Array<{ id: string; data: string }>;
  /** 偽のリモートのフォルダー（パス → 中身）。SFTP の画面試験用。 */
  remote: Record<string, Array<{ name: string; isDir: boolean; size: number }>>;
  /** 出した通知（Tauri の通知プラグインは `window.Notification` を置き換える）。 */
  notifications: Array<{ title: string; options: unknown }>;
  /** ファイル選択ダイアログが返すパス。 */
  pickedFiles: string[];
  /** 保存ダイアログが返すパス（null ならキャンセル）。 */
  savePath: string | null;
  /** `sftp_upload` が「既に存在する」を返す名前。 */
  existing: string[];
  /** 偽のシェルが入力をそのまま返す（ローカルエコー相当）か。 */
  echo: boolean;
}

declare global {
  interface Window {
    __e2e: E2E;
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const e2e: E2E = {
  calls: [],
  settings: { ...DEFAULT_SETTINGS },
  snippets: [],
  highlights: [],
  keybindings: [],
  profiles: [],
  recent: [],
  session: { tabs: [], active: null },
  clipboard: "",
  overrides: {},
  sessions: [],
  remote: {
    "/home/alice": [
      { name: "docs", isDir: true, size: 0 },
      { name: "a.txt", isDir: false, size: 1536 },
    ],
    "/home/alice/docs": [{ name: "b.md", isDir: false, size: 20 }],
    "/home": [{ name: "alice", isDir: true, size: 0 }],
  },
  notifications: [],
  pickedFiles: ["/Users/me/up.txt"],
  savePath: "/Users/me/screen.txt",
  existing: [],
  written: [],
  echo: true,
  async output(id, text) {
    const bytes =
      typeof text === "string" ? new TextEncoder().encode(text) : text;
    await emit("terminal-data", { id, data: toBase64(bytes) });
  },
  async emit(event, payload) {
    await emit(event, payload ?? null);
  },
};
window.__e2e = e2e;

// 通知プラグインが本物の環境で行う置き換えを真似る（出した通知を記録する）。
class FakeNotification {
  static permission = "granted";
  static async requestPermission() {
    return "granted";
  }
  constructor(title: string, options?: unknown) {
    e2e.notifications.push({ title, options });
  }
}
(window as unknown as { Notification: unknown }).Notification =
  FakeNotification;

// 再読み込み（アプリの再起動に当たる）をまたいで、保存した内容を残す。
const STORE_KEY = "linkterm-e2e-store";
const PERSISTED = [
  "settings",
  "snippets",
  "highlights",
  "keybindings",
  "profiles",
  "recent",
  "session",
] as const;

function persist(): void {
  const data: Record<string, unknown> = {};
  for (const k of PERSISTED) data[k] = e2e[k];
  sessionStorage.setItem(STORE_KEY, JSON.stringify(data));
}

const restored = sessionStorage.getItem(STORE_KEY);
if (restored) Object.assign(e2e, JSON.parse(restored));
// 試験が最初の状態を渡す口（初回だけ使う）。
const init = (window as unknown as { __e2eInit?: Partial<E2E> }).__e2eInit;
if (init && !restored) {
  Object.assign(e2e, init);
  e2e.settings = { ...DEFAULT_SETTINGS, ...(init.settings ?? {}) };
}

let counter = 0;

function startShell(): string {
  const id = `s${++counter}`;
  e2e.sessions.push(id);
  // 起動直後にプロンプトを出す。
  setTimeout(() => void e2e.output(id, "$ "), 50);
  return id;
}

function handle(cmd: string, args: Args): unknown {
  e2e.calls.push({ cmd, args });
  queueMicrotask(persist);
  const override = e2e.overrides[cmd];
  if (override) return override(args);
  switch (cmd) {
    case "get_settings":
      return e2e.settings;
    case "save_settings":
      e2e.settings = args.settings as Record<string, unknown>;
      return e2e.settings;
    case "get_session_state":
      return e2e.session;
    case "save_session_state":
      e2e.session = args.session;
      return null;
    case "get_snippets":
      return e2e.snippets;
    case "save_snippets":
      e2e.snippets = args.snippets as unknown[];
      return e2e.snippets;
    case "get_highlight_rules":
      return e2e.highlights;
    case "save_highlight_rules":
      e2e.highlights = args.rules as unknown[];
      return e2e.highlights;
    case "get_keybindings":
      return e2e.keybindings;
    case "save_keybindings":
      e2e.keybindings = args.bindings as unknown[];
      return e2e.keybindings;
    case "get_recent_connections":
      return e2e.recent;
    case "save_recent_connections":
      e2e.recent = args.entries as unknown[];
      return null;
    case "list_profiles":
      return e2e.profiles;
    case "save_profile": {
      const existing = e2e.profiles.find((p) => p.id === args.id);
      const saved = {
        id: (args.id as string | null) ?? `p${e2e.profiles.length + 1}`,
        name: args.name,
        values: args.values,
        folder: args.folder ?? existing?.folder ?? undefined,
        tags: args.tags ?? existing?.tags ?? undefined,
      };
      e2e.profiles = [...e2e.profiles.filter((p) => p.id !== saved.id), saved];
      return saved;
    }
    case "update_profile": {
      const found = e2e.profiles.find((p) => p.id === args.id);
      if (!found) return null;
      found.name = args.name;
      found.folder = args.folder ?? undefined;
      found.tags = args.tags;
      return found;
    }
    case "delete_profile":
      e2e.profiles = e2e.profiles.filter((p) => p.id !== args.id);
      return true;
    case "list_fonts":
      return [{ name: "Menlo", monospace: true }];
    case "list_ssh_hosts":
      return ["myalias"];
    case "list_serial_ports":
      return [];
    case "pending_host_key_requests":
      return [];
    case "start_local_shell":
    case "start_ssh":
    case "start_telnet":
    case "start_serial":
      return startShell();
    case "terminal_write": {
      const id = String(args.id);
      const data = String(args.data);
      e2e.written.push({ id, data });
      if (e2e.echo) void e2e.output(id, data.replace(/\r/g, "\r\n"));
      return null;
    }
    case "terminal_resize":
    case "terminal_close":
    case "set_display_mode":
    case "stop_session_log":
    case "start_session_log":
      return null;
    case "default_log_path":
      return "/tmp/linkterm.log";
    case "save_text_file":
      return null;
    case "sftp_list": {
      const path = (args.path as string | null) ?? "/home/alice";
      const entries = e2e.remote[path];
      if (!entries) throw `${path} の一覧に失敗しました`;
      return {
        path,
        entries: entries.map((e) => ({
          ...e,
          isSymlink: false,
          modified: 1_700_000_000,
          permissions: 0o644,
        })),
      };
    }
    case "sftp_mkdir": {
      const dir = String(args.dir);
      const name = String(args.name);
      e2e.remote[dir] = [
        ...(e2e.remote[dir] ?? []),
        { name, isDir: true, size: 0 },
      ];
      e2e.remote[`${dir}/${name}`] = [];
      return `${dir}/${name}`;
    }
    case "sftp_remove": {
      const path = String(args.path);
      const dir = path.slice(0, path.lastIndexOf("/")) || "/";
      const name = path.slice(path.lastIndexOf("/") + 1);
      e2e.remote[dir] = (e2e.remote[dir] ?? []).filter((e) => e.name !== name);
      return null;
    }
    case "sftp_download": {
      const remotePath = String(args.remotePath);
      const name = remotePath.slice(remotePath.lastIndexOf("/") + 1);
      return {
        exists: false,
        path: `/Users/me/Downloads/${name}`,
        isDir: Array.isArray(e2e.remote[remotePath]),
        files: 3,
        skipped: 0,
      };
    }
    case "sftp_upload": {
      const req = args.req as { localPath: string; overwrite: boolean };
      const name = req.localPath.slice(req.localPath.lastIndexOf("/") + 1);
      if (e2e.existing.includes(name) && !req.overwrite) {
        return { exists: true, path: name, isDir: false, files: 0, skipped: 0 };
      }
      return { exists: false, path: name, isDir: false, files: 1, skipped: 0 };
    }
    case "sftp_cancel":
      return true;
    // プラグイン
    case "plugin:dialog|open":
      return e2e.pickedFiles;
    case "plugin:dialog|save":
      return e2e.savePath;
    case "plugin:clipboard-manager|write_text":
      e2e.clipboard = String(args.text ?? "");
      return null;
    case "plugin:clipboard-manager|read_text":
      return e2e.clipboard;
    case "plugin:notification|is_permission_granted":
      return true;
    case "plugin:notification|request_permission":
      return "granted";
    default:
      return null;
  }
}

mockWindows("main");
mockIPC((cmd, payload) => handle(cmd, (payload ?? {}) as Args), {
  shouldMockEvents: true,
});

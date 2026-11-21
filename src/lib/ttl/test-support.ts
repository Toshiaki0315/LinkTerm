import { parseProgram } from "./parser";
import { TtlRunner, type RunResult, type TtlHost } from "./runner";

/** マクロの試験で使う、偽の接続（送ったものや、ダイアログの答えを記録・用意する）。 */
export interface Fake {
  host: TtlHost;
  sent: string[];
  displayed: string[];
  messages: Array<{ message: string; title: string }>;
  yesno: boolean[];
  inputs: Array<string | null>;
  passwords: Array<string | null>;
  inputPrompts: Array<{ message: string; title: string; def: string }>;
  lists: Array<{
    message: string;
    title: string;
    items: string[];
    selected: number;
  }>;
  picks: Array<number | null>;
  breaks: number;
  disconnected: number;
  connected: boolean;
  echo: boolean[];
  signals: Array<{ signal: "dtr" | "rts"; on: boolean }>;
  keyboard: boolean[];
  cleared: number[];
  title: string;
  beeps: number[];
  statuses: Array<{ message: string; title: string }>;
  statusClosed: number;
  broadcasts: string[];
  host_name: string;
  uptime: number;
}

export function fake(over: Partial<TtlHost> = {}): Fake {
  const f: Fake = {
    sent: [],
    displayed: [],
    messages: [],
    yesno: [],
    inputs: [],
    passwords: [],
    inputPrompts: [],
    lists: [],
    picks: [],
    breaks: 0,
    disconnected: 0,
    connected: true,
    echo: [],
    signals: [],
    keyboard: [],
    cleared: [],
    title: "tab title",
    beeps: [],
    statuses: [],
    statusClosed: 0,
    broadcasts: [],
    host_name: "example.com",
    uptime: 12345,
    host: undefined as unknown as TtlHost,
  };
  f.host = {
    send: (d) => void f.sent.push(d),
    sendBreak: async () => void (f.breaks += 1),
    display: (t) => void f.displayed.push(t),
    messagebox: async (message, title) =>
      void f.messages.push({ message, title }),
    yesnobox: async () => f.yesno.shift() ?? false,
    inputbox: async (message, title, def) => {
      f.inputPrompts.push({ message, title, def });
      return f.inputs.shift() ?? null;
    },
    passwordbox: async () => f.passwords.shift() ?? null,
    listbox: async (message, title, items, selected) => {
      f.lists.push({ message, title, items, selected });
      return f.picks.shift() ?? null;
    },
    disconnect: () => void (f.disconnected += 1),
    isConnected: () => f.connected,
    now: () => new Date(2024, 0, 2, 3, 4, 5),
    random: (max) => Math.min(3, max - 1),
    setEcho: (on) => void f.echo.push(on),
    setSignal: async (signal, on) => void f.signals.push({ signal, on }),
    setKeyboardEnabled: (on) => void f.keyboard.push(on),
    clearScreen: (kind) => void f.cleared.push(kind),
    setTitle: (t) => void (f.title = t),
    getTitle: () => f.title,
    beep: (kind) => void f.beeps.push(kind),
    showStatus: (message, title) => void f.statuses.push({ message, title }),
    closeStatus: () => void (f.statusClosed += 1),
    hostName: () => f.host_name,
    uptimeMs: () => f.uptime,
    broadcast: (data) => void f.broadcasts.push(data),
    ...over,
  };
  return f;
}

export function make(src: string, f = fake()) {
  const parsed = parseProgram(src);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const runner = new TtlRunner(parsed.program, f.host);
  return { runner, f };
}

export async function run(
  src: string,
  f = fake(),
): Promise<{ result: RunResult; f: Fake }> {
  const { runner } = make(src, f);
  const result = await runner.run();
  return { result, f };
}

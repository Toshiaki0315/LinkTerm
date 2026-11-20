import { describe, expect, it, vi } from "vitest";
import { buildPaneMenuItems, type PaneMenuState } from "./pane-menu-items";

const base = (over: Partial<PaneMenuState> = {}): PaneMenuState => ({
  type: "local",
  connected: true,
  hasSession: true,
  showTimestamps: false,
  onToggleTimestamps: vi.fn(),
  onSearch: vi.fn(),
  onSftp: vi.fn(),
  logging: false,
  onLogStart: vi.fn(),
  onLogStop: vi.fn(),
  echo: { mode: "auto", effective: false, onChange: vi.fn() },
  serial: {
    signals: { dtr: true, rts: true },
    hex: false,
    breaking: false,
    onToggleSignal: vi.fn(),
    onBreak: vi.fn(),
    onToggleHex: vi.fn(),
  },
  ...over,
});

const labels = (s: PaneMenuState) => buildPaneMenuItems(s).map((i) => i.label);
const find = (s: PaneMenuState, label: string) =>
  buildPaneMenuItems(s).find((i) => i.label === label)!;

describe("buildPaneMenuItems", () => {
  it("ローカルシェル: 時刻・検索・ログだけ（SFTP・エコー・シリアル用は出さない）", () => {
    expect(labels(base())).toEqual([
      "タイムスタンプ表示",
      "検索…（⌘F）",
      "ログ記録を開始…",
    ]);
  });

  it("SSH: SFTP が加わる。接続済みでなければ押せない", () => {
    const s = base({ type: "ssh" });
    expect(labels(s)).toContain("ファイル転送（SFTP）…");
    expect(find(s, "ファイル転送（SFTP）…").disabled).toBe(false);
    expect(
      find(base({ type: "ssh", connected: false }), "ファイル転送（SFTP）…")
        .disabled,
    ).toBe(true);
  });

  it("Telnet: ローカルエコーの 自動 / オン / オフ（選択中に印）", () => {
    const s = base({ type: "telnet" });
    expect(labels(s)).toEqual([
      "タイムスタンプ表示",
      "検索…（⌘F）",
      "ログ記録を開始…",
      "ローカルエコー: 自動（現在 オフ）",
      "ローカルエコー: オン",
      "ローカルエコー: オフ",
    ]);
    const items = buildPaneMenuItems(s);
    expect(items.slice(-3).map((i) => i.checked)).toEqual([true, false, false]);
    const on = buildPaneMenuItems(
      base({
        type: "telnet",
        echo: { mode: "on", effective: true, onChange: vi.fn() },
      }),
    ).slice(-3);
    expect(on.map((i) => i.checked)).toEqual([false, true, false]);
    expect(on[0].label).toBe("ローカルエコー: 自動（現在 オン）");
  });

  it("エコーを選ぶと、そのモードを通知する", () => {
    const onChange = vi.fn();
    const s = base({
      type: "telnet",
      echo: { mode: "auto", effective: false, onChange },
    });
    find(s, "ローカルエコー: オン").onSelect();
    find(s, "ローカルエコー: オフ").onSelect();
    find(s, "ローカルエコー: 自動（現在 オフ）").onSelect();
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(["on", "off", "auto"]);
  });

  it("シリアル: エコーに加え、DTR・RTS・ブレーク・HEX表示", () => {
    const s = base({ type: "serial" });
    expect(labels(s)).toEqual([
      "タイムスタンプ表示",
      "検索…（⌘F）",
      "ログ記録を開始…",
      "ローカルエコー: 自動（現在 オフ）",
      "ローカルエコー: オン",
      "ローカルエコー: オフ",
      "DTR",
      "RTS",
      "ブレーク送信",
      "HEX表示",
    ]);
    expect(find(s, "DTR").checked).toBe(true);
    expect(find(s, "HEX表示").checked).toBe(false);
  });

  it("シリアルの操作が呼ばれる", () => {
    const serial = {
      signals: { dtr: true, rts: false },
      hex: true,
      breaking: false,
      onToggleSignal: vi.fn(),
      onBreak: vi.fn(),
      onToggleHex: vi.fn(),
    };
    const s = base({ type: "serial", serial });
    find(s, "DTR").onSelect();
    find(s, "RTS").onSelect();
    find(s, "ブレーク送信").onSelect();
    find(s, "HEX表示").onSelect();
    expect(serial.onToggleSignal.mock.calls.map((c) => c[0])).toEqual([
      "dtr",
      "rts",
    ]);
    expect(serial.onBreak).toHaveBeenCalled();
    expect(serial.onToggleHex).toHaveBeenCalled();
    expect(find(s, "RTS").checked).toBe(false);
    expect(find(s, "HEX表示").checked).toBe(true);
  });

  it("接続していない間（セッションなし）は、シリアルの操作・ログ開始を押せない", () => {
    const s = base({ type: "serial", hasSession: false, connected: false });
    for (const l of ["DTR", "RTS", "ブレーク送信", "HEX表示"])
      expect(find(s, l).disabled).toBe(true);
    expect(find(s, "ログ記録を開始…").disabled).toBe(true);
  });

  it("ブレーク送信中は、ブレークを押せない", () => {
    const s = base({
      type: "serial",
      serial: { ...base().serial!, breaking: true },
    });
    expect(find(s, "ブレーク送信").disabled).toBe(true);
  });

  it("ログ記録中は『停止』に変わる", () => {
    const stop = vi.fn();
    const s = base({ logging: true, onLogStop: stop });
    expect(labels(s)).toContain("ログ記録を停止");
    expect(labels(s)).not.toContain("ログ記録を開始…");
    find(s, "ログ記録を停止").onSelect();
    expect(stop).toHaveBeenCalled();
  });

  it("時刻表示の切り替え: 状態を反映し、選ぶと切り替える。切り替えが渡されなければ項目を出さない", () => {
    const toggle = vi.fn();
    const s = base({ showTimestamps: true, onToggleTimestamps: toggle });
    expect(find(s, "タイムスタンプ表示").checked).toBe(true);
    find(s, "タイムスタンプ表示").onSelect();
    expect(toggle).toHaveBeenCalled();
    expect(labels(base({ onToggleTimestamps: undefined }))).not.toContain(
      "タイムスタンプ表示",
    );
  });

  it("グループの境目に区切り線（ログ・エコー・シリアルの先頭）", () => {
    const items = buildPaneMenuItems(base({ type: "serial" }));
    const starts = items.filter((i) => i.separatorBefore).map((i) => i.label);
    expect(starts).toEqual([
      "ログ記録を開始…",
      "ローカルエコー: 自動（現在 オフ）",
      "DTR",
    ]);
  });
});

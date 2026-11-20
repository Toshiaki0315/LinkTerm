import type { ContextMenuItem } from "../components/ContextMenu";
import type { ControlSignal } from "./terminal-api";
import type { EchoMode } from "./local-echo";

/** ペインの操作メニューを作るための、ペインの種類と状態、操作。 */
export interface PaneMenuState {
  type: "local" | "ssh" | "telnet" | "serial";
  /** 接続済みか（SFTP など、接続中だけ使える操作の判定）。 */
  connected: boolean;
  /** セッションがあるか（ログ・シリアルの操作の判定）。 */
  hasSession: boolean;
  showTimestamps: boolean;
  /** 渡さなければ、時刻表示の項目を出さない。 */
  onToggleTimestamps?: () => void;
  onSearch: () => void;
  onSftp: () => void;
  logging: boolean;
  onLogStart: () => void;
  onLogStop: () => void;
  /** Telnet / シリアルのときだけ使う。 */
  echo?: {
    mode: EchoMode;
    effective: boolean;
    onChange: (mode: EchoMode) => void;
  };
  /** シリアルのときだけ使う。 */
  serial?: {
    signals: Record<ControlSignal, boolean>;
    hex: boolean;
    breaking: boolean;
    onToggleSignal: (signal: ControlSignal) => void;
    onBreak: () => void;
    onToggleHex: () => void;
  };
}

/**
 * タブバーの「⋯」に出す、操作中のペイン向けのメニュー項目。
 * ペインの種類（ローカル・SSH・Telnet・シリアル）に応じて、使える項目だけを並べる。
 */
export function buildPaneMenuItems(s: PaneMenuState): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (s.onToggleTimestamps) {
    items.push({
      label: "タイムスタンプ表示",
      checked: s.showTimestamps,
      onSelect: s.onToggleTimestamps,
    });
  }
  items.push({ label: "検索…（⌘F）", onSelect: s.onSearch });
  if (s.type === "ssh") {
    items.push({
      label: "ファイル転送（SFTP）…",
      disabled: !s.connected,
      onSelect: s.onSftp,
    });
  }
  items.push(
    s.logging
      ? {
          label: "ログ記録を停止",
          separatorBefore: true,
          onSelect: s.onLogStop,
        }
      : {
          label: "ログ記録を開始…",
          separatorBefore: true,
          disabled: !s.hasSession,
          onSelect: s.onLogStart,
        },
  );
  if ((s.type === "telnet" || s.type === "serial") && s.echo) {
    const { mode, effective, onChange } = s.echo;
    items.push(
      {
        label: `ローカルエコー: 自動（現在 ${effective ? "オン" : "オフ"}）`,
        separatorBefore: true,
        checked: mode === "auto",
        onSelect: () => onChange("auto"),
      },
      {
        label: "ローカルエコー: オン",
        checked: mode === "on",
        onSelect: () => onChange("on"),
      },
      {
        label: "ローカルエコー: オフ",
        checked: mode === "off",
        onSelect: () => onChange("off"),
      },
    );
  }
  if (s.type === "serial" && s.serial) {
    const { signals, hex, breaking } = s.serial;
    const off = !s.hasSession;
    items.push(
      {
        label: "DTR",
        separatorBefore: true,
        checked: signals.dtr,
        disabled: off,
        onSelect: () => s.serial!.onToggleSignal("dtr"),
      },
      {
        label: "RTS",
        checked: signals.rts,
        disabled: off,
        onSelect: () => s.serial!.onToggleSignal("rts"),
      },
      {
        label: "ブレーク送信",
        disabled: off || breaking,
        onSelect: s.serial.onBreak,
      },
      {
        label: "HEX表示",
        checked: hex,
        disabled: off,
        onSelect: s.serial.onToggleHex,
      },
    );
  }
  return items;
}

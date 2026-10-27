import {
  connectionTitle,
  parseSavedValues,
  stripSecrets,
  type ConnectionValues,
} from "./connection-schema";

/** 履歴に残す件数の上限（Rust 側の上限と同じ）。 */
export const MAX_RECENT = 20;

/** 履歴の1件。`values` は接続フォームの値（パスワード類は含まない）。 */
export interface RecentEntry {
  values: ConnectionValues;
  usedAt: number;
}

/** バックエンドに保存する形。 */
export interface StoredRecent {
  values: Record<string, unknown>;
  usedAt: number;
}

/** 接続先が同じかを判べるキー。色・文字コード・秘密情報などの違いは無視する。 */
export function connectionKey(v: ConnectionValues): string {
  switch (v.type) {
    case "local":
      return "local";
    case "ssh":
      return `ssh:${v.username}@${v.host}:${v.port}`;
    case "telnet":
      return `telnet:${v.host}:${v.port}`;
    case "serial":
      return `serial:${v.serialPort}@${v.baudRate}`;
  }
}

/**
 * 接続先を履歴の先頭へ加える。同じ接続先は置き換えて重複させず、上限を超えた古いものは捨てる。
 * パスワード類は残さない。ローカルシェルは履歴に入れない。
 */
export function recordRecent(
  list: RecentEntry[],
  values: ConnectionValues,
  now: number,
): RecentEntry[] {
  if (values.type === "local") return list;
  const key = connectionKey(values);
  const kept = list.filter((r) => connectionKey(r.values) !== key);
  // 秘密情報は取り除く（SSH は空の値に戻す）。
  const safe: ConnectionValues =
    values.type === "ssh"
      ? { ...values, password: "", passphrase: "" }
      : values;
  return [{ values: safe, usedAt: now }, ...kept].slice(0, MAX_RECENT);
}

/** 保存された履歴を読み込む。検証できない項目は捨てる。 */
export function parseRecent(raw: unknown): RecentEntry[] {
  if (!Array.isArray(raw)) return [];
  const result: RecentEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { values, usedAt } = item as { values?: unknown; usedAt?: unknown };
    const parsed = parseSavedValues(values);
    if (!parsed || parsed.type === "local") continue;
    result.push({
      values: parsed,
      usedAt: typeof usedAt === "number" ? usedAt : 0,
    });
  }
  return result;
}

/** 保存用の形にする（パスワード類を除く）。 */
export function toStoredRecent(list: RecentEntry[]): StoredRecent[] {
  return list.map((r) => ({
    values: stripSecrets(r.values),
    usedAt: r.usedAt,
  }));
}

/** メニューなどに出す接続先の名前。SSH は 22 以外のポートも示す。 */
export function recentLabel(v: ConnectionValues): string {
  if (v.type === "ssh" && v.port !== 22) {
    return `${connectionTitle(v)}:${v.port}`;
  }
  return connectionTitle(v);
}

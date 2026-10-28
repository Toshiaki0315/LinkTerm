/** SFTP の画面で使う、パスと表示の補助。 */

/** 親のパス。ルートの親はルート。 */
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  if (at <= 0) return "/";
  return trimmed.slice(0, at);
}

/** フォルダーとファイル名をつなぐ。 */
export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/** ローカルのパスのファイル名。 */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(
    Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1,
  );
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** バイト数を読みやすくする（1024 区切り）。 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 || value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return `${text.replace(/\.0$/, "")} ${UNITS[unit]}`;
}

/** UNIX 秒を `YYYY-MM-DD HH:mm`（ローカル時刻）にする。 */
export function formatModified(seconds: number | null): string {
  if (seconds === null) return "";
  const d = new Date(seconds * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 進捗の割合（0〜100）。大きさが分からなければ `null`。 */
export function progressPercent(
  transferred: number,
  total: number,
): number | null {
  if (total <= 0) return null;
  return Math.min(100, Math.floor((transferred / total) * 100));
}

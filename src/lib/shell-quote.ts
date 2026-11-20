/**
 * Finder からドロップしたファイルのパスを、シェルのコマンド行に入れる文字列にする。
 *
 * macOS のターミナル（Terminal.app）と同じく、特別な意味を持つ ASCII の文字を
 * バックスラッシュで退避する（日本語などはそのまま）。入力は貼り付けとして渡すだけで、
 * 実行はしない。そのため、改行などの制御文字を含むパスは、コマンドとして実行されたり
 * 端末の制御に使われたりするおそれがあるので、使わない。
 */

/** そのまま書ける文字（ASCII）。それ以外の ASCII は退避する。 */
const SAFE_ASCII = /[A-Za-z0-9_./~@%+=:,-]/;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** パス1つを退避する。使えないパス（空・制御文字を含む）は `null`。 */
export function quotePath(path: string): string | null {
  if (path === "" || CONTROL.test(path)) return null;
  let out = "";
  for (const ch of path) {
    out += ch.charCodeAt(0) < 0x80 && !SAFE_ASCII.test(ch) ? `\\${ch}` : ch;
  }
  return out;
}

/** 複数のパスを、空白で区切り、最後にも空白を付ける（続けて打てるように。改行は付けない）。 */
export function dropText(paths: string[]): string {
  const quoted = paths.map(quotePath).filter((p): p is string => p !== null);
  return quoted.length === 0 ? "" : `${quoted.join(" ")} `;
}

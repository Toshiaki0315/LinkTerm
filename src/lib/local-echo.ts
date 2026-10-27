export type EchoMode = "auto" | "on" | "off";

/**
 * ローカルエコーを行うか。
 *
 * 自動は、接続先がエコーしていない（`false`）ときだけオンにする。
 * エコー状態が判定できない（`null`: シリアル等）場合はオフ。
 */
export function isLocalEchoOn(
  mode: EchoMode,
  remoteEcho: boolean | null,
): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return remoteEcho === false;
}

/** 端末の入力（xterm の onData）を、ローカルに表示するための文字列へ変換する。 */
export function echoFor(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\x1b") {
      // エスケープシーケンス（矢印キー等）は表示しない。
      const next = input[i + 1];
      if (next === "[") {
        i += 2;
        while (i < input.length && !/[\x40-\x7e]/.test(input[i])) i++;
      } else if (next === "O") {
        i += 2;
      } else {
        i += 1;
      }
    } else if (ch === "\r") {
      out += "\r\n";
      if (input[i + 1] === "\n") i++;
    } else if (ch === "\n") {
      out += "\r\n";
    } else if (ch === "\x7f" || ch === "\b") {
      out += "\b \b";
    } else if (ch === "\t" || ch >= " ") {
      out += ch;
    }
  }
  return out;
}

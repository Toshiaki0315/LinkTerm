/** 画面のバッファ（xterm の `IBuffer` のうち、必要な部分）。 */
export interface TextBuffer {
  length: number;
  getLine(y: number):
    | {
        isWrapped: boolean;
        translateToString(trimRight?: boolean): string;
      }
    | undefined;
}

/**
 * スクロールバックを含む画面の全体を、テキストにする。
 * 折り返された行は1行につなぎ、各行の右端の空白と、末尾の空行は除く。
 */
export function bufferToText(buffer: TextBuffer): string {
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y);
    if (!line) continue;
    // 折り返しの続きは、前の行へつなぐ（前の行の右端の空白は折り返しの余白なので除かない）。
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += line.translateToString(true);
    } else {
      lines.push(line.translateToString(true));
    }
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** 保存ダイアログの初期のファイル名（`terminal-20240102-030405.txt`）。 */
export function defaultExportName(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `terminal-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.txt`;
}

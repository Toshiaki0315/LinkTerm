/** 保存するスニペット。Rust 側（src-tauri/src/snippets.rs）の検証が正。 */
export interface Snippet {
  id: string;
  name: string;
  /** 送る内容。1行ずつ送り、行ごとに Enter を付ける。 */
  text: string;
  /** 行と行の間の待ち時間（ミリ秒）。 */
  lineDelayMs: number;
  /** 最後の行にも Enter を付けるか。 */
  sendEnter: boolean;
}

export const MAX_SNIPPETS = 100;
export const MAX_NAME_CHARS = 60;
export const MAX_TEXT_CHARS = 10_000;
export const MAX_LINE_DELAY_MS = 10_000;

/** 端末に送る Enter。 */
const ENTER = "\r";

export interface SnippetStep {
  data: string;
  /** この送信のあと、次の送信までに待つ時間（ミリ秒）。最後は 0。 */
  delayMs: number;
}

/** スニペットを、送信の手順（1行ずつ）に分ける。 */
export function snippetSteps(snippet: Snippet): SnippetStep[] {
  const lines = snippet.text.split(/\r\n|\r|\n/);
  // 末尾の改行で生じる空の最終行は、行として数えない。
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line, i) => {
    const last = i === lines.length - 1;
    return {
      data: last && !snippet.sendEnter ? line : line + ENTER,
      delayMs: last ? 0 : snippet.lineDelayMs,
    };
  });
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * スニペットを送る。`send` が `false` を返したら（送り先がなくなった等）中断する。
 * 途中で中断したか（最後まで送れなかったか）を返す。
 */
export async function runSnippet(
  snippet: Snippet,
  send: (data: string) => boolean | Promise<boolean>,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<boolean> {
  for (const step of snippetSteps(snippet)) {
    if (!(await send(step.data))) return false;
    if (step.delayMs > 0) await sleep(step.delayMs);
  }
  return true;
}

/** 新しいスニペットの初期値。 */
export const newSnippet = (id: string): Snippet => ({
  id,
  name: "",
  text: "",
  lineDelayMs: 0,
  sendEnter: true,
});

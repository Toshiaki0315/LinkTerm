/**
 * 自動ログイン（expect 風）。画面の出力から「待つ文字列」を探し、見つかったら「送る文字列」を送る。
 *
 * スクリプトは1行1手順で、`待つ文字列 => 送る文字列` と書く。
 * - 待つ文字列が空なら、待たずに送る（`=> admin`）。
 * - 送る文字列には、最後に Enter を付ける。`{password}` はログイン用パスワードに置き換える。
 * - 空行と `#` で始まる行は無視する。
 */
export interface LoginStep {
  /** 待つ文字列。`null` なら待たずに送る。 */
  wait: string | null;
  send: string;
}

export const MAX_LOGIN_STEPS = 30;
export const MAX_LOGIN_FIELD_CHARS = 200;
export const PASSWORD_TOKEN = "{password}";
/** 1手順で待つ時間（ミリ秒）。 */
export const DEFAULT_STEP_TIMEOUT_MS = 30_000;
/** 照合のために保持する出力の最大文字数。 */
const MAX_BUFFER_CHARS = 4096;

export type ParsedScript =
  { ok: true; steps: LoginStep[] } | { ok: false; error: string };

/** スクリプトの文章を手順に分ける。 */
export function parseLoginScript(text: string): ParsedScript {
  const steps: LoginStep[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const at = line.indexOf("=>");
    if (at < 0) {
      return {
        ok: false,
        error: `${index + 1}行目: 「待つ文字列 => 送る文字列」の形式で書いてください`,
      };
    }
    const wait = line.slice(0, at).trim();
    const send = line.slice(at + 2).trim();
    if (
      [...wait].length > MAX_LOGIN_FIELD_CHARS ||
      [...send].length > MAX_LOGIN_FIELD_CHARS
    ) {
      return {
        ok: false,
        error: `${index + 1}行目: ${MAX_LOGIN_FIELD_CHARS}文字以内で書いてください`,
      };
    }
    steps.push({ wait: wait === "" ? null : wait, send });
  }
  if (steps.length > MAX_LOGIN_STEPS) {
    return {
      ok: false,
      error: `手順は${MAX_LOGIN_STEPS}個までです`,
    };
  }
  return { ok: true, steps };
}

/** スクリプトが `{password}` を使うか（使うなら、接続時にパスワードの入力が要る）。 */
export const scriptUsesPassword = (text: string): boolean => {
  const parsed = parseLoginScript(text);
  return parsed.ok && parsed.steps.some((s) => s.send.includes(PASSWORD_TOKEN));
};

/** 画面制御用のエスケープシーケンスと、改行以外の制御文字を取り除く。 */
export function stripTerminalControls(text: string): string {
  return (
    text
      // CSI / OSC などのエスケープシーケンス
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b[@-Z\\-_]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
  );
}

export interface LoginRunnerOptions {
  steps: LoginStep[];
  /** `{password}` に置き換える値。 */
  password: string;
  /** 送信（Enter 込み）。 */
  send: (data: string) => void;
  /** 手順を全部終えた。 */
  onDone: () => void;
  /** 待っている文字列が来ないまま時間切れになった。 */
  onTimeout: (waitingFor: string) => void;
  timeoutMs?: number;
}

/** 出力を受け取りながら、手順を順に進める。 */
export class LoginRunner {
  private index = 0;
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private finished = false;
  private begun = false;
  private readonly timeoutMs: number;

  constructor(private readonly options: LoginRunnerOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  }

  /**
   * 手順を始める（送信できる状態になってから呼ぶ。何度呼んでもよい）。
   * それまでに届いた出力は保持しており、始めた時点で照合する。
   */
  begin() {
    if (this.begun) return;
    this.begun = true;
    this.advance();
  }

  /** 画面に出た文字列を渡す。 */
  feed(text: string) {
    if (this.finished) return;
    this.buffer = (this.buffer + stripTerminalControls(text)).slice(
      -MAX_BUFFER_CHARS,
    );
    if (this.begun) this.advance();
  }

  /** 中断する（切断・タブを閉じたとき）。 */
  stop() {
    this.finished = true;
    this.clearTimer();
  }

  get done() {
    return this.finished;
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private advance() {
    const { steps, password, send } = this.options;
    while (!this.finished && this.index < steps.length) {
      const step = steps[this.index];
      if (step.wait !== null) {
        const at = this.buffer.indexOf(step.wait);
        if (at < 0) {
          this.armTimer(step.wait);
          return;
        }
        // 一致した所までを消し、次の手順は、それ以降に出た文字列を待つ。
        this.buffer = this.buffer.slice(at + step.wait.length);
      }
      this.clearTimer();
      send(step.send.split(PASSWORD_TOKEN).join(password) + "\r");
      this.index += 1;
    }
    if (!this.finished) {
      this.finished = true;
      this.clearTimer();
      this.options.onDone();
    }
  }

  private armTimer(waitingFor: string) {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.finished) return;
      this.finished = true;
      this.options.onTimeout(waitingFor);
    }, this.timeoutMs);
  }
}

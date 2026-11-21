import { TtlError } from "./errors";
import type { Value } from "./expr";

/** `strspecial`: `\\` `\n` `\t` を文字にする（Tera Term と同じ範囲）。 */
export function strspecial(s: string): string {
  return s.replace(/\\([nt\\])/g, (_, c: string) =>
    c === "n" ? "\n" : c === "t" ? "\t" : "\\",
  );
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

interface Parts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
  /** UTC との差（分）。 */
  offset: number;
  zone: string;
}

/** 時間帯（IANA 名。省略は、この端末の時間）での年月日・時刻。時間帯が不正なら `null`。 */
function partsOf(date: Date, timeZone?: string): Parts | null {
  if (timeZone === undefined || timeZone === "") {
    const offset = -date.getTimezoneOffset();
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
      weekday: date.getDay(),
      offset,
      zone: "",
    };
  }
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    const map: Record<string, string> = {};
    for (const p of fmt.formatToParts(date)) map[p.type] = p.value;
    const year = Number(map.year);
    const month = Number(map.month);
    const day = Number(map.day);
    const hour = Number(map.hour) % 24;
    const minute = Number(map.minute);
    const second = Number(map.second);
    const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    const offset = Math.round(
      (asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000,
    );
    return {
      year,
      month,
      day,
      hour,
      minute,
      second,
      weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
      offset,
      zone: timeZone,
    };
  } catch {
    return null;
  }
}

/**
 * strftime の主な指定子で、日時を文字にする。対応しない指定子・時間帯が不正なら `null`。
 * 対応: %a %A %b %B %d %e %H %I %j %m %M %p %S %u %w %y %Y %z %Z %F %T %D %R %%
 */
export function strftime(
  format: string,
  date: Date,
  timeZone?: string,
): string | null {
  const p = partsOf(date, timeZone);
  if (!p) return null;
  let bad = false;
  const out = format.replace(/%(.?)/gs, (_, c: string) => {
    switch (c) {
      case "a":
        return DAYS[p.weekday].slice(0, 3);
      case "A":
        return DAYS[p.weekday];
      case "b":
        return MONTHS[p.month - 1].slice(0, 3);
      case "B":
        return MONTHS[p.month - 1];
      case "d":
        return pad2(p.day);
      case "e":
        return String(p.day).padStart(2, " ");
      case "H":
        return pad2(p.hour);
      case "I":
        return pad2(p.hour % 12 === 0 ? 12 : p.hour % 12);
      case "j": {
        const start = Date.UTC(p.year, 0, 1);
        const here = Date.UTC(p.year, p.month - 1, p.day);
        return String(Math.round((here - start) / 86_400_000) + 1).padStart(
          3,
          "0",
        );
      }
      case "m":
        return pad2(p.month);
      case "M":
        return pad2(p.minute);
      case "p":
        return p.hour < 12 ? "AM" : "PM";
      case "S":
        return pad2(p.second);
      case "u":
        return String(p.weekday === 0 ? 7 : p.weekday);
      case "w":
        return String(p.weekday);
      case "y":
        return pad2(p.year % 100);
      case "Y":
        return String(p.year);
      case "z": {
        const sign = p.offset < 0 ? "-" : "+";
        const abs = Math.abs(p.offset);
        return `${sign}${pad2(Math.floor(abs / 60))}${pad2(abs % 60)}`;
      }
      case "Z":
        return p.zone === "" ? localZoneName(date) : p.zone;
      case "F":
        return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
      case "T":
        return `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
      case "D":
        return `${pad2(p.month)}/${pad2(p.day)}/${pad2(p.year % 100)}`;
      case "R":
        return `${pad2(p.hour)}:${pad2(p.minute)}`;
      case "%":
        return "%";
      default:
        bad = true;
        return "";
    }
  });
  return bad ? null : out;
}

function localZoneName(date: Date): string {
  try {
    return (
      new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
        .formatToParts(date)
        .find((p) => p.type === "timeZoneName")?.value ?? ""
    );
  } catch {
    return "";
  }
}

/** 旧い呼び名（`%Y %y %m %d %H %M %S` だけ）。そのほかは、そのまま残す。 */
export function formatStrftime(format: string, d: Date): string {
  return format.replace(/%([YymdHMS%])/g, (m) => strftime(m, d) ?? m);
}

export type PrintfResult =
  { code: 0; text: string } | { code: 1 | 2 | 3; text: "" };

/**
 * C 言語の printf 風の書式づくり（`sprintf2` の仕組み）。
 * 指定子: c d i o u x X s。旗: - + 0 # 空白。幅・精度は数値か `*`。浮動小数点は扱わない。
 * 結果の code: 0 成功、1 書式の指定子がない、2 書式が不正、3 引数が合わない。
 */
export function printf(format: string, args: Value[]): PrintfResult {
  let next = 0;
  let specs = 0;
  let text = "";
  let i = 0;
  const bad = (code: 2 | 3): PrintfResult => ({ code, text: "" });
  while (i < format.length) {
    const ch = format[i];
    if (ch !== "%") {
      text += ch;
      i += 1;
      continue;
    }
    const m = /^%([-+0# ]*)(\*|\d+)?(?:\.(\*|\d*))?([a-zA-Z%])?/.exec(
      format.slice(i),
    );
    if (!m || m[4] === undefined) return bad(2);
    i += m[0].length;
    const conv = m[4];
    if (conv === "%") {
      text += "%";
      continue;
    }
    if (!"cdiouxXs".includes(conv)) return bad(2);
    specs += 1;
    const take = (): Value | undefined => args[next++];
    let width = 0;
    if (m[2] === "*") {
      const w = take();
      if (typeof w !== "number") return bad(3);
      width = w;
    } else if (m[2] !== undefined) {
      width = Number(m[2]);
    }
    let precision: number | null = null;
    if (m[3] === "*") {
      const p = take();
      if (typeof p !== "number") return bad(3);
      precision = p;
    } else if (m[3] !== undefined) {
      precision = m[3] === "" ? 0 : Number(m[3]);
    }
    const arg = take();
    if (arg === undefined) return bad(3);
    const flags = m[1];
    let body: string;
    let numeric = false;
    if (conv === "s") {
      if (typeof arg !== "string") return bad(3);
      body = precision === null ? arg : arg.slice(0, precision);
    } else {
      if (typeof arg !== "number") return bad(3);
      if (conv === "c") {
        body = String.fromCodePoint(arg);
      } else {
        numeric = true;
        let digits: string;
        let sign = "";
        if (conv === "d" || conv === "i") {
          digits = String(Math.abs(arg));
          sign =
            arg < 0
              ? "-"
              : flags.includes("+")
                ? "+"
                : flags.includes(" ")
                  ? " "
                  : "";
        } else if (conv === "u") {
          digits = String(arg >>> 0);
        } else if (conv === "o") {
          digits = (arg >>> 0).toString(8);
          if (flags.includes("#") && digits[0] !== "0") digits = "0" + digits;
        } else {
          digits = (arg >>> 0).toString(16);
          if (conv === "X") digits = digits.toUpperCase();
        }
        if (precision !== null) digits = digits.padStart(precision, "0");
        let prefix = "";
        if (
          (conv === "x" || conv === "X") &&
          flags.includes("#") &&
          arg !== 0
        ) {
          prefix = conv === "x" ? "0x" : "0X";
        }
        const zeroPad =
          flags.includes("0") && !flags.includes("-") && precision === null;
        const len = sign.length + prefix.length + digits.length;
        body =
          zeroPad && len < width
            ? sign + prefix + "0".repeat(width - len) + digits
            : sign + prefix + digits;
      }
    }
    if (body.length < width) {
      body = flags.includes("-")
        ? body.padEnd(width, " ")
        : body.padStart(width, " ");
    }
    void numeric;
    text += body;
  }
  if (specs === 0) return { code: 1, text: "" };
  return { code: 0, text };
}

/** `sprintf`（結果を inputstr に入れる版）。エラーは例外にする。 */
export function sprintf(
  format: string,
  args: Value[],
  name = "sprintf",
): string {
  const r = printf(format, args);
  if (r.code === 0) return r.text;
  // 指定子がない書式（そのままの文字列）は、sprintf では、そのまま返す。
  if (r.code === 1) return format.replace(/%%/g, "%");
  throw new TtlError(
    r.code === 2
      ? `${name}: 書式が正しくありません`
      : `${name}: 書式に対して引数が合いません`,
  );
}

/** 文字列の各文字（UTF-8 のバイト）の合計を、指定した桁で切る。 */
export function checksum(text: string, bits: 8 | 16 | 32): number {
  let sum = 0;
  for (const b of new TextEncoder().encode(text)) sum += b;
  if (bits === 8) return sum & 0xff;
  if (bits === 16) return sum & 0xffff;
  return sum | 0;
}

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** 標準の CRC-32（Ethernet）。 */
export function crc32(text: string): number {
  let c = 0xffffffff;
  for (const b of new TextEncoder().encode(text)) {
    c = CRC32_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) | 0;
}

/** CRC-16（多項式 0x1021 の反転 0x8408、初期値・最終 XOR とも 0xFFFF）。 */
export function crc16(text: string): number {
  let c = 0xffff;
  for (const b of new TextEncoder().encode(text)) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1;
  }
  return (c ^ 0xffff) & 0xffff;
}

/** 32 ビットの循環シフト。 */
export function rotate32(value: number, count: number, left: boolean): number {
  const c = ((count % 32) + 32) % 32;
  if (c === 0) return value | 0;
  const v = value >>> 0;
  return (left ? (v << c) | (v >>> (32 - c)) : (v >>> c) | (v << (32 - c))) | 0;
}

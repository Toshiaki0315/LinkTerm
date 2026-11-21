import { TtlError } from "./errors";
import type { Value } from "./expr";

/** `strspecial`: `\n` `\r` `\t` `\a` `\b` `\\` `\xHH` を文字にする。 */
export function strspecial(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{2}|[nrtab\\])/g, (_, c: string) => {
    if (c[0] === "x") return String.fromCharCode(parseInt(c.slice(1), 16));
    switch (c) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "a":
        return "\u0007";
      case "b":
        return "\b";
      default:
        return "\\";
    }
  });
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** strftime の一部（%Y %y %m %d %H %M %S %%）。そのほかの指定は、そのまま残す。 */
export function formatStrftime(format: string, d: Date): string {
  return format.replace(/%([YymdHMS%])/g, (_, c: string) => {
    switch (c) {
      case "Y":
        return String(d.getFullYear());
      case "y":
        return pad2(d.getFullYear() % 100);
      case "m":
        return pad2(d.getMonth() + 1);
      case "d":
        return pad2(d.getDate());
      case "H":
        return pad2(d.getHours());
      case "M":
        return pad2(d.getMinutes());
      case "S":
        return pad2(d.getSeconds());
      default:
        return "%";
    }
  });
}

/** `sprintf`: %d %i %u %s %x %X %c %%（幅・`-`・`0` つき）。 */
export function sprintf(
  format: string,
  args: Value[],
  name = "sprintf",
): string {
  let next = 0;
  return format.replace(
    /%([-0]*)(\d*)([diuxXsc%])/g,
    (_, flags: string, width: string, conv: string) => {
      if (conv === "%") return "%";
      if (next >= args.length)
        throw new TtlError(`${name}: 書式に対して引数が足りません`);
      const arg = args[next];
      next += 1;
      let text: string;
      if (conv === "s") {
        if (typeof arg !== "string")
          throw new TtlError(`${name}: %s には文字列が必要です`);
        text = arg;
      } else {
        if (typeof arg !== "number")
          throw new TtlError(`${name}: %${conv} には整数が必要です`);
        if (conv === "c") text = String.fromCodePoint(arg);
        else if (conv === "x") text = (arg >>> 0).toString(16);
        else if (conv === "X") text = (arg >>> 0).toString(16).toUpperCase();
        else if (conv === "u") text = String(arg >>> 0);
        else text = String(arg);
      }
      const w = width === "" ? 0 : Number(width);
      if (text.length >= w) return text;
      if (flags.includes("-")) return text.padEnd(w, " ");
      if (flags.includes("0") && conv !== "s" && conv !== "c") {
        return text.startsWith("-")
          ? "-" + text.slice(1).padStart(w - 1, "0")
          : text.padStart(w, "0");
      }
      return text.padStart(w, " ");
    },
  );
}

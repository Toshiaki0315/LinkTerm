import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export interface SearchOptions {
  caseSensitive: boolean;
  regex: boolean;
}

interface Props {
  /**
   * 検索を実行する。一致があれば `true`。
   * `incremental` は入力途中の検索（現在の一致の位置を保つ）。不正な正規表現などは例外を投げてよい。
   */
  onFind: (
    term: string,
    options: SearchOptions,
    direction: "next" | "previous",
    incremental: boolean,
  ) => boolean;
  /** 検索語が空になったとき、強調表示を消す。 */
  onClear: () => void;
  onClose: () => void;
}

type Status = "idle" | "notFound" | "badRegex";

/** ターミナルのスクロールバック内を検索するバー（⌘F）。 */
export function SearchBar({ onFind, onClear, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [term, setTerm] = useState("");
  const [options, setOptions] = useState<SearchOptions>({
    caseSensitive: false,
    regex: false,
  });
  const [status, setStatus] = useState<Status>("idle");

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const run = (
    nextTerm: string,
    nextOptions: SearchOptions,
    direction: "next" | "previous",
    incremental: boolean,
  ) => {
    if (nextTerm === "") {
      onClear();
      setStatus("idle");
      return;
    }
    try {
      const found = onFind(nextTerm, nextOptions, direction, incremental);
      setStatus(found ? "idle" : "notFound");
    } catch {
      setStatus("badRegex");
    }
  };

  const toggle = (key: keyof SearchOptions) => {
    const next = { ...options, [key]: !options[key] };
    setOptions(next);
    run(term, next, "next", true);
  };

  const toggleClass = (on: boolean) =>
    cn("font-mono", on && "bg-sky-900/60 text-sky-200");

  return (
    <div
      role="search"
      className="absolute right-3 top-12 z-20 flex items-center gap-1 rounded-md border border-neutral-700 bg-neutral-900/95 p-1.5 shadow-lg"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <Input
        ref={inputRef}
        aria-label="検索"
        placeholder="検索"
        autoComplete="off"
        className="h-7 w-52"
        value={term}
        onChange={(e) => {
          setTerm(e.target.value);
          run(e.target.value, options, "next", true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            run(term, options, e.shiftKey ? "previous" : "next", false);
          }
        }}
      />
      <Button
        variant="ghost"
        size="icon"
        aria-label="前の一致"
        onClick={() => run(term, options, "previous", false)}
      >
        <ChevronUp className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="次の一致"
        onClick={() => run(term, options, "next", false)}
      >
        <ChevronDown className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="大文字と小文字を区別"
        aria-pressed={options.caseSensitive}
        className={toggleClass(options.caseSensitive)}
        onClick={() => toggle("caseSensitive")}
      >
        Aa
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="正規表現"
        aria-pressed={options.regex}
        className={toggleClass(options.regex)}
        onClick={() => toggle("regex")}
      >
        .*
      </Button>
      {status === "notFound" && (
        <span className="px-1 text-xs text-amber-300">見つかりません</span>
      )}
      {status === "badRegex" && (
        <span className="px-1 text-xs text-red-300">
          正規表現が正しくありません
        </span>
      )}
      <Button
        variant="ghost"
        size="icon"
        aria-label="検索を閉じる"
        onClick={onClose}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

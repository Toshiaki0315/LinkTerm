import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { DEFAULT_SETTINGS, type Appearance } from "../lib/settings";
import { copyText } from "../lib/clipboard";
import { isOpenableUrl, openExternalUrl } from "../lib/open-url";
import { themeFor } from "../lib/themes";
import type { HighlightRule } from "../lib/highlight";
import { HighlightScanner, type ScanTerm } from "../lib/highlight-scanner";
import { ScanBatcher } from "../lib/scan-batcher";
import { TimestampStamper, type StampTerm } from "../lib/timestamp-stamper";

/** xterm.js のオプションとして設定する外観（コピー設定は含まない）。 */
type XtermAppearance = Omit<Appearance, "copyOnSelect" | "backspaceKey">;

const DEFAULT_APPEARANCE: Appearance = {
  fontFamily: DEFAULT_SETTINGS.fontFamily,
  fontSize: DEFAULT_SETTINGS.fontSize,
  scrollback: DEFAULT_SETTINGS.scrollback,
  cursorBlink: DEFAULT_SETTINGS.cursorBlink,
  cursorStyle: DEFAULT_SETTINGS.cursorStyle,
  backspaceKey: DEFAULT_SETTINGS.backspaceKey,
  optionIsMeta: DEFAULT_SETTINGS.optionIsMeta,
  theme: DEFAULT_SETTINGS.theme,
  copyOnSelect: DEFAULT_SETTINGS.copyOnSelect,
};

export interface TerminalHandle {
  /** 生バイト列を描画する（文字コード変換は xterm 側のUTF-8デコードに任せる）。 */
  write(data: Uint8Array): void;
  size(): { cols: number; rows: number };
  /** スクロールバック内を検索する。一致があれば `true`。不正な正規表現は例外になる。 */
  find(
    term: string,
    options: { caseSensitive: boolean; regex: boolean },
    direction: "next" | "previous",
    incremental: boolean,
  ): boolean;
  /** 検索の強調表示と選択を消す。 */
  clearSearch(): void;
  hasSelection(): boolean;
  getSelection(): string;
  selectAll(): void;
  /** スクロールバックを含めて画面を消す。 */
  clear(): void;
  /** 貼り付け。入力と同じ経路（`onInput`）で接続先へ送られる。 */
  paste(text: string): void;
  focus(): void;
}

interface Props {
  /** 表示中か。非表示でもアンマウントはしない（Keep-Alive）。 */
  active: boolean;
  /** フォント等の外観。変更は作り直さずに反映する。 */
  appearance?: Appearance;
  /** キーワードのハイライト規則。 */
  highlightRules?: HighlightRule[];
  /** 各行の右端に、その行が現れた時刻を重ねて表示する。 */
  showTimestamps?: boolean;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  /** 右クリック。ブラウザ標準のメニューは出さず、画面上の位置を通知する。 */
  onContextMenu?: (position: { x: number; y: number }) => void;
}

/** xterm.js のインスタンスは React の再描画の影響を受けないよう ref で保持する。 */
export const TerminalView = forwardRef<TerminalHandle, Props>(
  function TerminalView(
    {
      active,
      appearance = DEFAULT_APPEARANCE,
      highlightRules,
      showTimestamps = false,
      onInput,
      onResize,
      onContextMenu,
    },
    handleRef,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const searchRef = useRef<SearchAddon | null>(null);
    const scannerRef = useRef<HighlightScanner | null>(null);
    const stamperRef = useRef<TimestampStamper | null>(null);
    /** 画面の走査をまとめる（大量の出力で詰まらないよう、一定の間隔に1回まで）。 */
    const batcherRef = useRef<ScanBatcher | null>(null);
    const onInputRef = useRef(onInput);
    const onResizeRef = useRef(onResize);
    const {
      fontFamily,
      fontSize,
      scrollback,
      cursorBlink,
      cursorStyle,
      optionIsMeta,
      backspaceKey,
      theme,
      copyOnSelect,
    } = appearance;
    const copyOnSelectRef = useRef(copyOnSelect);
    const backspaceKeyRef = useRef(backspaceKey);
    const onContextMenuRef = useRef(onContextMenu);
    /** 生成時・前回反映時の外観。値が変わったときだけ xterm に設定する。 */
    const appliedRef = useRef<XtermAppearance>({
      fontFamily,
      fontSize,
      scrollback,
      cursorBlink,
      cursorStyle,
      optionIsMeta,
      theme,
    });

    useEffect(() => {
      backspaceKeyRef.current = backspaceKey;
      onInputRef.current = onInput;
      onResizeRef.current = onResize;
      copyOnSelectRef.current = copyOnSelect;
      onContextMenuRef.current = onContextMenu;
    }, [onInput, onResize, copyOnSelect, onContextMenu, backspaceKey]);

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      const {
        theme: initialTheme,
        optionIsMeta: meta,
        ...options
      } = appliedRef.current;
      const term = new Terminal({
        ...options,
        macOptionIsMeta: meta,
        theme: themeFor(initialTheme).xterm,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      const searchAddon = new SearchAddon();
      term.loadAddon(searchAddon);
      searchRef.current = searchAddon;
      // URL は ⌘+クリックで開く（修飾キーなしのクリックは、選択操作のために開かない）。
      term.loadAddon(
        new WebLinksAddon((event, uri) => {
          if (!event.metaKey || !isOpenableUrl(uri)) return;
          openExternalUrl(uri).catch((e: unknown) =>
            console.error("URLを開けませんでした:", e),
          );
        }),
      );
      term.open(container);
      termRef.current = term;
      // 画面の文字列を調べて色を付ける（テストの偽物など、バッファを持たない場合は使わない）。
      if (term.buffer?.active) {
        const scanner = new HighlightScanner(term as unknown as ScanTerm);
        scannerRef.current = scanner;
        stamperRef.current = new TimestampStamper(term as unknown as StampTerm);
        batcherRef.current = new ScanBatcher((lines) => {
          scannerRef.current?.scanRecent(lines);
          stamperRef.current?.scanRecent(lines);
        });
      }
      fitRef.current = fit;

      // BS 設定のとき、Backspace が送る DEL(0x7f) を BS(0x08) に置き換える。
      const dataSub = term.onData((d) =>
        onInputRef.current(
          d === "\x7f" && backspaceKeyRef.current === "bs" ? "\x08" : d,
        ),
      );
      const resizeSub = term.onResize(({ cols, rows }) =>
        onResizeRef.current(cols, rows),
      );
      const observer = new ResizeObserver(() => {
        // 非表示（display:none）中はサイズが0になるため再計算しない。
        if (container.offsetParent !== null) fit.fit();
      });
      observer.observe(container);
      fit.fit();

      return () => {
        observer.disconnect();
        dataSub.dispose();
        resizeSub.dispose();
        batcherRef.current?.dispose();
        batcherRef.current = null;
        scannerRef.current?.dispose();
        scannerRef.current = null;
        stamperRef.current?.dispose();
        stamperRef.current = null;
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
        searchRef.current = null;
      };
    }, []);

    useEffect(() => {
      const term = termRef.current;
      const applied = appliedRef.current;
      const next = {
        fontFamily,
        fontSize,
        scrollback,
        cursorBlink,
        cursorStyle,
        optionIsMeta,
        theme,
      };
      const changed = (
        Object.keys(next) as Array<keyof XtermAppearance>
      ).filter((key) => applied[key] !== next[key]);
      if (!term || changed.length === 0) return;
      term.options.fontFamily = fontFamily;
      term.options.fontSize = fontSize;
      term.options.scrollback = scrollback;
      term.options.cursorBlink = cursorBlink;
      term.options.cursorStyle = cursorStyle;
      term.options.macOptionIsMeta = optionIsMeta;
      if (applied.theme !== theme) term.options.theme = themeFor(theme).xterm;
      appliedRef.current = next;
      // 文字の大きさが変わると行・列数が変わるため、表示中なら再計算する。
      if (containerRef.current?.offsetParent !== null) fitRef.current?.fit();
    }, [
      fontFamily,
      fontSize,
      scrollback,
      cursorBlink,
      cursorStyle,
      optionIsMeta,
      theme,
    ]);

    useEffect(() => {
      stamperRef.current?.setEnabled(showTimestamps);
    }, [showTimestamps]);

    useEffect(() => {
      scannerRef.current?.setRules(highlightRules ?? []);
    }, [highlightRules]);

    useEffect(() => {
      if (!active) return;
      fitRef.current?.fit();
      termRef.current?.focus();
    }, [active]);

    useImperativeHandle(
      handleRef,
      () => ({
        write: (data) => {
          const term = termRef.current;
          if (!term) return;
          // 書き込みが画面に反映されてから、新しく増えた行を調べる。
          let lines = 2;
          for (const byte of data) if (byte === 0x0a) lines += 1;
          term.write(data, () => batcherRef.current?.request(lines));
        },
        size: () => ({
          cols: termRef.current?.cols ?? 80,
          rows: termRef.current?.rows ?? 24,
        }),
        focus: () => termRef.current?.focus(),
        find: (term, options, direction, incremental) => {
          const search = searchRef.current;
          if (!search) return false;
          const opts = { ...options, incremental };
          return direction === "next"
            ? search.findNext(term, opts)
            : search.findPrevious(term, opts);
        },
        clearSearch: () => {
          searchRef.current?.clearDecorations();
          termRef.current?.clearSelection();
        },
        hasSelection: () => termRef.current?.hasSelection() ?? false,
        getSelection: () => termRef.current?.getSelection() ?? "",
        selectAll: () => termRef.current?.selectAll(),
        clear: () => termRef.current?.clear(),
        paste: (text) => termRef.current?.paste(text),
      }),
      [],
    );

    return (
      <div
        ref={containerRef}
        className="h-full w-full"
        style={{ backgroundColor: themeFor(theme).background }}
        onMouseUp={() => {
          // 選択したらコピー（オンのとき）。選択がなければクリップボードを触らない。
          const term = termRef.current;
          if (!copyOnSelectRef.current || !term?.hasSelection()) return;
          copyText(term.getSelection()).catch((e: unknown) =>
            console.error("コピーに失敗しました:", e),
          );
        }}
        onContextMenu={(e) => {
          if (!onContextMenuRef.current) return;
          e.preventDefault();
          onContextMenuRef.current({ x: e.clientX, y: e.clientY });
        }}
      />
    );
  },
);

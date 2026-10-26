import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { DEFAULT_SETTINGS, type Appearance } from "../lib/settings";

const DEFAULT_APPEARANCE: Appearance = {
  fontFamily: DEFAULT_SETTINGS.fontFamily,
  fontSize: DEFAULT_SETTINGS.fontSize,
  scrollback: DEFAULT_SETTINGS.scrollback,
  cursorBlink: DEFAULT_SETTINGS.cursorBlink,
};

export interface TerminalHandle {
  /** 生バイト列を描画する（文字コード変換は xterm 側のUTF-8デコードに任せる）。 */
  write(data: Uint8Array): void;
  size(): { cols: number; rows: number };
  focus(): void;
}

interface Props {
  /** 表示中か。非表示でもアンマウントはしない（Keep-Alive）。 */
  active: boolean;
  /** フォント等の外観。変更は作り直さずに反映する。 */
  appearance?: Appearance;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

/** xterm.js のインスタンスは React の再描画の影響を受けないよう ref で保持する。 */
export const TerminalView = forwardRef<TerminalHandle, Props>(
  function TerminalView(
    { active, appearance = DEFAULT_APPEARANCE, onInput, onResize },
    handleRef,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const onInputRef = useRef(onInput);
    const onResizeRef = useRef(onResize);
    const { fontFamily, fontSize, scrollback, cursorBlink } = appearance;
    /** 生成時・前回反映時の外観。値が変わったときだけ xterm に設定する。 */
    const appliedRef = useRef<Appearance>({
      fontFamily,
      fontSize,
      scrollback,
      cursorBlink,
    });

    useEffect(() => {
      onInputRef.current = onInput;
      onResizeRef.current = onResize;
    }, [onInput, onResize]);

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      const term = new Terminal({ ...appliedRef.current });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      termRef.current = term;
      fitRef.current = fit;

      const dataSub = term.onData((d) => onInputRef.current(d));
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
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      };
    }, []);

    useEffect(() => {
      const term = termRef.current;
      const applied = appliedRef.current;
      const next = { fontFamily, fontSize, scrollback, cursorBlink };
      const changed = (Object.keys(next) as Array<keyof Appearance>).filter(
        (key) => applied[key] !== next[key],
      );
      if (!term || changed.length === 0) return;
      term.options.fontFamily = fontFamily;
      term.options.fontSize = fontSize;
      term.options.scrollback = scrollback;
      term.options.cursorBlink = cursorBlink;
      appliedRef.current = next;
      // 文字の大きさが変わると行・列数が変わるため、表示中なら再計算する。
      if (containerRef.current?.offsetParent !== null) fitRef.current?.fit();
    }, [fontFamily, fontSize, scrollback, cursorBlink]);

    useEffect(() => {
      if (!active) return;
      fitRef.current?.fit();
      termRef.current?.focus();
    }, [active]);

    useImperativeHandle(
      handleRef,
      () => ({
        write: (data) => termRef.current?.write(data),
        size: () => ({
          cols: termRef.current?.cols ?? 80,
          rows: termRef.current?.rows ?? 24,
        }),
        focus: () => termRef.current?.focus(),
      }),
      [],
    );

    return <div ref={containerRef} className="h-full w-full" />;
  },
);

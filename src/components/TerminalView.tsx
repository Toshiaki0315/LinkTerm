import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

export interface TerminalHandle {
  /** 生バイト列を描画する（文字コード変換は xterm 側のUTF-8デコードに任せる）。 */
  write(data: Uint8Array): void;
  size(): { cols: number; rows: number };
  focus(): void;
}

interface Props {
  /** 表示中か。非表示でもアンマウントはしない（Keep-Alive）。 */
  active: boolean;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

/** xterm.js のインスタンスは React の再描画の影響を受けないよう ref で保持する。 */
export const TerminalView = forwardRef<TerminalHandle, Props>(
  function TerminalView({ active, onInput, onResize }, handleRef) {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const onInputRef = useRef(onInput);
    const onResizeRef = useRef(onResize);

    useEffect(() => {
      onInputRef.current = onInput;
      onResizeRef.current = onResize;
    }, [onInput, onResize]);

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      const term = new Terminal({
        cursorBlink: true,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        fontSize: 13,
        scrollback: 10000,
      });
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

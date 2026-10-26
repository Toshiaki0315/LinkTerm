import { createRef } from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const xterm = vi.hoisted(() => {
  const instances: Array<
    Record<string, ReturnType<typeof vi.fn>> & {
      cols: number;
      rows: number;
      options: Record<string, unknown>;
    }
  > = [];
  const handlers: {
    data?: (d: string) => void;
    resize?: (s: { cols: number; rows: number }) => void;
  } = {};
  return { instances, handlers };
});

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    open = vi.fn();
    write = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    loadAddon = vi.fn();
    onData = vi.fn((cb: (d: string) => void) => {
      xterm.handlers.data = cb;
      return { dispose: vi.fn() };
    });
    onResize = vi.fn((cb: (s: { cols: number; rows: number }) => void) => {
      xterm.handlers.resize = cb;
      return { dispose: vi.fn() };
    });
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown> = {}) {
      this.options = { ...options };
      xterm.instances.push(this as never);
    }
  },
}));
const fit = vi.hoisted(() => vi.fn());
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = fit;
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { TerminalView, type TerminalHandle } from "./TerminalView";

beforeEach(() => {
  xterm.instances.length = 0;
  fit.mockClear();
  globalThis.ResizeObserver = class {
    observe = vi.fn();
    disconnect = vi.fn();
    unobserve = vi.fn();
  } as never;
});

describe("TerminalView", () => {
  it("xterm を1度だけ生成してDOMに開く", () => {
    const { rerender } = render(
      <TerminalView active onInput={() => {}} onResize={() => {}} />,
    );
    expect(xterm.instances).toHaveLength(1);
    expect(xterm.instances[0].open).toHaveBeenCalledTimes(1);
    rerender(
      <TerminalView active={false} onInput={() => {}} onResize={() => {}} />,
    );
    rerender(<TerminalView active onInput={() => {}} onResize={() => {}} />);
    expect(xterm.instances).toHaveLength(1);
  });

  it("ハンドル経由で生バイト列を書き込める", () => {
    const ref = createRef<TerminalHandle>();
    render(
      <TerminalView ref={ref} active onInput={() => {}} onResize={() => {}} />,
    );
    const bytes = new Uint8Array([0x68, 0xff]);
    ref.current!.write(bytes);
    expect(xterm.instances[0].write).toHaveBeenCalledWith(bytes);
  });

  it("ハンドルから現在のサイズを取得できる", () => {
    const ref = createRef<TerminalHandle>();
    render(
      <TerminalView ref={ref} active onInput={() => {}} onResize={() => {}} />,
    );
    expect(ref.current!.size()).toEqual({ cols: 80, rows: 24 });
  });

  it("キー入力とリサイズを通知する（最新のコールバックを使う）", () => {
    const first = vi.fn();
    const second = vi.fn();
    const onResize = vi.fn();
    const { rerender } = render(
      <TerminalView active onInput={first} onResize={onResize} />,
    );
    rerender(<TerminalView active onInput={second} onResize={onResize} />);
    xterm.handlers.data!("ls\r");
    xterm.handlers.resize!({ cols: 100, rows: 30 });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("ls\r");
    expect(onResize).toHaveBeenCalledWith(100, 30);
  });

  it("非表示→表示でサイズを再計算し、フォーカスする", () => {
    const { rerender } = render(
      <TerminalView active={false} onInput={() => {}} onResize={() => {}} />,
    );
    fit.mockClear();
    rerender(<TerminalView active onInput={() => {}} onResize={() => {}} />);
    expect(fit).toHaveBeenCalled();
    expect(xterm.instances[0].focus).toHaveBeenCalled();
  });

  it("アンマウントで破棄する", () => {
    const { unmount } = render(
      <TerminalView active onInput={() => {}} onResize={() => {}} />,
    );
    unmount();
    expect(xterm.instances[0].dispose).toHaveBeenCalledTimes(1);
  });

  describe("外観の設定", () => {
    const appearance = {
      fontFamily: "Osaka-Mono, monospace",
      fontSize: 18,
      scrollback: 777,
      cursorBlink: false,
    };

    it("指定した外観で xterm を生成する", () => {
      render(
        <TerminalView
          active
          appearance={appearance}
          onInput={() => {}}
          onResize={() => {}}
        />,
      );
      expect(xterm.instances[0].options).toMatchObject({
        fontFamily: "Osaka-Mono, monospace",
        fontSize: 18,
        scrollback: 777,
        cursorBlink: false,
      });
    });

    it("指定がなければ既定の外観を使う", () => {
      render(<TerminalView active onInput={() => {}} onResize={() => {}} />);
      expect(xterm.instances[0].options).toMatchObject({
        fontSize: 13,
        scrollback: 10000,
        cursorBlink: true,
      });
    });

    it("外観が変わったら作り直さずに反映し、サイズを再計算する", () => {
      const { rerender } = render(
        <TerminalView
          active
          appearance={appearance}
          onInput={() => {}}
          onResize={() => {}}
        />,
      );
      fit.mockClear();
      rerender(
        <TerminalView
          active
          appearance={{
            ...appearance,
            fontFamily: "Menlo",
            fontSize: 24,
            scrollback: 5,
            cursorBlink: true,
          }}
          onInput={() => {}}
          onResize={() => {}}
        />,
      );
      expect(xterm.instances).toHaveLength(1);
      expect(xterm.instances[0].options).toMatchObject({
        fontFamily: "Menlo",
        fontSize: 24,
        scrollback: 5,
        cursorBlink: true,
      });
      expect(fit).toHaveBeenCalled();
    });

    it("外観が同じなら xterm のオプションに触れない", () => {
      const { rerender } = render(
        <TerminalView
          active
          appearance={appearance}
          onInput={() => {}}
          onResize={() => {}}
        />,
      );
      const before = { ...xterm.instances[0].options };
      fit.mockClear();
      rerender(
        <TerminalView
          active
          appearance={{ ...appearance }}
          onInput={() => {}}
          onResize={() => {}}
        />,
      );
      expect(xterm.instances[0].options).toEqual(before);
      expect(fit).not.toHaveBeenCalled();
    });
  });
});

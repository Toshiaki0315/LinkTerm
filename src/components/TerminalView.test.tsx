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
    clearSelection = vi.fn();
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
const search = vi.hoisted(() => ({
  instances: [] as Array<{
    findNext: ReturnType<typeof vi.fn>;
    findPrevious: ReturnType<typeof vi.fn>;
    clearDecorations: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext = vi.fn(() => true);
    findPrevious = vi.fn(() => true);
    clearDecorations = vi.fn();
    constructor() {
      search.instances.push(this);
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
import { THEMES } from "../lib/themes";

beforeEach(() => {
  xterm.instances.length = 0;
  search.instances.length = 0;
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
      theme: "dark" as const,
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

  describe("配色テーマ", () => {
    const base = {
      fontFamily: "Menlo",
      fontSize: 13,
      scrollback: 100,
      cursorBlink: true,
    };

    it("指定したテーマの配色で生成する（既定はダーク）", () => {
      render(<TerminalView active onInput={() => {}} onResize={() => {}} />);
      expect(xterm.instances[0].options.theme).toEqual(THEMES.dark.xterm);
    });

    it("テーマ指定つきの外観を反映する", () => {
      render(
        <TerminalView
          active
          appearance={{ ...base, theme: "solarized-light" }}
          onInput={() => {}}
          onResize={() => {}}
        />,
      );
      expect(xterm.instances[0].options.theme).toEqual(
        THEMES["solarized-light"].xterm,
      );
    });

    it("テーマが変わったら作り直さずに反映する。同じなら触らない", () => {
      const { rerender } = render(
        <TerminalView
          active
          appearance={{ ...base, theme: "dark" }}
          onInput={() => {}}
          onResize={() => {}}
        />,
      );
      rerender(
        <TerminalView
          active
          appearance={{ ...base, theme: "dracula" }}
          onInput={() => {}}
          onResize={() => {}}
        />,
      );
      expect(xterm.instances).toHaveLength(1);
      expect(xterm.instances[0].options.theme).toEqual(THEMES.dracula.xterm);
      const before = xterm.instances[0].options.theme;
      rerender(
        <TerminalView
          active
          appearance={{ ...base, theme: "dracula" }}
          onInput={() => {}}
          onResize={() => {}}
        />,
      );
      expect(xterm.instances[0].options.theme).toBe(before);
    });

    it("端末の外側（余白）も背景色にそろえる", () => {
      const { container } = render(
        <TerminalView
          active
          appearance={{ ...base, theme: "light" }}
          onInput={() => {}}
          onResize={() => {}}
        />,
      );
      expect(
        (container.firstChild as HTMLElement).style.backgroundColor,
      ).not.toBe("");
    });
  });

  describe("検索", () => {
    const opts = { caseSensitive: true, regex: false };

    function mount() {
      const ref = createRef<TerminalHandle>();
      render(
        <TerminalView
          ref={ref}
          active
          onInput={() => {}}
          onResize={() => {}}
        />,
      );
      return ref.current!;
    }

    it("検索アドオンを読み込む", () => {
      mount();
      expect(search.instances).toHaveLength(1);
      expect(xterm.instances[0].loadAddon).toHaveBeenCalledWith(
        search.instances[0],
      );
    });

    it("次・前の一致を探し、結果（一致の有無）を返す", () => {
      const handle = mount();
      expect(handle.find("err", opts, "next", true)).toBe(true);
      expect(search.instances[0].findNext).toHaveBeenCalledWith("err", {
        caseSensitive: true,
        regex: false,
        incremental: true,
      });
      search.instances[0].findPrevious.mockReturnValue(false);
      expect(handle.find("err", opts, "previous", false)).toBe(false);
      expect(search.instances[0].findPrevious).toHaveBeenCalledWith("err", {
        caseSensitive: true,
        regex: false,
        incremental: false,
      });
    });

    it("検索を消すと、強調表示と選択を解除する", () => {
      const handle = mount();
      handle.clearSearch();
      expect(search.instances[0].clearDecorations).toHaveBeenCalled();
      expect(xterm.instances[0].clearSelection).toHaveBeenCalled();
    });
  });
});

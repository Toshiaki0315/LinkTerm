import { createRef } from "react";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    bell?: () => void;
  } = {};
  /** 次に作る端末が持つ、画面バッファの偽物。 */
  const next: { buffer?: unknown } = {};
  return { instances, handlers, next };
});

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    open = vi.fn();
    write = vi.fn();
    focus = vi.fn();
    clearSelection = vi.fn();
    hasSelection = vi.fn(() => false);
    getSelection = vi.fn(() => "");
    selectAll = vi.fn();
    clear = vi.fn();
    paste = vi.fn();
    dispose = vi.fn();
    loadAddon = vi.fn();
    onData = vi.fn((cb: (d: string) => void) => {
      xterm.handlers.data = cb;
      return { dispose: vi.fn() };
    });
    onBell = vi.fn((cb: () => void) => {
      xterm.handlers.bell = cb;
      return { dispose: vi.fn() };
    });
    onResize = vi.fn((cb: (s: { cols: number; rows: number }) => void) => {
      xterm.handlers.resize = cb;
      return { dispose: vi.fn() };
    });
    options: Record<string, unknown>;
    /** 試験が差し込む、画面バッファの偽物（なければ、ハイライトは使われない）。 */
    buffer: unknown = xterm.next.buffer;
    registerMarker = vi.fn(() => ({
      line: 0,
      isDisposed: false,
      dispose: vi.fn(),
    }));
    registerDecoration = vi.fn(() => ({ dispose: vi.fn() }));
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
const links = vi.hoisted(() => ({
  handlers: [] as Array<(event: MouseEvent, uri: string) => void>,
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    constructor(handler: (event: MouseEvent, uri: string) => void) {
      links.handlers.push(handler);
    }
  },
}));
const clipboard = vi.hoisted(() => ({ copyText: vi.fn() }));
vi.mock("../lib/clipboard", () => clipboard);
const opener = vi.hoisted(() => ({ openExternalUrl: vi.fn() }));
vi.mock("../lib/open-url", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/open-url")>()),
  openExternalUrl: opener.openExternalUrl,
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
  links.handlers.length = 0;
  clipboard.copyText.mockReset().mockResolvedValue(undefined);
  opener.openExternalUrl.mockReset().mockResolvedValue(undefined);
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
    expect(xterm.instances[0].write).toHaveBeenCalledWith(
      bytes,
      expect.any(Function),
    );
  });

  describe("キーワードのハイライト", () => {
    const rules = [
      {
        id: "r",
        pattern: "ERROR",
        regex: false,
        caseSensitive: false,
        color: "red" as const,
        notify: false,
      },
    ];
    /** 1文字1セルの偽のバッファ。 */
    const bufferOf = (lines: string[]) => ({
      active: {
        type: "normal",
        baseY: 0,
        get cursorY() {
          return lines.length - 1;
        },
        get length() {
          return lines.length;
        },
        getLine: (y: number) => ({
          isWrapped: false,
          getCell: (x: number) => ({
            getChars: () => lines[y]?.[x] ?? "",
            getWidth: () => 1,
          }),
        }),
      },
    });

    afterEach(() => {
      xterm.next.buffer = undefined;
    });

    it("規則を渡すと、すでにある行の一致に、列・幅・色を指定した装飾を付ける", () => {
      xterm.next.buffer = bufferOf(["x ERROR y"]);
      render(
        <TerminalView
          active
          highlightRules={rules}
          onInput={() => {}}
          onResize={() => {}}
        />,
      );
      const term = xterm.instances[0] as unknown as {
        registerDecoration: ReturnType<typeof vi.fn>;
      };
      expect(term.registerDecoration).toHaveBeenCalledTimes(1);
      expect(term.registerDecoration.mock.calls[0][0]).toMatchObject({
        x: 2,
        width: 5,
        backgroundColor: "#ef4444",
        foregroundColor: "#ffffff",
      });
    });

    it("書き込みが画面に反映されたあとで、新しい行を調べる", () => {
      const lines = ["ok"];
      xterm.next.buffer = bufferOf(lines);
      const ref = createRef<TerminalHandle>();
      render(
        <TerminalView
          ref={ref}
          active
          highlightRules={rules}
          onInput={() => {}}
          onResize={() => {}}
        />,
      );
      const term = xterm.instances[0] as unknown as {
        registerDecoration: ReturnType<typeof vi.fn>;
        write: ReturnType<typeof vi.fn>;
      };
      expect(term.registerDecoration).not.toHaveBeenCalled();
      ref.current!.write(new TextEncoder().encode("ERROR\n"));
      // 画面への反映（コールバック）の前に調べても、まだ何も付かない。
      lines[0] = "ERROR";
      expect(term.registerDecoration).not.toHaveBeenCalled();
      (term.write.mock.lastCall![1] as () => void)();
      expect(term.registerDecoration).toHaveBeenCalledTimes(1);
    });

    it("続けて出力が届いても、画面の走査は一定の間隔に1回にまとめる", () => {
      vi.useFakeTimers();
      try {
        const lines = ["ok"];
        xterm.next.buffer = bufferOf(lines);
        const ref = createRef<TerminalHandle>();
        render(
          <TerminalView
            ref={ref}
            active
            highlightRules={rules}
            onInput={() => {}}
            onResize={() => {}}
          />,
        );
        const term = xterm.instances[0] as unknown as {
          registerDecoration: ReturnType<typeof vi.fn>;
          write: ReturnType<typeof vi.fn>;
        };
        const write = (text: string) => {
          lines.push(text);
          ref.current!.write(new TextEncoder().encode(`${text}\n`));
          (term.write.mock.lastCall![1] as () => void)();
        };
        write("ERROR a"); // 最初はすぐ調べる
        expect(term.registerDecoration).toHaveBeenCalledTimes(1);
        write("ERROR b");
        write("ERROR c"); // 間隔内なので、まとめて後で
        expect(term.registerDecoration).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(60);
        // 間隔が空いてから、まとめて調べる（偽のマーカーは位置が合わないため、件数は下限だけ確かめる）。
        expect(
          term.registerDecoration.mock.calls.length,
        ).toBeGreaterThanOrEqual(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("規則を空にすると装飾を外す", () => {
      xterm.next.buffer = bufferOf(["ERROR"]);
      const { rerender } = render(
        <TerminalView
          active
          highlightRules={rules}
          onInput={() => {}}
          onResize={() => {}}
        />,
      );
      const term = xterm.instances[0] as unknown as {
        registerDecoration: ReturnType<typeof vi.fn>;
      };
      const decoration = term.registerDecoration.mock.results[0].value as {
        dispose: ReturnType<typeof vi.fn>;
      };
      rerender(
        <TerminalView
          active
          highlightRules={[]}
          onInput={() => {}}
          onResize={() => {}}
        />,
      );
      expect(decoration.dispose).toHaveBeenCalled();
    });

    it("タイムスタンプ表示をオンにした後に出た行の右端へ、時刻の装飾を付ける", () => {
      const lines = ["base"];
      const buffer = {
        active: {
          type: "normal",
          baseY: 0,
          get cursorY() {
            return lines.length - 1;
          },
          length: 1,
          getLine: (y: number) => ({
            isWrapped: false,
            getCell: (x: number) => ({
              getChars: () => lines[y]?.[x] ?? "",
              getWidth: () => 1,
            }),
          }),
        },
      };
      xterm.next.buffer = buffer;
      const ref = createRef<TerminalHandle>();
      const { rerender } = render(
        <TerminalView
          ref={ref}
          active
          onInput={() => {}}
          onResize={() => {}}
        />,
      );
      const term = xterm.instances[0] as unknown as {
        registerDecoration: ReturnType<typeof vi.fn>;
        write: ReturnType<typeof vi.fn>;
      };
      rerender(
        <TerminalView
          ref={ref}
          active
          showTimestamps
          onInput={() => {}}
          onResize={() => {}}
        />,
      );
      lines.push("new output");
      ref.current!.write(new TextEncoder().encode("new output\n"));
      (term.write.mock.lastCall![1] as () => void)();
      expect(term.registerDecoration).toHaveBeenCalledTimes(1);
      expect(term.registerDecoration.mock.calls[0][0]).toMatchObject({
        anchor: "right",
        width: 9,
      });
      // オフにすると外す。
      const decoration = term.registerDecoration.mock.results[0].value as {
        dispose: ReturnType<typeof vi.fn>;
      };
      rerender(
        <TerminalView
          ref={ref}
          active
          showTimestamps={false}
          onInput={() => {}}
          onResize={() => {}}
        />,
      );
      expect(decoration.dispose).toHaveBeenCalled();
    });

    it("バッファを持たない端末でも、書き込みは動く", () => {
      xterm.next.buffer = undefined;
      const ref = createRef<TerminalHandle>();
      render(
        <TerminalView
          ref={ref}
          active
          highlightRules={rules}
          onInput={() => {}}
          onResize={() => {}}
        />,
      );
      expect(() => {
        ref.current!.write(new Uint8Array([0x61]));
        (xterm.instances[0].write.mock.lastCall![1] as () => void)();
      }).not.toThrow();
    });
  });

  it("ベル（BEL）が鳴ったら通知する。最新の通知先を使う", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(
      <TerminalView
        active
        onBell={first}
        onInput={() => {}}
        onResize={() => {}}
      />,
    );
    xterm.handlers.bell!();
    expect(first).toHaveBeenCalledTimes(1);
    rerender(
      <TerminalView
        active
        onBell={second}
        onInput={() => {}}
        onResize={() => {}}
      />,
    );
    xterm.handlers.bell!();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
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
      cursorStyle: "block" as const,
      backspaceKey: "del" as const,
      optionIsMeta: false,
      theme: "dark" as const,
      copyOnSelect: false,
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
        cursorStyle: "block" as const,
        macOptionIsMeta: false,
      });
    });

    it("指定がなければ既定の外観を使う", () => {
      render(<TerminalView active onInput={() => {}} onResize={() => {}} />);
      expect(xterm.instances[0].options).toMatchObject({
        fontSize: 13,
        scrollback: 10000,
        cursorBlink: true,
        cursorStyle: "block" as const,
        macOptionIsMeta: false,
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
            cursorStyle: "block" as const,
            backspaceKey: "del" as const,
            optionIsMeta: false,
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
        cursorStyle: "block" as const,
        macOptionIsMeta: false,
      });
      expect(fit).toHaveBeenCalled();
    });

    it("バックスペースキーの設定に応じて DEL を BS に置き換えて送る", () => {
      const onInput = vi.fn();
      const { rerender } = render(
        <TerminalView
          active
          appearance={appearance}
          onInput={onInput}
          onResize={() => {}}
        />,
      );
      xterm.handlers.data?.("\x7f");
      expect(onInput).toHaveBeenLastCalledWith("\x7f");
      rerender(
        <TerminalView
          active
          appearance={{ ...appearance, backspaceKey: "bs" as const }}
          onInput={onInput}
          onResize={() => {}}
        />,
      );
      xterm.handlers.data?.("\x7f");
      expect(onInput).toHaveBeenLastCalledWith("\x08");
      xterm.handlers.data?.("a");
      expect(onInput).toHaveBeenLastCalledWith("a");
    });

    it("カーソルの形と Option キーの設定を xterm に反映する", () => {
      const { rerender } = render(
        <TerminalView
          active
          appearance={appearance}
          onInput={() => {}}
          onResize={() => {}}
        />,
      );
      rerender(
        <TerminalView
          active
          appearance={{
            ...appearance,
            cursorStyle: "bar" as const,
            optionIsMeta: true,
          }}
          onInput={() => {}}
          onResize={() => {}}
        />,
      );
      expect(xterm.instances[0].options).toMatchObject({
        cursorStyle: "bar",
        macOptionIsMeta: true,
      });
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
      cursorStyle: "block" as const,
      backspaceKey: "del" as const,
      optionIsMeta: false,
      copyOnSelect: false,
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

  describe("コピー・貼り付け・右クリック・URL", () => {
    const appearance = {
      fontFamily: "Menlo",
      fontSize: 13,
      scrollback: 100,
      cursorBlink: true,
      cursorStyle: "block" as const,
      backspaceKey: "del" as const,
      optionIsMeta: false,
      theme: "dark" as const,
    };

    function mount(copyOnSelect = false, onContextMenu = vi.fn()) {
      const ref = createRef<TerminalHandle>();
      const { container } = render(
        <TerminalView
          ref={ref}
          active
          appearance={{ ...appearance, copyOnSelect }}
          onInput={() => {}}
          onResize={() => {}}
          onContextMenu={onContextMenu}
        />,
      );
      return {
        handle: ref.current!,
        root: container.firstChild as HTMLElement,
        onContextMenu,
      };
    }

    it("選択したらコピー: オンのとき、マウスを離した時点の選択をコピーする", () => {
      const { root } = mount(true);
      const term = xterm.instances[0];
      term.hasSelection.mockReturnValue(true);
      term.getSelection.mockReturnValue("selected text");
      fireEvent.mouseUp(root);
      expect(clipboard.copyText).toHaveBeenCalledWith("selected text");
    });

    it("選択がなければコピーしない（クリップボードを書き換えない）", () => {
      const { root } = mount(true);
      fireEvent.mouseUp(root);
      expect(clipboard.copyText).not.toHaveBeenCalled();
    });

    it("オフのときは、選択してもコピーしない", () => {
      const { root } = mount(false);
      const term = xterm.instances[0];
      term.hasSelection.mockReturnValue(true);
      term.getSelection.mockReturnValue("selected text");
      fireEvent.mouseUp(root);
      expect(clipboard.copyText).not.toHaveBeenCalled();
    });

    it("コピーの失敗は握りつぶさずコンソールに残す（画面は壊さない）", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      clipboard.copyText.mockRejectedValue(new Error("denied"));
      const { root } = mount(true);
      xterm.instances[0].hasSelection.mockReturnValue(true);
      xterm.instances[0].getSelection.mockReturnValue("x");
      fireEvent.mouseUp(root);
      await waitFor(() => expect(spy).toHaveBeenCalled());
      spy.mockRestore();
    });

    it("ハンドルから選択の取得・全選択・クリア・貼り付けができる", () => {
      const { handle } = mount();
      const term = xterm.instances[0];
      term.hasSelection.mockReturnValue(true);
      term.getSelection.mockReturnValue("abc");
      expect(handle.hasSelection()).toBe(true);
      expect(handle.getSelection()).toBe("abc");
      handle.selectAll();
      expect(term.selectAll).toHaveBeenCalled();
      handle.clear();
      expect(term.clear).toHaveBeenCalled();
      handle.paste("pasted\ntext");
      expect(term.paste).toHaveBeenCalledWith("pasted\ntext");
    });

    it("右クリックで、ブラウザ標準のメニューではなく、位置つきで通知する", () => {
      const { root, onContextMenu } = mount();
      const notPrevented = fireEvent.contextMenu(root, {
        clientX: 40,
        clientY: 55,
      });
      expect(notPrevented).toBe(false); // preventDefault された
      expect(onContextMenu).toHaveBeenCalledWith({ x: 40, y: 55 });
    });

    it("URL: ⌘+クリックで開く。⌘なしのクリック（選択操作）では開かない", () => {
      mount();
      const open = links.handlers[0];
      open(new MouseEvent("click", { metaKey: false }), "https://example.com");
      expect(opener.openExternalUrl).not.toHaveBeenCalled();
      open(new MouseEvent("click", { metaKey: true }), "https://example.com");
      expect(opener.openExternalUrl).toHaveBeenCalledWith(
        "https://example.com",
      );
    });

    it("URL: http / https 以外は、⌘+クリックでも開かない", () => {
      mount();
      const open = links.handlers[0];
      open(new MouseEvent("click", { metaKey: true }), "javascript:alert(1)");
      open(new MouseEvent("click", { metaKey: true }), "file:///etc/passwd");
      expect(opener.openExternalUrl).not.toHaveBeenCalled();
    });

    it("OSC 8 のリンク（出力が埋め込んだリンク）も、⌘+クリックで開く。http / https 以外は開かない", () => {
      mount();
      const handler = xterm.instances[0].options.linkHandler as {
        activate: (e: MouseEvent, text: string) => void;
      };
      handler.activate(new MouseEvent("click"), "https://example.com/a");
      expect(opener.openExternalUrl).not.toHaveBeenCalled();
      handler.activate(
        new MouseEvent("click", { metaKey: true }),
        "https://example.com/a",
      );
      expect(opener.openExternalUrl).toHaveBeenCalledWith(
        "https://example.com/a",
      );
      opener.openExternalUrl.mockClear();
      handler.activate(
        new MouseEvent("click", { metaKey: true }),
        "javascript:alert(1)",
      );
      expect(opener.openExternalUrl).not.toHaveBeenCalled();
    });

    it("URLを開けなかった場合はコンソールに残す", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      opener.openExternalUrl.mockRejectedValue(new Error("no browser"));
      mount();
      links.handlers[0](
        new MouseEvent("click", { metaKey: true }),
        "https://example.com",
      );
      await waitFor(() => expect(spy).toHaveBeenCalled());
      spy.mockRestore();
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

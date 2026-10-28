import { Fragment, useEffect, useRef } from "react";
import { cn } from "../lib/utils";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** 色見本（CSS の色）。付けると色つきの選択肢として表示する。 */
  swatch?: string;
  /** 選択済みの選択肢か。指定すると（色見本がなくても）ラジオ項目として扱う。 */
  checked?: boolean;
  /** 付けると、この項目の上に区切り線を引く。 */
  separatorBefore?: boolean;
}

interface Props {
  /** 画面上（ビューポート）の表示位置。 */
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

const ITEM_HEIGHT = 32;
const MENU_WIDTH = 200;
const SEPARATOR_HEIGHT = 9;

/** 右クリックメニュー。Esc・外側のクリック・スクロールで閉じ、↑↓Enter で操作できる。 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const buttons = () =>
      Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        ) ?? [],
      );
    buttons()[0]?.focus();

    const onPointerDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const list = buttons();
        if (list.length === 0) return;
        const current = list.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const step = e.key === "ArrowDown" ? 1 : -1;
        list[(current + step + list.length) % list.length].focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  // 画面の端からはみ出さないようにずらす。
  const left = Math.max(0, Math.min(x, window.innerWidth - MENU_WIDTH));
  const top = Math.max(
    0,
    Math.min(
      y,
      window.innerHeight -
        items.length * ITEM_HEIGHT -
        items.filter((i) => i.separatorBefore).length * SEPARATOR_HEIGHT -
        8,
    ),
  );

  return (
    <div
      ref={menuRef}
      role="menu"
      style={{ left, top, minWidth: MENU_WIDTH }}
      className="fixed z-50 rounded-md border border-neutral-700 bg-neutral-900 py-1 text-sm shadow-xl"
    >
      {items.map((item, index) => (
        <Fragment key={`${index}:${item.label}`}>
          {item.separatorBefore && (
            <div
              role="separator"
              className="my-1 h-px bg-neutral-700"
              style={{ height: 1 }}
            />
          )}
          <button
            role={
              item.swatch !== undefined || item.checked !== undefined
                ? "menuitemradio"
                : "menuitem"
            }
            aria-checked={
              item.swatch !== undefined || item.checked !== undefined
                ? Boolean(item.checked)
                : undefined
            }
            disabled={item.disabled}
            className={cn(
              "block w-full px-3 text-left hover:bg-neutral-800 focus:bg-neutral-800 focus:outline-none disabled:opacity-40 disabled:hover:bg-transparent",
            )}
            style={{ height: ITEM_HEIGHT }}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            {item.swatch !== undefined || item.checked !== undefined ? (
              <span className="flex items-center gap-2">
                {item.swatch !== undefined && (
                  <span
                    aria-hidden
                    className="h-3 w-3 rounded-full border border-neutral-600"
                    style={{ backgroundColor: item.swatch }}
                  />
                )}
                {item.label}
                {item.checked && <span aria-hidden>✓</span>}
              </span>
            ) : (
              item.label
            )}
          </button>
        </Fragment>
      ))}
    </div>
  );
}

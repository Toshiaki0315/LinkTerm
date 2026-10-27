import { useEffect, useRef } from "react";
import { cn } from "../lib/utils";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
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
    Math.min(y, window.innerHeight - items.length * ITEM_HEIGHT - 8),
  );

  return (
    <div
      ref={menuRef}
      role="menu"
      style={{ left, top, minWidth: MENU_WIDTH }}
      className="fixed z-50 rounded-md border border-neutral-700 bg-neutral-900 py-1 text-sm shadow-xl"
    >
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
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
          {item.label}
        </button>
      ))}
    </div>
  );
}

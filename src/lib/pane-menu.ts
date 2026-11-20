import { useSyncExternalStore } from "react";
import type { ContextMenuItem } from "../components/ContextMenu";

/**
 * ペインごとの操作メニュー（タブバーの「⋯」に出す）。
 * 各ペインが、自分の種類・状態に応じた項目を公開し、タブバー側が操作中のペインのものを読む。
 */
export interface PaneMenu {
  items: ContextMenuItem[];
  /** セッションのログを記録中か（「⋯」に印を付ける）。 */
  recording: boolean;
}

const menus = new Map<string, PaneMenu>();
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((l) => l());

/** 公開する。戻り値で解除する（同じ ID を別の公開が上書きしていたら解除しない）。 */
export function publishPaneMenu(paneId: string, menu: PaneMenu): () => void {
  menus.set(paneId, menu);
  notify();
  return () => {
    if (menus.get(paneId) === menu) {
      menus.delete(paneId);
      notify();
    }
  };
}

export const getPaneMenu = (paneId: string): PaneMenu | undefined =>
  menus.get(paneId);

export function subscribePaneMenus(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 見た目（ラベル・状態）が同じか調べるための文字列。関数（選んだときの処理）は含めない。 */
export const menuSignature = (menu: PaneMenu): string =>
  JSON.stringify([
    menu.recording,
    menu.items.map((i) => [
      i.label,
      i.disabled ?? false,
      i.checked ?? null,
      i.separatorBefore ?? false,
    ]),
  ]);

/** 操作中のペインのメニュー。ペインがなければ `undefined`。 */
export function usePaneMenu(paneId: string | null): PaneMenu | undefined {
  return useSyncExternalStore(subscribePaneMenus, () =>
    paneId === null ? undefined : getPaneMenu(paneId),
  );
}

import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";

/**
 * ファイルのドロップを、ほかの画面（SFTP の転送など）が使っている間は、
 * 端末への貼り付けをしないための印。
 */
let claims = 0;

/** ドロップを取り込む。戻り値で解除する（同じ解除を重ねて呼んでも、1回しか数えない）。 */
export function claimFileDrops(): () => void {
  claims += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    claims -= 1;
  };
}

export const filesDropClaimed = (): boolean => claims > 0;

/** ドロップした座標（ウィンドウ内、物理ピクセル）の下にあるペインの ID。ペインの外なら `null`。 */
export function paneIdAt(
  position: { x: number; y: number },
  devicePixelRatio: number,
  elementAt: (x: number, y: number) => Element | null = (x, y) =>
    document.elementFromPoint(x, y),
): string | null {
  const el = elementAt(
    position.x / devicePixelRatio,
    position.y / devicePixelRatio,
  );
  return el?.closest("[data-pane-id]")?.getAttribute("data-pane-id") ?? null;
}

/** ファイル・フォルダーがウィンドウへドロップされたとき、パスと座標を渡す。 */
export const onFilesDroppedAt = (
  cb: (paths: string[], position: { x: number; y: number }) => void,
): Promise<UnlistenFn> =>
  getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "drop") {
      cb(event.payload.paths, event.payload.position);
    }
  });

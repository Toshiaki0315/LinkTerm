import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

/** 同じ規則の通知を出す最小の間隔（ミリ秒）。連続した出力で通知が溢れないようにする。 */
export const NOTIFY_INTERVAL_MS = 5000;

/** キーごとに、一定の間隔を空けて許可する。 */
export class Throttle {
  private last = new Map<string, number>();

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** いま実行してよいか。許可した時刻を記録する。 */
  allow(key: string): boolean {
    const t = this.now();
    const prev = this.last.get(key);
    if (prev !== undefined && t - prev < this.intervalMs) return false;
    this.last.set(key, t);
    return true;
  }
}

/**
 * macOS の通知を出す（初回は許可を求める）。許可されなければ何もしない。
 * 画面の内容（秘密情報を含みうる）は通知に載せず、見つけた語と接続先だけを伝える。
 */
export async function notifyMatch(
  title: string,
  body: string,
): Promise<boolean> {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (!granted) return false;
  sendNotification({ title, body });
  return true;
}

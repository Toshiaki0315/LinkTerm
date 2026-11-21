import {
  exportProfilesDialog,
  importProfilesDialog,
  type ImportReport,
} from "./terminal-api";

/**
 * 保存済みの接続を、保存ダイアログで選んだ場所へ書き出す（パスワード類は含めない）。
 * ダイアログはバックエンドが開く（画面は保存先のパスを指定できない）。キャンセルなら `null`。
 */
export const exportProfilesToFile = (): Promise<{
  path: string;
  count: number;
} | null> => exportProfilesDialog();

/** ファイルを選んで、保存済みの接続を取り込む。キャンセルなら `null`。 */
export const importProfilesFromFile = (): Promise<ImportReport | null> =>
  importProfilesDialog();

/** 取り込みの結果を、利用者向けの文にする。 */
export function describeImport({ added, skipped }: ImportReport): string {
  if (added === 0) {
    return skipped === 0
      ? "取り込む接続はありませんでした"
      : `取り込む接続はありませんでした（同じ内容の${skipped}件はすでにあります）`;
  }
  return skipped === 0
    ? `${added}件を取り込みました`
    : `${added}件を取り込みました（同じ内容の${skipped}件は取り込みませんでした）`;
}

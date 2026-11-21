import { open, save } from "@tauri-apps/plugin-dialog";
import {
  exportProfiles,
  importProfiles,
  type ImportReport,
} from "./terminal-api";

const JSON_FILTER = { name: "LinkTerm の接続", extensions: ["json"] };

/**
 * 保存ダイアログで選んだ場所へ、保存済みの接続を書き出す（パスワード類は含めない）。
 * キャンセルなら `null`。
 */
export async function exportProfilesToFile(): Promise<{
  path: string;
  count: number;
} | null> {
  const path = await save({
    defaultPath: "linkterm-profiles.json",
    filters: [JSON_FILTER],
  });
  if (path === null) return null;
  const count = await exportProfiles(path);
  return { path, count };
}

/** ファイルを選んで、保存済みの接続を取り込む。キャンセルなら `null`。 */
export async function importProfilesFromFile(): Promise<ImportReport | null> {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [JSON_FILTER, { name: "すべてのファイル", extensions: ["*"] }],
  });
  if (picked === null) return null;
  const path = Array.isArray(picked) ? picked[0] : picked;
  return importProfiles(path);
}

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

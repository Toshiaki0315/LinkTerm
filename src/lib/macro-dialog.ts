import { useSyncExternalStore } from "react";

/**
 * マクロが出すダイアログ（確認・入力・パスワード）の待ち行列。
 * 実行するペインが要求を出し、画面（`MacroDialogHost`）が1つずつ表示して答えを返す。
 */
export type MacroDialogRequest =
  | { kind: "message"; message: string; title: string }
  | { kind: "yesno"; message: string; title: string }
  | { kind: "input"; message: string; title: string; initial: string }
  | { kind: "password"; message: string; title: string };

export type MacroDialogAnswer = undefined | boolean | string | null;

export interface PendingMacroDialog {
  id: number;
  /** どのマクロ（実行）が出した要求か。停止したときに取り消すために使う。 */
  owner: string;
  request: MacroDialogRequest;
}

interface Entry extends PendingMacroDialog {
  resolve: (answer: MacroDialogAnswer) => void;
}

let nextId = 1;
let queue: Entry[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

type AnswerOf<R extends MacroDialogRequest> = R extends { kind: "message" }
  ? undefined
  : R extends { kind: "yesno" }
    ? boolean
    : string | null;

/** ダイアログを出し、答えを待つ。 */
export function showMacroDialog<R extends MacroDialogRequest>(
  owner: string,
  request: R,
): Promise<AnswerOf<R>> {
  return new Promise((resolve) => {
    queue = [
      ...queue,
      {
        id: nextId++,
        owner,
        request,
        resolve: resolve as (a: MacroDialogAnswer) => void,
      },
    ];
    notify();
  });
}

/** 表示中のダイアログに答える。存在しない ID は無視する。 */
export function answerMacroDialog(id: number, answer: MacroDialogAnswer): void {
  const entry = queue.find((e) => e.id === id);
  if (!entry) return;
  queue = queue.filter((e) => e !== entry);
  entry.resolve(answer);
  notify();
}

/** そのマクロの未回答の要求をすべて取り消す（いいえ・キャンセルとして解決する）。 */
export function cancelMacroDialogs(owner: string): void {
  const mine = queue.filter((e) => e.owner === owner);
  if (mine.length === 0) return;
  queue = queue.filter((e) => e.owner !== owner);
  for (const e of mine) {
    e.resolve(
      e.request.kind === "yesno"
        ? false
        : e.request.kind === "message"
          ? undefined
          : null,
    );
  }
  notify();
}

export const getCurrentMacroDialog = (): PendingMacroDialog | undefined =>
  queue[0];

export function subscribeMacroDialogs(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 表示するダイアログ（なければ `undefined`）。 */
export function useCurrentMacroDialog(): PendingMacroDialog | undefined {
  return useSyncExternalStore(subscribeMacroDialogs, getCurrentMacroDialog);
}

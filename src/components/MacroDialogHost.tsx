import { useState } from "react";
import {
  answerMacroDialog,
  useCurrentMacroDialog,
  type PendingMacroDialog,
} from "../lib/macro-dialog";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

/** 入力欄つきのダイアログ。要求ごとに作り直す（前の入力を引き継がない）。 */
function PromptBody({
  pending,
  secret,
}: {
  pending: PendingMacroDialog;
  secret: boolean;
}) {
  const request = pending.request;
  const [value, setValue] = useState(
    request.kind === "input" ? request.initial : "",
  );
  return (
    <form
      className="mt-4 grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        answerMacroDialog(pending.id, value);
      }}
    >
      <div className="grid gap-1">
        <Label htmlFor="macro-prompt">{request.message}</Label>
        <Input
          id="macro-prompt"
          autoFocus
          type={secret ? "password" : "text"}
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => answerMacroDialog(pending.id, null)}
        >
          キャンセル
        </Button>
        <Button type="submit">OK</Button>
      </div>
    </form>
  );
}

/**
 * マクロが出すダイアログ（確認・入力・パスワード）を、1つずつ表示する。
 * 閉じる操作（Esc・外側のクリック）は、「いいえ」「キャンセル」として扱う。
 */
export function MacroDialogHost() {
  const pending = useCurrentMacroDialog();
  if (!pending) return null;
  const { request } = pending;
  const dismiss = () =>
    answerMacroDialog(
      pending.id,
      request.kind === "yesno"
        ? false
        : request.kind === "message"
          ? undefined
          : null,
    );
  return (
    <Dialog open onOpenChange={(open) => !open && dismiss()}>
      <DialogContent key={pending.id} className="max-w-md">
        <DialogTitle>{request.title || "マクロ"}</DialogTitle>
        {(request.kind === "message" || request.kind === "yesno") && (
          <>
            <DialogDescription className="mt-2 whitespace-pre-wrap">
              {request.message}
            </DialogDescription>
            <div className="mt-4 flex justify-end gap-2">
              {request.kind === "yesno" ? (
                <>
                  <Button
                    variant="outline"
                    onClick={() => answerMacroDialog(pending.id, false)}
                  >
                    いいえ
                  </Button>
                  <Button onClick={() => answerMacroDialog(pending.id, true)}>
                    はい
                  </Button>
                </>
              ) : (
                <Button
                  onClick={() => answerMacroDialog(pending.id, undefined)}
                >
                  OK
                </Button>
              )}
            </div>
          </>
        )}
        {(request.kind === "input" || request.kind === "password") && (
          <>
            <DialogDescription className="sr-only">
              マクロの入力
            </DialogDescription>
            <PromptBody
              pending={pending}
              secret={request.kind === "password"}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

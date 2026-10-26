import type { HostKeyRequest } from "../lib/terminal-api";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";

interface Props {
  request: HostKeyRequest | null;
  onRespond: (requestId: string, approved: boolean) => void;
}

/** 未知のSSHホスト鍵の承認ダイアログ。閉じる操作は拒否として扱う（安全側）。 */
export function HostKeyDialog({ request, onRespond }: Props) {
  if (!request) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onRespond(request.requestId, false)}
    >
      <DialogContent>
        <DialogTitle>未知のホストです</DialogTitle>
        <DialogDescription className="mt-2">
          {request.host}:{request.port}{" "}
          のホスト鍵を初めて確認しました。フィンガープリントが正しいことを確認してから接続してください。
        </DialogDescription>
        <code className="mt-4 block break-all rounded bg-neutral-800 p-2 text-xs">
          {request.fingerprint}
        </code>
        <div className="mt-6 flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onRespond(request.requestId, false)}
          >
            キャンセル
          </Button>
          <Button onClick={() => onRespond(request.requestId, true)}>
            信頼して接続
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

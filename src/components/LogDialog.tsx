import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import type { LogConfig } from "../lib/terminal-api";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import { Input, Select } from "./ui/input";
import { Label } from "./ui/label";

const logSchema = z.object({
  path: z.string().trim().min(1, "保存先を入力してください"),
  mode: z.enum(["Text", "Raw"]),
  timestamps: z.boolean(),
  append: z.boolean(),
});

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultPath: string;
  /** 記録の開始。失敗（reject）したらメッセージを表示してダイアログを開いたままにする。 */
  onSubmit: (config: LogConfig) => Promise<void>;
}

export function LogDialog({
  open,
  onOpenChange,
  defaultPath,
  onSubmit,
}: Props) {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LogConfig>({
    resolver: zodResolver(logSchema),
    defaultValues: {
      path: defaultPath,
      mode: "Text",
      timestamps: false,
      append: true,
    },
  });

  const submit = handleSubmit(async (config) => {
    setSubmitError(null);
    try {
      await onSubmit(config);
      onOpenChange(false);
    } catch (e) {
      setSubmitError(
        `ログを開始できません: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>ログ記録</DialogTitle>
        <DialogDescription className="mt-1">
          受信内容をファイルに保存します。ファイルは自分だけが読み書きできる権限で作成されます。
        </DialogDescription>
        <form onSubmit={submit} className="mt-4 grid gap-3" noValidate>
          <div className="grid gap-1">
            <Label htmlFor="log-path">保存先</Label>
            <Input id="log-path" autoComplete="off" {...register("path")} />
            {errors.path && (
              <p role="alert" className="text-xs text-red-400">
                {errors.path.message}
              </p>
            )}
          </div>
          <div className="grid gap-1">
            <Label htmlFor="log-mode">記録形式</Label>
            <Select id="log-mode" {...register("mode")}>
              <option value="Text">テキスト（制御文字を除く）</option>
              <option value="Raw">生データ（受信バイト列そのまま）</option>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" {...register("timestamps")} />
            行頭にタイムスタンプを付ける
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" {...register("append")} />
            既存ファイルに追記する
          </label>
          {submitError && (
            <p role="alert" className="text-xs text-red-400">
              {submitError}
            </p>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              キャンセル
            </Button>
            <Button type="submit">記録開始</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

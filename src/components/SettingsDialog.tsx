import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import {
  DEFAULT_SETTINGS,
  FONT_SUGGESTIONS,
  fontFamilySchema,
  fontSizeSchema,
  scrollbackSchema,
  type Settings,
} from "../lib/settings";
import type { SavedProfile } from "../lib/terminal-api";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import { Input, Select } from "./ui/input";
import { Label } from "./ui/label";

/** フォーム上は起動時の指定を平坦に持ち、保存時に `Settings` へ組み立てる。 */
const formSchema = z
  .object({
    fontFamily: fontFamilySchema,
    fontSize: fontSizeSchema,
    scrollback: scrollbackSchema,
    cursorBlink: z.boolean(),
    startupKind: z.enum(["none", "local", "profile"]),
    startupProfileId: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.startupKind === "profile" && v.startupProfileId.trim() === "") {
      ctx.addIssue({
        code: "custom",
        path: ["startupProfileId"],
        message: "起動時に開く接続を選択してください",
      });
    }
  });

type FormValues = z.input<typeof formSchema>;

const toForm = (s: Settings): FormValues => ({
  fontFamily: s.fontFamily,
  fontSize: s.fontSize,
  scrollback: s.scrollback,
  cursorBlink: s.cursorBlink,
  startupKind: s.startup.kind,
  startupProfileId: s.startup.kind === "profile" ? s.startup.profileId : "",
});

const toSettings = (v: z.output<typeof formSchema>): Settings => ({
  fontFamily: v.fontFamily,
  fontSize: v.fontSize,
  scrollback: v.scrollback,
  cursorBlink: v.cursorBlink,
  startup:
    v.startupKind === "profile"
      ? { kind: "profile", profileId: v.startupProfileId }
      : { kind: v.startupKind },
});

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings;
  profiles: SavedProfile[];
  /** 保存。失敗（reject）したら理由を表示し、ダイアログは開いたままにする。 */
  onSave: (settings: Settings) => Promise<void>;
}

function Row({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: (id: string) => React.ReactNode;
}) {
  const id = `setting-${label}`;
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  profiles,
  onSave,
}: Props) {
  const [saveError, setSaveError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors },
  } = useForm<FormValues, unknown, z.output<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: toForm(settings),
  });

  useEffect(() => {
    // 開くたびに保存済みの設定へ戻す（編集途中の内容を引きずらない）。
    reset(toForm(settings));
  }, [open, settings, reset]);

  const fontFamily = useWatch({ control, name: "fontFamily" });
  const fontSize = useWatch({ control, name: "fontSize" });
  const startupKind = useWatch({ control, name: "startupKind" });

  const submit = handleSubmit(async (values) => {
    setSaveError(null);
    try {
      await onSave(toSettings(values));
      onOpenChange(false);
    } catch (e) {
      setSaveError(
        `設定を保存できません: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogTitle>設定</DialogTitle>
        <DialogDescription className="mt-1">
          フォントやスクロールバックは、開いているターミナルにもすぐ反映されます。
        </DialogDescription>
        <form onSubmit={submit} className="mt-4 grid gap-3" noValidate>
          <Row label="フォント" error={errors.fontFamily?.message}>
            {(id) => (
              <>
                <Input
                  id={id}
                  list="font-suggestions"
                  autoComplete="off"
                  {...register("fontFamily")}
                />
                <datalist id="font-suggestions">
                  {FONT_SUGGESTIONS.map((f) => (
                    <option key={f} value={f} />
                  ))}
                </datalist>
              </>
            )}
          </Row>
          <div className="grid grid-cols-2 gap-2">
            <Row label="フォントサイズ" error={errors.fontSize?.message}>
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  {...register("fontSize", { valueAsNumber: true })}
                />
              )}
            </Row>
            <Row
              label="スクロールバック行数"
              error={errors.scrollback?.message}
            >
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  {...register("scrollback", { valueAsNumber: true })}
                />
              )}
            </Row>
          </div>
          <div
            data-testid="font-preview"
            className="rounded border border-neutral-700 bg-black px-3 py-2 text-neutral-100"
            style={{
              fontFamily,
              fontSize: `${Number.isFinite(fontSize) ? fontSize : DEFAULT_SETTINGS.fontSize}px`,
            }}
          >
            AaBbCc 0O1lI {"{}[]()"} 日本語 あいうえお
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" {...register("cursorBlink")} />
            カーソルを点滅させる
          </label>
          <Row label="起動時に開くターミナル">
            {(id) => (
              <Select id={id} {...register("startupKind")}>
                <option value="none">何も開かない</option>
                <option value="local">ローカルシェル</option>
                <option value="profile">保存済みの接続</option>
              </Select>
            )}
          </Row>
          {startupKind === "profile" &&
            (profiles.length === 0 ? (
              <p className="text-xs text-neutral-400">
                保存済みの接続がありません。接続ダイアログの「この接続を保存する」で保存すると選べます。
              </p>
            ) : (
              <Row
                label="起動時の接続"
                error={errors.startupProfileId?.message}
              >
                {(id) => (
                  <Select id={id} {...register("startupProfileId")}>
                    <option value="">選択してください</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Row>
            ))}
          {startupKind === "profile" &&
            profiles.length === 0 &&
            errors.startupProfileId && (
              <p role="alert" className="text-xs text-red-400">
                {errors.startupProfileId.message}
              </p>
            )}
          {saveError && (
            <p role="alert" className="text-xs text-red-400">
              {saveError}
            </p>
          )}
          <div className="mt-2 flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => reset(toForm(DEFAULT_SETTINGS))}
            >
              初期設定に戻す
            </Button>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                キャンセル
              </Button>
              <Button type="submit">保存</Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

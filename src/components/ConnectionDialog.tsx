import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  useForm,
  useWatch,
  type FieldErrors,
  type Resolver,
} from "react-hook-form";
import {
  connectionSchema,
  defaultConnectionValues,
  ENCODINGS,
  type ConnectionValues,
} from "../lib/connection-schema";
import { listSerialPorts } from "../lib/terminal-api";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import { Input, Select } from "./ui/input";
import { Label } from "./ui/label";

/** フォーム上は全項目を平坦に保持し、種別ごとの検証・切り出しは Zod が行う。 */
interface FormValues {
  type: ConnectionValues["type"];
  encoding: (typeof ENCODINGS)[number];
  host: string;
  port: number;
  username: string;
  authKind: "password" | "keychain" | "keyFile" | "agent";
  password: string;
  remember: boolean;
  keyPath: string;
  passphrase: string;
  txNewline: "Cr" | "Lf" | "CrLf";
  rxNewline: "Raw" | "LfToCrLf" | "CrToCrLf";
  serialPort: string;
  baudRate: number;
  dataBits: "Five" | "Six" | "Seven" | "Eight";
  parity: "None" | "Odd" | "Even";
  stopBits: "One" | "Two";
  flowControl: "None" | "Software" | "Hardware";
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: ConnectionValues) => void;
  loadSerialPorts?: () => Promise<string[]>;
}

const BAUD_RATES = [
  1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
];

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: (id: string) => React.ReactNode;
}) {
  const id = `field-${label}`;
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

const message = (errors: FieldErrors<FormValues>, key: keyof FormValues) =>
  errors[key]?.message as string | undefined;

export function ConnectionDialog({
  open,
  onOpenChange,
  onSubmit,
  loadSerialPorts = listSerialPorts,
}: Props) {
  const {
    register,
    handleSubmit,
    control,
    setValue,
    getValues,
    reset,
    formState: { errors },
  } = useForm<FormValues, unknown, ConnectionValues>({
    resolver: zodResolver(connectionSchema) as unknown as Resolver<
      FormValues,
      unknown,
      ConnectionValues
    >,
    defaultValues: { ...defaultConnectionValues },
  });
  const type = useWatch({ control, name: "type" });
  const authKind = useWatch({ control, name: "authKind" });
  const [portList, setPortList] = useState<{
    ports: string[];
    error: string | null;
  }>({
    ports: [],
    error: null,
  });
  const { ports, error: portsError } = portList;

  useEffect(() => {
    // 閉じたら入力を破棄する（パスワード等の秘密情報をメモリに残さない）。
    if (!open) reset({ ...defaultConnectionValues });
  }, [open, reset]);

  useEffect(() => {
    // 種別に応じた既定ポートへ切り替える（ユーザーが変更済みの値は維持する）。
    const port = getValues("port");
    if (type === "telnet" && port === 22) setValue("port", 23);
    if (type === "ssh" && port === 23) setValue("port", 22);
  }, [type, getValues, setValue]);

  useEffect(() => {
    if (!open || type !== "serial") return;
    let cancelled = false;
    loadSerialPorts()
      .then((ports) => !cancelled && setPortList({ ports, error: null }))
      .catch(
        (e: unknown) =>
          !cancelled &&
          setPortList({
            ports: [],
            error: `ポート一覧を取得できません: ${String(e)}`,
          }),
      );
    return () => {
      cancelled = true;
    };
  }, [open, type, loadSerialPorts]);

  const submit = handleSubmit((values) => {
    onSubmit(values);
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>新しい接続</DialogTitle>
        <DialogDescription className="sr-only">
          接続先の設定を入力してください
        </DialogDescription>
        <form onSubmit={submit} className="mt-4 grid gap-3" noValidate>
          <Field label="接続種別">
            {(id) => (
              <Select id={id} {...register("type")}>
                <option value="local">ローカルシェル</option>
                <option value="ssh">SSH</option>
                <option value="telnet">Telnet</option>
                <option value="serial">シリアル</option>
              </Select>
            )}
          </Field>

          <Field label="エンコーディング">
            {(id) => (
              <Select id={id} {...register("encoding")}>
                {ENCODINGS.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {(type === "ssh" || type === "telnet") && (
            <div className="grid grid-cols-[1fr_6rem] gap-2">
              <Field label="ホスト" error={message(errors, "host")}>
                {(id) => (
                  <Input id={id} autoComplete="off" {...register("host")} />
                )}
              </Field>
              <Field label="ポート" error={message(errors, "port")}>
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    {...register("port", { valueAsNumber: true })}
                  />
                )}
              </Field>
            </div>
          )}

          {type === "ssh" && (
            <>
              <Field label="ユーザー名" error={message(errors, "username")}>
                {(id) => (
                  <Input id={id} autoComplete="off" {...register("username")} />
                )}
              </Field>
              <Field label="認証方式">
                {(id) => (
                  <Select id={id} {...register("authKind")}>
                    <option value="password">パスワード</option>
                    <option value="keychain">
                      Keychainの保存済みパスワード
                    </option>
                    <option value="keyFile">秘密鍵</option>
                    <option value="agent">SSH Agent</option>
                  </Select>
                )}
              </Field>
              {authKind === "password" && (
                <>
                  <Field label="パスワード" error={message(errors, "password")}>
                    {(id) => (
                      <Input
                        id={id}
                        type="password"
                        autoComplete="off"
                        {...register("password")}
                      />
                    )}
                  </Field>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" {...register("remember")} />
                    Keychainに保存する
                  </label>
                </>
              )}
              {authKind === "keyFile" && (
                <>
                  <Field
                    label="秘密鍵のパス"
                    error={message(errors, "keyPath")}
                  >
                    {(id) => (
                      <Input
                        id={id}
                        placeholder="~/.ssh/id_ed25519"
                        {...register("keyPath")}
                      />
                    )}
                  </Field>
                  <Field label="パスフレーズ">
                    {(id) => (
                      <Input
                        id={id}
                        type="password"
                        autoComplete="off"
                        {...register("passphrase")}
                      />
                    )}
                  </Field>
                </>
              )}
            </>
          )}

          {type === "telnet" && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="送信改行">
                {(id) => (
                  <Select id={id} {...register("txNewline")}>
                    <option value="Cr">CR</option>
                    <option value="Lf">LF</option>
                    <option value="CrLf">CR+LF</option>
                  </Select>
                )}
              </Field>
              <Field label="受信改行">
                {(id) => (
                  <Select id={id} {...register("rxNewline")}>
                    <option value="Raw">変換しない</option>
                    <option value="LfToCrLf">LF → CR+LF</option>
                    <option value="CrToCrLf">CR → CR+LF</option>
                  </Select>
                )}
              </Field>
            </div>
          )}

          {type === "serial" && (
            <>
              <Field
                label="シリアルポート"
                error={message(errors, "serialPort")}
              >
                {(id) => (
                  <Select id={id} {...register("serialPort")}>
                    <option value="">選択してください</option>
                    {ports.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {portsError && (
                <p role="alert" className="text-xs text-red-400">
                  {portsError}
                </p>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Field label="ボーレート" error={message(errors, "baudRate")}>
                  {(id) => (
                    <Select
                      id={id}
                      {...register("baudRate", { valueAsNumber: true })}
                    >
                      {BAUD_RATES.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="データビット">
                  {(id) => (
                    <Select id={id} {...register("dataBits")}>
                      <option value="Five">5</option>
                      <option value="Six">6</option>
                      <option value="Seven">7</option>
                      <option value="Eight">8</option>
                    </Select>
                  )}
                </Field>
                <Field label="パリティ">
                  {(id) => (
                    <Select id={id} {...register("parity")}>
                      <option value="None">なし</option>
                      <option value="Odd">奇数</option>
                      <option value="Even">偶数</option>
                    </Select>
                  )}
                </Field>
                <Field label="ストップビット">
                  {(id) => (
                    <Select id={id} {...register("stopBits")}>
                      <option value="One">1</option>
                      <option value="Two">2</option>
                    </Select>
                  )}
                </Field>
                <Field label="フロー制御">
                  {(id) => (
                    <Select id={id} {...register("flowControl")}>
                      <option value="None">なし</option>
                      <option value="Software">ソフトウェア (XON/XOFF)</option>
                      <option value="Hardware">ハードウェア (RTS/CTS)</option>
                    </Select>
                  )}
                </Field>
              </div>
            </>
          )}

          <div className="mt-2 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              キャンセル
            </Button>
            <Button type="submit">接続</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
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
  stripSecrets,
  type ConnectionValues,
} from "../lib/connection-schema";
import {
  listSerialPorts,
  listSshHosts,
  type SavedProfile,
} from "../lib/terminal-api";
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
  /** 保存済みの接続の選択・保存の指定。接続設定そのものではないため Zod の検証対象外。 */
  profileId: string;
  saveProfile: boolean;
  profileName: string;
  type: ConnectionValues["type"];
  encoding: (typeof ENCODINGS)[number];
  localEcho: "auto" | "on" | "off";
  host: string;
  port: number;
  username: string;
  useSshConfig: boolean;
  jumpHosts: string;
  forwards: string;
  authKind: "password" | "keychain" | "keyFile" | "agent";
  password: string;
  remember: boolean;
  keyPath: string;
  passphrase: string;
  txNewline: "Cr" | "Lf" | "CrLf";
  rxNewline: "Raw" | "LfToCrLf" | "CrToCrLf";
  serialPort: string;
  /** 一覧から選ばず、ポート名を手入力する。 */
  serialPortManual: boolean;
  baudRate: number;
  dataBits: "Five" | "Six" | "Seven" | "Eight";
  parity: "None" | "Odd" | "Even";
  stopBits: "One" | "Two";
  flowControl: "None" | "Software" | "Hardware";
}

interface Props {
  open: boolean;
  /** 開いたときの入力済みの値（再接続・保存済み接続の呼び出し用）。秘密情報は含めない。 */
  initialValues?: Partial<FormValues>;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: ConnectionValues, options?: SubmitOptions) => void;
  loadSerialPorts?: () => Promise<string[]>;
  /** ~/.ssh/config の Host の別名（ホスト名の候補）。 */
  loadSshHosts?: () => Promise<string[]>;
  profiles?: SavedProfile[];
  onDeleteProfile?: (id: string) => void;
}

/** 接続と同時に保存する場合の指定。`values` にパスワード類は含まれない。 */
export interface SubmitOptions {
  saveAs?: { id?: string; name: string; values: Record<string, unknown> };
}

const EXTRA_DEFAULTS = {
  profileId: "",
  saveProfile: false,
  profileName: "",
  serialPortManual: false,
};

/** 手入力を選ぶ選択肢の値。 */
const MANUAL_PORT = "__manual__";

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
  initialValues,
  onOpenChange,
  onSubmit,
  loadSerialPorts = listSerialPorts,
  loadSshHosts = listSshHosts,
  profiles = [],
  onDeleteProfile,
}: Props) {
  const {
    register,
    handleSubmit,
    control,
    setValue,
    getValues,
    reset,
    setError,
    formState: { errors },
  } = useForm<FormValues, unknown, ConnectionValues>({
    resolver: zodResolver(connectionSchema) as unknown as Resolver<
      FormValues,
      unknown,
      ConnectionValues
    >,
    defaultValues: { ...defaultConnectionValues, ...EXTRA_DEFAULTS },
  });
  const type = useWatch({ control, name: "type" });
  const authKind = useWatch({ control, name: "authKind" });
  const [portList, setPortList] = useState<{
    ports: string[];
    error: string | null;
    loaded: boolean;
  }>({
    ports: [],
    error: null,
    loaded: false,
  });
  const { ports, error: portsError, loaded: portsLoaded } = portList;
  const [sshHosts, setSshHosts] = useState<string[]>([]);
  const serialPort = useWatch({ control, name: "serialPort" });
  const serialPortManual = useWatch({ control, name: "serialPortManual" });
  /** 手入力を選んだ場合、または（保存済みの接続などで）一覧にないポート名の場合。 */
  const manualPort =
    serialPortManual ||
    (portsLoaded && serialPort !== "" && !ports.includes(serialPort));

  useEffect(() => {
    // 閉じたら入力を破棄し（パスワード等の秘密情報をメモリに残さない）、開くたびに初期状態へ戻す。
    reset({
      ...defaultConnectionValues,
      ...EXTRA_DEFAULTS,
      ...(open ? initialValues : {}),
    });
  }, [open, initialValues, reset]);

  useEffect(() => {
    // 種別に応じた既定ポートへ切り替える（ユーザーが変更済みの値は維持する）。
    const port = getValues("port");
    if (type === "telnet" && port === 22) setValue("port", 23);
    if (type === "ssh" && port === 23) setValue("port", 22);
  }, [type, getValues, setValue]);

  useEffect(() => {
    if (!open || type !== "ssh") return;
    let cancelled = false;
    // 一覧が取れなくても入力は続けられる（候補が出ないだけ）。
    loadSshHosts()
      .then((hosts) => !cancelled && setSshHosts(hosts))
      .catch(() => !cancelled && setSshHosts([]));
    return () => {
      cancelled = true;
    };
  }, [open, type, loadSshHosts]);

  useEffect(() => {
    if (!open || type !== "serial") return;
    let cancelled = false;
    loadSerialPorts()
      .then(
        (ports) =>
          !cancelled && setPortList({ ports, error: null, loaded: true }),
      )
      .catch(
        (e: unknown) =>
          !cancelled &&
          setPortList({
            ports: [],
            error: `ポート一覧を取得できません: ${String(e)}`,
            loaded: true,
          }),
      );
    return () => {
      cancelled = true;
    };
  }, [open, type, loadSerialPorts]);

  const profileId = useWatch({ control, name: "profileId" });
  const saveProfile = useWatch({ control, name: "saveProfile" });
  const selectedProfile = profiles.find((p) => p.id === profileId);

  const loadProfile = (id: string) => {
    const profile = profiles.find((p) => p.id === id);
    reset({
      ...defaultConnectionValues,
      ...EXTRA_DEFAULTS,
      ...(profile?.values as Partial<FormValues> | undefined),
      profileId: profile ? id : "",
    });
  };

  const submit = handleSubmit((values) => {
    // ~/.ssh/config を使う場合、ユーザー名は設定ファイルの User で補える。別名でなければ入力が必要。
    if (
      values.type === "ssh" &&
      values.username === "" &&
      !sshHosts.includes(values.host.trim())
    ) {
      setError("username", { message: "ユーザー名を入力してください" });
      return;
    }
    const { profileId, saveProfile, profileName } = getValues();
    let options: SubmitOptions | undefined;
    if (saveProfile) {
      const name = profileName.trim();
      if (name === "") {
        setError("profileName", { message: "保存名を入力してください" });
        return;
      }
      options = {
        saveAs: {
          id: profileId || undefined,
          name,
          values: stripSecrets(values),
        },
      };
    }
    onSubmit(values, options);
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
          {profiles.length > 0 && (
            <div className="grid grid-cols-[1fr_auto] items-end gap-2">
              <Field label="保存済みの接続">
                {(id) => (
                  <Select
                    id={id}
                    {...register("profileId", {
                      onChange: (e) => loadProfile(e.target.value),
                    })}
                  >
                    <option value="">（新規）</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {selectedProfile && (
                <Button
                  type="button"
                  variant="outline"
                  aria-label="この保存済み接続を削除"
                  onClick={() => {
                    onDeleteProfile?.(selectedProfile.id);
                    setValue("profileId", "");
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          )}

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
                  <>
                    <Input
                      id={id}
                      autoComplete="off"
                      list={type === "ssh" ? "ssh-host-suggestions" : undefined}
                      {...register("host")}
                    />
                    {type === "ssh" && (
                      <datalist id="ssh-host-suggestions">
                        {sshHosts.map((h) => (
                          <option key={h} value={h} />
                        ))}
                      </datalist>
                    )}
                  </>
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
                  <Input
                    id={id}
                    autoComplete="off"
                    placeholder="空欄なら ~/.ssh/config の User"
                    {...register("username")}
                  />
                )}
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" {...register("useSshConfig")} />
                ~/.ssh/config を使う
              </label>
              <Field
                label="踏み台（ProxyJump）"
                error={message(errors, "jumpHosts")}
              >
                {(id) => (
                  <Input
                    id={id}
                    autoComplete="off"
                    placeholder="user@bastion:22,gateway（空欄なら ~/.ssh/config の設定）"
                    {...register("jumpHosts")}
                  />
                )}
              </Field>
              <Field
                label="ポートフォワード（-L）"
                error={message(errors, "forwards")}
              >
                {(id) => (
                  <Input
                    id={id}
                    autoComplete="off"
                    placeholder="8080:db.internal:5432,9000:localhost:80（この Mac の 127.0.0.1 のみ）"
                    {...register("forwards")}
                  />
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
                        placeholder="~/.ssh/id_ed25519（空欄なら ~/.ssh/config の IdentityFile）"
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

          {(type === "telnet" || type === "serial") && (
            <Field label="ローカルエコー">
              {(id) => (
                <Select id={id} {...register("localEcho")}>
                  <option value="auto">
                    自動（
                    {type === "telnet"
                      ? "サーバーがエコーしなければオン"
                      : "シリアルはオフ"}
                    ）
                  </option>
                  <option value="on">オン（入力を画面に表示する）</option>
                  <option value="off">オフ</option>
                </Select>
              )}
            </Field>
          )}

          {(type === "telnet" || type === "serial") && (
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
                  <Select
                    id={id}
                    value={manualPort ? MANUAL_PORT : serialPort}
                    onChange={(e) => {
                      const manual = e.target.value === MANUAL_PORT;
                      setValue("serialPortManual", manual);
                      setValue("serialPort", manual ? "" : e.target.value, {
                        shouldValidate: false,
                      });
                    }}
                  >
                    <option value="">選択してください</option>
                    {ports.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                    <option value={MANUAL_PORT}>手入力…</option>
                  </Select>
                )}
              </Field>
              {manualPort && (
                <Field label="ポート名（手入力）">
                  {(id) => (
                    <Input
                      id={id}
                      autoComplete="off"
                      placeholder="/dev/cu.usbserial-1410"
                      {...register("serialPort")}
                    />
                  )}
                </Field>
              )}
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

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              {...register("saveProfile", {
                onChange: (e) => {
                  if (e.target.checked && !getValues("profileName")) {
                    setValue("profileName", selectedProfile?.name ?? "");
                  }
                },
              })}
            />
            この接続を保存する
          </label>
          {saveProfile && (
            <Field label="保存名" error={message(errors, "profileName")}>
              {(id) => (
                <Input
                  id={id}
                  autoComplete="off"
                  {...register("profileName")}
                />
              )}
            </Field>
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

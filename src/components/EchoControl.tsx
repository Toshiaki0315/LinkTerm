import type { EchoMode } from "../lib/local-echo";
import { Button } from "./ui/button";

interface Props {
  mode: EchoMode;
  /** 現在実際にローカルエコーしているか（自動のときの表示に使う）。 */
  effective: boolean;
  onChange: (mode: EchoMode) => void;
}

const NEXT: Record<EchoMode, EchoMode> = { auto: "on", on: "off", off: "auto" };

/** ローカルエコーの切り替え。押すたびに 自動 → オン → オフ と切り替える。 */
export function EchoControl({ mode, effective, onChange }: Props) {
  const label =
    mode === "auto"
      ? `自動（${effective ? "オン" : "オフ"}）`
      : mode === "on"
        ? "オン"
        : "オフ";
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label="ローカルエコーの切り替え"
      title="入力した文字を端末に表示するか（接続先がエコーしない場合に使います）"
      onClick={() => onChange(NEXT[mode])}
    >
      エコー: {label}
    </Button>
  );
}

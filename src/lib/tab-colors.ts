/** タブの色分け。`none` は色なし。 */
export const TAB_COLORS = [
  { id: "red", label: "赤", hex: "#ef4444" },
  { id: "orange", label: "オレンジ", hex: "#f97316" },
  { id: "yellow", label: "黄", hex: "#eab308" },
  { id: "green", label: "緑", hex: "#22c55e" },
  { id: "blue", label: "青", hex: "#3b82f6" },
  { id: "purple", label: "紫", hex: "#a855f7" },
  { id: "pink", label: "ピンク", hex: "#ec4899" },
  { id: "gray", label: "グレー", hex: "#9ca3af" },
] as const;

export type TabColorId = (typeof TAB_COLORS)[number]["id"];
export type TabColor = TabColorId | "none";

export const TAB_COLOR_IDS = TAB_COLORS.map((c) => c.id) as [
  TabColorId,
  ...TabColorId[],
];

/** 色の表示用の値。色なし・不明な値は `undefined`。 */
export function tabColorHex(color: string | undefined): string | undefined {
  return TAB_COLORS.find((c) => c.id === color)?.hex;
}

export function tabColorLabel(color: string | undefined): string | undefined {
  return TAB_COLORS.find((c) => c.id === color)?.label;
}

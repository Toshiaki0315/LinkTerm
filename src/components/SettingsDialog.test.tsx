import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, fontStackFor, type Settings } from "../lib/settings";
import type { FontFamily } from "../lib/terminal-api";
import { SettingsDialog } from "./SettingsDialog";

const profiles = [
  { id: "p1", name: "本番サーバー", values: { type: "ssh" } },
  { id: "p2", name: "ルーター", values: { type: "telnet" } },
];

const fonts: FontFamily[] = [
  { name: "Menlo", monospace: true },
  { name: "Osaka-Mono", monospace: true },
  { name: "SF Mono", monospace: true },
  { name: "Helvetica", monospace: false },
  { name: "ヒラギノ角ゴシック", monospace: false },
];

function setup(
  over: {
    settings?: Settings;
    profiles?: typeof profiles;
    onSave?: (s: Settings) => Promise<void>;
    loadFonts?: () => Promise<FontFamily[]>;
  } = {},
) {
  const onSave = vi.fn<(s: Settings) => Promise<void>>(
    over.onSave ?? (async () => {}),
  );
  const onOpenChange = vi.fn();
  const loadFonts = vi.fn(over.loadFonts ?? (async () => fonts));
  const user = userEvent.setup();
  render(
    <SettingsDialog
      open
      onOpenChange={onOpenChange}
      settings={over.settings ?? DEFAULT_SETTINGS}
      profiles={over.profiles ?? profiles}
      onSave={onSave}
      loadFonts={loadFonts}
    />,
  );
  return { onSave, onOpenChange, loadFonts, user };
}

async function replace(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  value: string,
) {
  const input = screen.getByLabelText(label);
  await user.clear(input);
  if (value !== "") await user.type(input, value);
}

/** フォント一覧の読み込み完了を待つ。 */
const fontsLoaded = () => screen.findByRole("option", { name: "SF Mono" });

describe("SettingsDialog", () => {
  it("現在の設定を表示する", async () => {
    setup({
      settings: {
        fontFamily: fontStackFor("Osaka-Mono"),
        fontSize: 16,
        scrollback: 5000,
        cursorBlink: false,
        theme: "dracula",
        copyOnSelect: false,
        autoReconnect: { enabled: false, delaySeconds: 5, maxAttempts: 5 },
        startup: { kind: "local" },
      },
    });
    await fontsLoaded();
    expect(screen.getByLabelText("配色テーマ")).toHaveValue("dracula");
    expect(screen.getByLabelText("フォント")).toHaveValue(
      fontStackFor("Osaka-Mono"),
    );
    expect(screen.getByLabelText("フォントサイズ")).toHaveValue(16);
    expect(screen.getByLabelText("スクロールバック行数")).toHaveValue(5000);
    expect(screen.getByLabelText("カーソルを点滅させる")).not.toBeChecked();
    expect(screen.getByLabelText("起動時に開くターミナル")).toHaveValue(
      "local",
    );
  });

  describe("フォントの選択", () => {
    it("フォントは自由入力ではなくリストから選ぶ", async () => {
      setup();
      await fontsLoaded();
      expect(screen.getByLabelText("フォント").tagName).toBe("SELECT");
    });

    it("標準と、インストール済みの等幅フォントが並ぶ（等幅以外は既定では出さない）", async () => {
      setup();
      await fontsLoaded();
      expect(
        screen.getByRole("option", { name: "標準（Menlo）" }),
      ).toBeInTheDocument();
      for (const name of ["Menlo", "Osaka-Mono", "SF Mono"]) {
        expect(screen.getByRole("option", { name })).toBeInTheDocument();
      }
      expect(
        screen.queryByRole("option", { name: "Helvetica" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("option", { name: "ヒラギノ角ゴシック" }),
      ).not.toBeInTheDocument();
    });

    it("「等幅以外のフォントも表示する」で、すべてのフォントから選べる", async () => {
      const { user } = setup();
      await fontsLoaded();
      await user.click(screen.getByLabelText("等幅以外のフォントも表示する"));
      expect(
        screen.getByRole("option", { name: "Helvetica" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("option", { name: "ヒラギノ角ゴシック" }),
      ).toBeInTheDocument();
    });

    it("現在のフォントが等幅以外なら、最初から一覧に出す", async () => {
      setup({
        settings: {
          ...DEFAULT_SETTINGS,
          fontFamily: fontStackFor("Helvetica"),
        },
      });
      await fontsLoaded();
      expect(screen.getByLabelText("フォント")).toHaveValue(
        fontStackFor("Helvetica"),
      );
      expect(
        screen.getByLabelText("等幅以外のフォントも表示する"),
      ).toBeChecked();
    });

    it("選んだフォントを、代替フォントつきで保存する", async () => {
      const { user, onSave } = setup();
      await fontsLoaded();
      await user.selectOptions(screen.getByLabelText("フォント"), "SF Mono");
      await user.click(screen.getByRole("button", { name: "保存" }));
      await waitFor(() => expect(onSave).toHaveBeenCalled());
      expect(onSave.mock.calls[0][0].fontFamily).toBe(
        '"SF Mono", Menlo, Monaco, "Courier New", monospace',
      );
    });

    it("標準を選ぶと既定の指定になる", async () => {
      const { user, onSave } = setup({
        settings: {
          ...DEFAULT_SETTINGS,
          fontFamily: fontStackFor("Osaka-Mono"),
        },
      });
      await fontsLoaded();
      await user.selectOptions(
        screen.getByLabelText("フォント"),
        "標準（Menlo）",
      );
      await user.click(screen.getByRole("button", { name: "保存" }));
      await waitFor(() => expect(onSave).toHaveBeenCalled());
      expect(onSave.mock.calls[0][0].fontFamily).toBe(
        DEFAULT_SETTINGS.fontFamily,
      );
    });

    it("以前に手書きで保存した指定も、「現在の指定」として残り、そのまま保存できる", async () => {
      const { user, onSave } = setup({
        settings: {
          ...DEFAULT_SETTINGS,
          fontFamily: "Courier Prime, monospace",
        },
      });
      await fontsLoaded();
      expect(
        screen.getByRole("option", {
          name: "現在の指定: Courier Prime, monospace",
        }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("フォント")).toHaveValue(
        "Courier Prime, monospace",
      );
      await user.click(screen.getByRole("button", { name: "保存" }));
      await waitFor(() => expect(onSave).toHaveBeenCalled());
      expect(onSave.mock.calls[0][0].fontFamily).toBe(
        "Courier Prime, monospace",
      );
    });

    it("一覧の読み込み中・失敗時も、標準と現在の指定で操作できる", async () => {
      const { user, onSave } = setup({
        loadFonts: async () => {
          throw "取得できません";
        },
      });
      expect(
        await screen.findByText(/フォント一覧を取得できません/),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("option", { name: "標準（Menlo）" }),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "保存" }));
      await waitFor(() => expect(onSave).toHaveBeenCalled());
    });

    it("開くたびに一覧を読み込む（フォントを入れた後に反映される）", async () => {
      const loadFonts = vi.fn(async () => fonts);
      const props = {
        onOpenChange: vi.fn(),
        settings: DEFAULT_SETTINGS,
        profiles,
        onSave: vi.fn(),
        loadFonts,
      };
      const { rerender } = render(<SettingsDialog open {...props} />);
      await waitFor(() => expect(loadFonts).toHaveBeenCalledTimes(1));
      rerender(<SettingsDialog open={false} {...props} />);
      expect(loadFonts).toHaveBeenCalledTimes(1);
      rerender(<SettingsDialog open {...props} />);
      await waitFor(() => expect(loadFonts).toHaveBeenCalledTimes(2));
    });
  });

  it("入力した内容で保存し、ダイアログを閉じる", async () => {
    const { user, onSave, onOpenChange } = setup();
    await fontsLoaded();
    await user.selectOptions(screen.getByLabelText("フォント"), "Osaka-Mono");
    await replace(user, "フォントサイズ", "18");
    await replace(user, "スクロールバック行数", "2000");
    await user.click(screen.getByLabelText("カーソルを点滅させる"));
    await user.selectOptions(
      screen.getByLabelText("起動時に開くターミナル"),
      "local",
    );
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith({
      fontFamily: fontStackFor("Osaka-Mono"),
      fontSize: 18,
      scrollback: 2000,
      cursorBlink: false,
      theme: "dark",
      copyOnSelect: false,
      autoReconnect: { enabled: false, delaySeconds: 5, maxAttempts: 5 },
      startup: { kind: "local" },
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("保存済みの接続を起動時に開く設定にできる", async () => {
    const { user, onSave } = setup();
    expect(screen.queryByLabelText("起動時の接続")).not.toBeInTheDocument();
    await user.selectOptions(
      screen.getByLabelText("起動時に開くターミナル"),
      "profile",
    );
    await user.selectOptions(screen.getByLabelText("起動時の接続"), "p2");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].startup).toEqual({
      kind: "profile",
      profileId: "p2",
    });
  });

  it("保存済みの接続を選んでいないとエラー", async () => {
    const { user, onSave } = setup();
    await user.selectOptions(
      screen.getByLabelText("起動時に開くターミナル"),
      "profile",
    );
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(
      await screen.findByText("起動時に開く接続を選択してください"),
    ).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("保存済みの接続がないときは、その旨を表示する", async () => {
    const { user } = setup({ profiles: [] });
    await user.selectOptions(
      screen.getByLabelText("起動時に開くターミナル"),
      "profile",
    );
    expect(screen.getByText(/保存済みの接続がありません/)).toBeInTheDocument();
  });

  it("範囲外の入力はエラーを表示して保存しない", async () => {
    const { user, onSave } = setup();
    await replace(user, "フォントサイズ", "7");
    await replace(user, "スクロールバック行数", "100001");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(
      await screen.findByText("フォントサイズは8〜72の整数で入力してください"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("スクロールバックは0〜100000行で入力してください"),
    ).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("プレビューが選んだフォント・サイズを反映する", async () => {
    const { user } = setup();
    await fontsLoaded();
    await user.selectOptions(screen.getByLabelText("フォント"), "Osaka-Mono");
    await replace(user, "フォントサイズ", "20");
    const preview = screen.getByTestId("font-preview");
    expect(preview.style.fontFamily).toContain("Osaka-Mono");
    expect(preview.style.fontSize).toBe("20px");
    expect(preview).toHaveTextContent("日本語");
  });

  it("「初期設定に戻す」で入力欄だけを既定値にする（保存はしない）", async () => {
    const { user, onSave } = setup({
      settings: {
        ...DEFAULT_SETTINGS,
        fontFamily: fontStackFor("Osaka-Mono"),
        fontSize: 30,
        scrollback: 1,
        startup: { kind: "local" },
      },
    });
    await fontsLoaded();
    await user.click(screen.getByRole("button", { name: "初期設定に戻す" }));
    expect(screen.getByLabelText("フォント")).toHaveValue(
      DEFAULT_SETTINGS.fontFamily,
    );
    expect(screen.getByLabelText("フォントサイズ")).toHaveValue(
      DEFAULT_SETTINGS.fontSize,
    );
    expect(screen.getByLabelText("スクロールバック行数")).toHaveValue(
      DEFAULT_SETTINGS.scrollback,
    );
    expect(screen.getByLabelText("起動時に開くターミナル")).toHaveValue("none");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("保存に失敗したら理由を表示し、ダイアログは開いたままにする", async () => {
    const { user, onOpenChange } = setup({
      onSave: async () => {
        throw "ディスクがいっぱいです";
      },
    });
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(
      await screen.findByText(/ディスクがいっぱいです/),
    ).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  describe("配色テーマ", () => {
    it("6つのテーマから選べる", () => {
      setup();
      const select = screen.getByLabelText("配色テーマ");
      const labels = Array.from(select.querySelectorAll("option")).map(
        (o) => o.textContent,
      );
      expect(labels).toEqual([
        "ダーク",
        "ライト",
        "Solarized ダーク",
        "Solarized ライト",
        "Dracula",
        "Monokai",
      ]);
      expect(select).toHaveValue("dark");
    });

    it("選んだテーマを保存する", async () => {
      const { user, onSave } = setup();
      await user.selectOptions(screen.getByLabelText("配色テーマ"), "dracula");
      await user.click(screen.getByRole("button", { name: "保存" }));
      await waitFor(() => expect(onSave).toHaveBeenCalled());
      expect(onSave.mock.calls[0][0].theme).toBe("dracula");
    });

    it("プレビューが選んだテーマの配色になる", async () => {
      const { user } = setup();
      const preview = screen.getByTestId("font-preview");
      const dark = preview.style.backgroundColor;
      await user.selectOptions(
        screen.getByLabelText("配色テーマ"),
        "solarized-light",
      );
      expect(preview.style.backgroundColor).not.toBe(dark);
    });

    it("「初期設定に戻す」でダークに戻る", async () => {
      const { user } = setup({
        settings: { ...DEFAULT_SETTINGS, theme: "monokai" },
      });
      expect(screen.getByLabelText("配色テーマ")).toHaveValue("monokai");
      await user.click(screen.getByRole("button", { name: "初期設定に戻す" }));
      expect(screen.getByLabelText("配色テーマ")).toHaveValue("dark");
    });
  });

  describe("選択したらコピー", () => {
    it("既定はオフで、オンにして保存できる", async () => {
      const { user, onSave } = setup();
      const checkbox =
        screen.getByLabelText("選択したテキストを自動的にコピーする");
      expect(checkbox).not.toBeChecked();
      await user.click(checkbox);
      await user.click(screen.getByRole("button", { name: "保存" }));
      await waitFor(() => expect(onSave).toHaveBeenCalled());
      expect(onSave.mock.calls[0][0].copyOnSelect).toBe(true);
    });

    it("保存済みの値を表示し、初期設定に戻すとオフになる", async () => {
      const { user } = setup({
        settings: { ...DEFAULT_SETTINGS, copyOnSelect: true },
      });
      expect(
        screen.getByLabelText("選択したテキストを自動的にコピーする"),
      ).toBeChecked();
      await user.click(screen.getByRole("button", { name: "初期設定に戻す" }));
      expect(
        screen.getByLabelText("選択したテキストを自動的にコピーする"),
      ).not.toBeChecked();
    });
  });

  describe("自動再接続", () => {
    const enable = (user: ReturnType<typeof userEvent.setup>) =>
      user.click(screen.getByLabelText("切断（エラー）時に自動で再接続する"));

    it("既定はオフ。オンにして、待ち時間と回数を指定して保存できる", async () => {
      const { user, onSave } = setup();
      expect(
        screen.getByLabelText("切断（エラー）時に自動で再接続する"),
      ).not.toBeChecked();
      await enable(user);
      await replace(user, "再接続までの待ち時間（秒）", "10");
      await replace(user, "再接続の試行回数（0で無制限）", "0");
      await user.click(screen.getByRole("button", { name: "保存" }));
      await waitFor(() => expect(onSave).toHaveBeenCalled());
      expect(onSave.mock.calls[0][0].autoReconnect).toEqual({
        enabled: true,
        delaySeconds: 10,
        maxAttempts: 0,
      });
    });

    it("保存済みの値を表示する", () => {
      setup({
        settings: {
          ...DEFAULT_SETTINGS,
          autoReconnect: { enabled: true, delaySeconds: 30, maxAttempts: 3 },
        },
      });
      expect(
        screen.getByLabelText("切断（エラー）時に自動で再接続する"),
      ).toBeChecked();
      expect(screen.getByLabelText("再接続までの待ち時間（秒）")).toHaveValue(
        30,
      );
      expect(
        screen.getByLabelText("再接続の試行回数（0で無制限）"),
      ).toHaveValue(3);
    });

    it("範囲外の値はエラーにして保存しない", async () => {
      const { user, onSave } = setup();
      await replace(user, "再接続までの待ち時間（秒）", "0");
      await replace(user, "再接続の試行回数（0で無制限）", "1001");
      await user.click(screen.getByRole("button", { name: "保存" }));
      expect(
        await screen.findByText("待ち時間は1〜3600秒の整数で入力してください"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("回数は0〜1000の整数で入力してください（0は無制限）"),
      ).toBeInTheDocument();
      expect(onSave).not.toHaveBeenCalled();
    });

    it("初期設定に戻すと、オフ・5秒・5回になる", async () => {
      const { user } = setup({
        settings: {
          ...DEFAULT_SETTINGS,
          autoReconnect: { enabled: true, delaySeconds: 30, maxAttempts: 3 },
        },
      });
      await user.click(screen.getByRole("button", { name: "初期設定に戻す" }));
      expect(
        screen.getByLabelText("切断（エラー）時に自動で再接続する"),
      ).not.toBeChecked();
      expect(screen.getByLabelText("再接続までの待ち時間（秒）")).toHaveValue(
        5,
      );
      expect(
        screen.getByLabelText("再接続の試行回数（0で無制限）"),
      ).toHaveValue(5);
    });
  });

  it("起動時に「前回のタブを復元」を選んで保存できる", async () => {
    const { user, onSave } = setup();
    await user.selectOptions(
      screen.getByLabelText("起動時に開くターミナル"),
      "restore",
    );
    expect(screen.queryByLabelText("起動時の接続")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].startup).toEqual({ kind: "restore" });
  });

  it("キャンセルで保存せずに閉じる", async () => {
    const { user, onSave, onOpenChange } = setup();
    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("開き直すと、編集途中の内容ではなく保存済みの設定が表示される", async () => {
    const loadFonts = vi.fn(async () => fonts);
    const props = {
      onOpenChange: vi.fn(),
      settings: DEFAULT_SETTINGS,
      profiles,
      onSave: vi.fn(),
      loadFonts,
    };
    const user = userEvent.setup();
    const { rerender } = render(<SettingsDialog open {...props} />);
    await replace(user, "フォントサイズ", "40");
    rerender(<SettingsDialog open={false} {...props} />);
    rerender(<SettingsDialog open {...props} />);
    expect(screen.getByLabelText("フォントサイズ")).toHaveValue(
      DEFAULT_SETTINGS.fontSize,
    );
  });
});

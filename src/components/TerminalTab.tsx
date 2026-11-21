import { useCallback, useEffect, useRef, useState } from "react";
import { useAutoReconnect } from "../hooks/useAutoReconnect";
import { useLogControl } from "../hooks/useLogControl";
import { useSerialControl } from "../hooks/useSerialControl";
import { useTerminalSession } from "../hooks/useTerminalSession";
import {
  isSecretMissing,
  toStartRequest,
  type ConnectionValues,
} from "../lib/connection-schema";
import { LoginRunner, parseLoginScript } from "../lib/auto-login";
import { OutputMatcher, type HighlightRule } from "../lib/highlight";
import { NOTIFY_INTERVAL_MS, Throttle, notifyMatch } from "../lib/notify";
import { exportText } from "../lib/export-text";
import { cancelMacroDialogs, showMacroDialog } from "../lib/macro-dialog";
import { parseProgram } from "../lib/ttl/parser";
import { TtlError } from "../lib/ttl/errors";
import { TtlRunner } from "../lib/ttl/runner";
import { playBeep } from "../lib/beep";
import { sendBreak, setControlSignal } from "../lib/terminal-api";
import { registerPaneActions } from "../lib/pane-actions";
import { registerPaneInput } from "../lib/pane-input";
import { buildPaneMenuItems } from "../lib/pane-menu-items";
import { menuSignature, publishPaneMenu } from "../lib/pane-menu";
import { echoFor, isLocalEchoOn, type EchoMode } from "../lib/local-echo";
import type { Appearance, AutoReconnect } from "../lib/settings";
import { copyText, pasteText } from "../lib/clipboard";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { SearchBar } from "./SearchBar";
import type { Macro } from "../lib/macros";
import { SftpDialog } from "./SftpDialog";
import { LogDialog } from "./LogDialog";
import { Button } from "./ui/button";
import { TerminalView, type TerminalHandle } from "./TerminalView";
import type { SessionStatus } from "../hooks/useTerminalSession";

const DISABLED_AUTO_RECONNECT: AutoReconnect = {
  enabled: false,
  delaySeconds: 5,
  maxAttempts: 5,
};

interface Props {
  tabId: string;
  title: string;
  values: ConnectionValues;
  active: boolean;
  onStatusChange: (id: string, status: SessionStatus) => void;
  /** 接続要求を組み立て終えた（パスワード等を保持し続ける必要がなくなった）。 */
  onSecretsConsumed: (id: string) => void;
  /** 保持していない秘密情報の再入力が必要な再接続。 */
  onEditAndReconnect: (id: string) => void;
  appearance?: Appearance;
  /** 異常な切断のあとの自動再接続。省略すると無効。 */
  autoReconnect?: AutoReconnect;
  /** 増えたら検索バーを開く（⌘F）。 */
  findSignal?: number;
  /** 復元したタブ: 自動では接続せず、「接続」ボタンで接続する。 */
  deferStart?: boolean;
  /** 各行に時刻を表示するか。 */
  showTimestamps?: boolean;
  /** 時刻の表示を切り替える。省略するとボタンを出さない。 */
  onToggleTimestamps?: () => void;
  /** キー入力・貼り付けを、ほかのペインにも送る（同時入力）。省略すると送らない。 */
  onBroadcast?: (data: string) => void;
  /** キーワードのハイライト規則（色付けと、見つけたときの通知）。 */
  highlightRules?: HighlightRule[];
  /** マクロの `settitle`: このタブの名前を変える。 */
  onSetTitle?: (title: string) => void;
  /** マクロの `sendbroadcast`: すべてのペインへ送る。 */
  onBroadcastAll?: (data: string) => void;
  /** 保存しているマクロ。接続設定の「接続後に実行するマクロ」を名前で探すのに使う。 */
  macros?: Macro[];
  /** 通知する規則に一致した（このペインが見えていないとき）。タブの注目表示に使う。 */
  onAttention?: () => void;
  /** 画面を分割する（右クリックメニュー）。省略すると項目を出さない。 */
  onSplit?: (dir: "row" | "column") => void;
  /** このペインを閉じる（分割しているときだけ渡す）。 */
  onClosePane?: () => void;
}

/** 1タブ = 1セッション。xterm とセッションをここで結び付ける。 */
export function TerminalTab({
  tabId,
  title,
  values,
  active,
  onStatusChange,
  onSecretsConsumed,
  onEditAndReconnect,
  appearance,
  autoReconnect = DISABLED_AUTO_RECONNECT,
  findSignal = 0,
  deferStart = false,
  highlightRules,
  showTimestamps = false,
  onToggleTimestamps,
  onAttention,
  onBroadcast,
  onSetTitle,
  onBroadcastAll,
  macros,
  onSplit,
  onClosePane,
}: Props) {
  const termRef = useRef<TerminalHandle>(null);
  const startedRef = useRef(false);

  /** 自動ログイン（Telnet / シリアルで、スクリプトがあるとき）。 */
  const loginRef = useRef<LoginRunner | null>(null);
  const decoderRef = useRef<TextDecoder | null>(null);
  /** 実行中のマクロ（1つのペインで同時に走るのは1つだけ）。 */
  const macroRef = useRef<{
    runner: TtlRunner;
    name: string;
    owner: string;
  } | null>(null);
  const macroCounter = useRef(0);
  /** マクロの `enablekeyb 0` の間は false（ユーザーのキー入力を送らない）。 */
  const keyboardEnabled = useRef(true);
  /** 接続後のマクロの実行待ち。接続の状態が画面に反映されてから実行する。 */
  const connectMacroPending = useRef(false);
  const [connectKick, setConnectKick] = useState(0);
  const requestConnectMacro = useCallback(() => {
    connectMacroPending.current = true;
    setConnectKick((k) => k + 1);
  }, []);

  /** 通知する規則の照合（規則が変わったら作り直す）。 */
  const matcherRef = useRef<OutputMatcher | null>(null);
  const throttleRef = useRef(new Throttle(NOTIFY_INTERVAL_MS));
  /** 最新の値（出力のコールバックから読む）。 */
  const liveRef = useRef({ active, title, onAttention });
  useEffect(() => {
    liveRef.current = { active, title, onAttention };
  }, [active, title, onAttention]);
  useEffect(() => {
    const notifying = (highlightRules ?? []).some((r) => r.notify);
    matcherRef.current = notifying
      ? new OutputMatcher(highlightRules ?? [])
      : null;
  }, [highlightRules]);

  /** ベルが鳴った直後の、画面の点滅。 */
  const [bellFlash, setBellFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** ベル: 画面を一瞬光らせる。見ていなければ、タブの注目表示も出す。 */
  const onBell = useCallback(() => {
    setBellFlash(true);
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => {
      flashTimer.current = null;
      setBellFlash(false);
    }, 150);
    const live = liveRef.current;
    if (!live.active || !document.hasFocus()) live.onAttention?.();
  }, []);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    },
    [],
  );

  /** 通知する規則に一致したとき。画面を見ていなければ、通知とタブの注目表示を出す。 */
  const onMatches = useCallback((hits: HighlightRule[]) => {
    const live = liveRef.current;
    if (live.active && document.hasFocus()) return;
    live.onAttention?.();
    for (const rule of hits) {
      if (!throttleRef.current.allow(rule.id)) continue;
      notifyMatch(
        "キーワードを検出しました",
        `「${rule.pattern}」 — ${live.title}`,
      ).catch((e: unknown) => console.error("通知に失敗しました:", e));
    }
  }, []);

  const onData = useCallback(
    (data: Uint8Array) => {
      termRef.current?.write(data);
      const runner = loginRef.current;
      const loginActive = runner !== null && !runner.done;
      const matcher = matcherRef.current;
      const macro = macroRef.current;
      if (!loginActive && !matcher && !macro) return;
      decoderRef.current ??= new TextDecoder();
      const text = decoderRef.current.decode(data, { stream: true });
      macro?.runner.feed(text);
      if (runner && loginActive) {
        // 出力が届いた時点で、セッションは確立している。
        runner.begin();
        runner.feed(text);
      }
      if (matcher) {
        const hits = matcher.feed(text);
        if (hits.length > 0) onMatches(hits);
      }
    },
    [onMatches],
  );
  const { status, sessionId, error, remoteEcho, start, write, resize, close } =
    useTerminalSession({ onData });

  /** ローカルエコー。Telnet / シリアルだけが対象で、接続設定の値で始め、実行中に切り替えられる。 */
  const supportsEcho = values.type === "telnet" || values.type === "serial";
  const [echoMode, setEchoMode] = useState<EchoMode>(
    values.type === "telnet" || values.type === "serial"
      ? values.localEcho
      : "off",
  );
  const localEcho = supportsEcho && isLocalEchoOn(echoMode, remoteEcho);

  const [searchOpen, setSearchOpen] = useState(false);
  const [sftpOpen, setSftpOpen] = useState(false);
  /** 画面の保存の結果（成功・失敗）の表示。 */
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [seenFindSignal, setSeenFindSignal] = useState(findSignal);
  if (findSignal !== seenFindSignal) {
    // 検索の要求が来た（⌘F）。描画中の状態更新は、値が変わったときの1回だけ。
    setSeenFindSignal(findSignal);
    setSearchOpen(true);
  }
  /** 右クリックメニュー。選択の有無は、開いた時点のものを使う。 */
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);
  const logError = (what: string) => (e: unknown) =>
    console.error(`${what}に失敗しました:`, e);
  /** 画面の内容（スクロールバックを含む）を、保存ダイアログで選んだファイルへ保存する。 */
  const saveScreenText = () => {
    const text = termRef.current?.getText() ?? "";
    if (text === "") {
      setSaveNotice("保存する内容がありません");
      return;
    }
    exportText(text)
      .then((path) => setSaveNotice(path ? `保存しました: ${path}` : null))
      .catch((e: unknown) =>
        setSaveNotice(
          `保存できません: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
  };
  /** メニュー項目を作る。右クリックのイベント処理の中で呼ぶ（ref を描画中に読まないため）。 */
  const buildMenuItems = (hasSelection: boolean): ContextMenuItem[] => [
    {
      label: "コピー",
      disabled: !hasSelection,
      onSelect: () => {
        copyText(termRef.current?.getSelection() ?? "").catch(
          logError("コピー"),
        );
      },
    },
    {
      label: "貼り付け",
      onSelect: () => {
        pasteText()
          .then((text) => {
            if (text !== "") termRef.current?.paste(text);
          })
          .catch(logError("貼り付け"));
      },
    },
    { label: "すべて選択", onSelect: () => termRef.current?.selectAll() },
    { label: "検索…", onSelect: () => setSearchOpen(true) },
    { label: "画面をクリア", onSelect: () => termRef.current?.clear() },
    {
      label: "画面をテキストで保存…",
      onSelect: () => saveScreenText(),
    },
    ...(onSplit
      ? [
          {
            label: "右に分割（⌘D）",
            separatorBefore: true,
            onSelect: () => onSplit("row"),
          },
          { label: "下に分割（⌘⇧D）", onSelect: () => onSplit("column") },
        ]
      : []),
    ...(onClosePane
      ? [{ label: "ペインを閉じる", onSelect: onClosePane }]
      : []),
  ];

  const closeSearch = () => {
    setSearchOpen(false);
    termRef.current?.clearSearch();
    termRef.current?.focus();
  };

  const note = useCallback((text: string) => {
    termRef.current?.write(new TextEncoder().encode(`\r\n--- ${text} ---\r\n`));
  }, []);

  /** 接続し、自動ログインのスクリプトがあれば始める。 */
  const launch = useCallback(async () => {
    loginRef.current?.stop();
    loginRef.current = null;
    decoderRef.current = null;
    const request = toStartRequest(
      values,
      termRef.current?.size() ?? { cols: 80, rows: 24 },
    );
    let runner: LoginRunner | null = null;
    if (values.type === "telnet" || values.type === "serial") {
      const parsed = parseLoginScript(values.loginScript ?? "");
      if (parsed.ok && parsed.steps.length > 0) {
        // パスワードはここで取り込む（接続後、画面側の保持分は消される）。
        runner = new LoginRunner({
          steps: parsed.steps,
          password: values.loginPassword ?? "",
          send: (data) =>
            write(data).catch((e: unknown) =>
              console.error("自動ログインの送信に失敗しました:", e),
            ),
          onDone: () => {
            note("自動ログインを完了しました");
            requestConnectMacro();
          },
          onTimeout: (waiting) =>
            note(`自動ログイン: 「${waiting}」が表示されないため中断しました`),
        });
        loginRef.current = runner;
      }
    }
    const connected = await start(request);
    if (!runner) {
      if (connected) requestConnectMacro();
      return;
    }
    if (loginRef.current !== runner) return;
    if (connected) runner.begin();
    else runner.stop();
  }, [values, start, write, note, requestConnectMacro]);

  useEffect(() => {
    // 切断・エラーになったら、自動ログインは続けない。
    if (status === "closed" || status === "error") loginRef.current?.stop();
  }, [status]);

  // タブを閉じたら自動ログインを止める。StrictMode（開発時）は、マウント直後に
  // 疑似アンマウント→再マウントを行うので、すぐ再マウントされたときは止めない。
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueMicrotask(() => {
        if (mountedRef.current) return;
        loginRef.current?.stop();
        const macro = macroRef.current;
        if (macro) {
          macro.runner.stop();
          cancelMacroDialogs(macro.owner);
        }
      });
    };
  }, []);

  useEffect(() => {
    // StrictMode の二重実行で接続が重複しないようにする。
    if (startedRef.current || deferStart) return;
    startedRef.current = true;
    void launch();
    onSecretsConsumed(tabId);
  }, [launch, tabId, onSecretsConsumed, deferStart]);

  useEffect(() => {
    onStatusChange(tabId, status);
  }, [tabId, status, onStatusChange]);

  // ---- マクロ ----
  /** 実行中のマクロの表示（名前と、いま実行している行）。 */
  const [macroView, setMacroView] = useState<{
    name: string;
    line: number;
    /** `statusbox` で出した、実行中の状態の表示。 */
    status?: { message: string; title: string };
  } | null>(null);
  /** マクロの結果の知らせ（エラーは赤、それ以外は通常）。 */
  const [macroNotice, setMacroNotice] = useState<{
    error: boolean;
    text: string;
  } | null>(null);
  /** マクロの命令から読む、最新の状態。 */
  const macroLive = useRef({
    onSetTitle,
    onBroadcastAll,
    title,
    host: values.type === "ssh" || values.type === "telnet" ? values.host : "",
    status,
    sessionId,
    write,
    close,
    type: values.type,
  });
  useEffect(() => {
    macroLive.current = {
      onSetTitle,
      onBroadcastAll,
      title,
      host:
        values.type === "ssh" || values.type === "telnet" ? values.host : "",
      status,
      sessionId,
      write,
      close,
      type: values.type,
    };
  });

  const stopMacro = useCallback(() => {
    const current = macroRef.current;
    if (!current) return;
    current.runner.stop();
    cancelMacroDialogs(current.owner);
  }, []);

  const runMacro = useCallback(
    (macro: { name: string; text: string }) => {
      const fail = (text: string) => setMacroNotice({ error: true, text });
      if (macroRef.current) {
        fail(
          `マクロ「${macroRef.current.name}」を実行中です。先に停止してください`,
        );
        return;
      }
      if (macroLive.current.status !== "connected") {
        fail("接続していないため、マクロを実行できません");
        return;
      }
      const parsed = parseProgram(macro.text);
      if (!parsed.ok) {
        const first = parsed.errors[0];
        fail(`マクロ「${macro.name}」: ${first.line}行目: ${first.message}`);
        return;
      }
      macroCounter.current += 1;
      const owner = `${tabId}-${macroCounter.current}`;
      const connected = () => {
        if (macroLive.current.status !== "connected") {
          throw new TtlError("接続されていないため、送れません");
        }
      };
      const runner = new TtlRunner(parsed.program, {
        send: async (data) => {
          connected();
          // 画面（ローカルエコー）には出さない。パスワードを送ることがあるため。
          await macroLive.current.write(data);
        },
        sendBreak: async () => {
          connected();
          const { type, sessionId: id } = macroLive.current;
          if (type !== "serial" || !id) {
            throw new TtlError("ブレークを送れるのは、シリアル接続だけです");
          }
          await sendBreak(id);
        },
        display: (text) =>
          termRef.current?.write(new TextEncoder().encode(text)),
        messagebox: (message, title) =>
          showMacroDialog(owner, { kind: "message", message, title }),
        yesnobox: (message, title) =>
          showMacroDialog(owner, { kind: "yesno", message, title }),
        inputbox: (message, title, initial) =>
          showMacroDialog(owner, { kind: "input", message, title, initial }),
        passwordbox: (message, title) =>
          showMacroDialog(owner, { kind: "password", message, title }),
        listbox: (message, title, items, selected) =>
          showMacroDialog(owner, {
            kind: "list",
            message,
            title,
            items,
            selected,
          }),
        disconnect: () => macroLive.current.close(),
        isConnected: () => macroLive.current.status === "connected",
        setEcho: (on) => setEchoMode(on ? "on" : "off"),
        setSignal: async (signal, on) => {
          connected();
          const { type, sessionId: id } = macroLive.current;
          if (type !== "serial" || !id) {
            throw new TtlError(
              "DTR・RTS を変えられるのは、シリアル接続だけです",
            );
          }
          await setControlSignal(id, signal, on);
        },
        setKeyboardEnabled: (enabled) => {
          keyboardEnabled.current = enabled;
        },
        clearScreen: (kind) => {
          if (kind === 1) termRef.current?.clear();
          else
            termRef.current?.write(
              new TextEncoder().encode("\u001b[2J\u001b[H"),
            );
        },
        setTitle: (t) => macroLive.current.onSetTitle?.(t),
        getTitle: () => macroLive.current.title,
        beep: (kind) => playBeep(kind),
        showStatus: (message, title) =>
          setMacroView((v) => (v ? { ...v, status: { message, title } } : v)),
        closeStatus: () =>
          setMacroView((v) => (v ? { ...v, status: undefined } : v)),
        hostName: () => macroLive.current.host,
        uptimeMs: () => Math.floor(performance.now()),
        broadcast: (data) => macroLive.current.onBroadcastAll?.(data),
        now: () => new Date(),
        random: (max) => Math.floor(Math.random() * max),
      });
      macroRef.current = { runner, name: macro.name, owner };
      setMacroNotice(null);
      setMacroView({ name: macro.name, line: 0 });
      void runner
        .run({
          onLine: (line) => setMacroView((v) => (v ? { ...v, line } : v)),
        })
        .then((result) => {
          keyboardEnabled.current = true;
          cancelMacroDialogs(owner);
          if (macroRef.current?.owner === owner) macroRef.current = null;
          if (!mountedRef.current) return;
          setMacroView(null);
          if (result.status === "error") {
            setMacroNotice({
              error: true,
              text: `マクロ「${macro.name}」: ${result.line}行目: ${result.message}`,
            });
          } else {
            setMacroNotice({
              error: false,
              text:
                result.status === "stopped"
                  ? `マクロ「${macro.name}」を停止しました`
                  : `マクロ「${macro.name}」を終了しました`,
            });
          }
        });
    },
    [tabId],
  );
  const macroActionRef = useRef({ runMacro, stopMacro });
  useEffect(() => {
    macroActionRef.current = { runMacro, stopMacro };
  });

  /** 接続設定で指定されたマクロを、名前で探して実行する。 */
  const runConnectMacro = useCallback(
    (name: string, list: Macro[] | undefined) => {
      const macro = list?.find((m) => m.name === name);
      if (macro) {
        runMacro(macro);
      } else {
        setMacroNotice({
          error: true,
          text: `接続後のマクロ「${name}」が見つかりません`,
        });
      }
    },
    [runMacro],
  );

  // 接続できた（自動ログインがあれば、その完了後の）ら、指定のマクロを実行する。
  // 状態の更新はタイマーの中で行う（StrictMode の疑似アンマウントで取りこぼさないよう、
  // 実行待ちの印はタイマーの中で消す）。
  useEffect(() => {
    if (!connectMacroPending.current || status !== "connected") return;
    const timer = setTimeout(() => {
      if (!connectMacroPending.current) return;
      connectMacroPending.current = false;
      if (values.connectMacro) runConnectMacro(values.connectMacro, macros);
    }, 0);
    return () => clearTimeout(timer);
  }, [connectKick, status, values.connectMacro, macros, runConnectMacro]);

  /** このペインへ送る（ローカルエコーを含む）。同時入力は含まない。 */
  const sendDirect = useCallback(
    (data: string) => {
      if (localEcho) {
        termRef.current?.write(new TextEncoder().encode(echoFor(data)));
      }
      write(data).catch((e: unknown) =>
        console.error("送信に失敗しました:", e),
      );
    },
    [write, localEcho],
  );
  /** キー入力・貼り付け。同時入力がオンなら、ほかのペインにも送る。 */
  const onInput = useCallback(
    (data: string) => {
      // マクロが `enablekeyb 0` で、ユーザーのキー入力を止めている間は、送らない。
      if (!keyboardEnabled.current) return;
      sendDirect(data);
      onBroadcast?.(data);
    },
    [sendDirect, onBroadcast],
  );
  // スニペットや同時入力など、端末の外からの入力は、同時入力へ再び回さずに送る（ループ防止）。
  useEffect(() => registerPaneInput(tabId, sendDirect), [tabId, sendDirect]);
  // コマンドパレットなど、ペインの外からの操作（最新の処理を呼ぶ）。
  const saveScreenRef = useRef(saveScreenText);
  useEffect(() => {
    saveScreenRef.current = saveScreenText;
  });
  useEffect(
    () =>
      registerPaneActions(tabId, {
        exportText: () => saveScreenRef.current(),
        paste: (text) => termRef.current?.paste(text),
        runMacro: (macro) => macroActionRef.current.runMacro(macro),
        stopMacro: () => macroActionRef.current.stopMacro(),
      }),
    [tabId],
  );

  const onResize = useCallback(
    (cols: number, rows: number) => {
      resize(cols, rows).catch((e: unknown) =>
        console.error("リサイズに失敗しました:", e),
      );
    },
    [resize],
  );

  /** パスワード認証のSSHは、消去済みのパスワードを入力し直す必要がある。 */
  const needsSecret = isSecretMissing(values);

  const reconnect = useCallback(() => {
    if (needsSecret) {
      onEditAndReconnect(tabId);
      return;
    }
    // 初回の接続（復元したタブ）では区切り線を出さない。
    if (status !== "idle") {
      termRef.current?.write(
        new TextEncoder().encode("\r\n--- 再接続 ---\r\n"),
      );
    }
    void launch();
    onSecretsConsumed(tabId);
  }, [
    needsSecret,
    onEditAndReconnect,
    onSecretsConsumed,
    tabId,
    launch,
    status,
  ]);

  const auto = useAutoReconnect({
    enabled: autoReconnect.enabled,
    delaySeconds: autoReconnect.delaySeconds,
    maxAttempts: autoReconnect.maxAttempts,
    status,
    canReconnect: !needsSecret,
    onReconnect: reconnect,
  });
  const maxLabel =
    autoReconnect.maxAttempts === 0 ? "∞" : String(autoReconnect.maxAttempts);

  // タブバーの「⋯」に出す、このペインの操作。接続済みのセッションがあるときだけ、ログ・シリアルを使える。
  const liveSessionId = status === "connected" ? sessionId : null;
  const log = useLogControl({ sessionId: liveSessionId, title });
  const serial = useSerialControl(
    values.type === "serial" ? liveSessionId : null,
  );
  const menuState = {
    type: values.type,
    connected: liveSessionId !== null,
    hasSession: liveSessionId !== null,
    showTimestamps,
    onToggleTimestamps,
    onSearch: () => setSearchOpen(true),
    onSftp: () => setSftpOpen(true),
    logging: log.logging,
    onLogStart: () => void log.openDialog(),
    onLogStop: () => void log.stop(),
    macroRunning: macroView !== null,
    onMacroStop: stopMacro,
    echo: supportsEcho
      ? { mode: echoMode, effective: localEcho, onChange: setEchoMode }
      : undefined,
    serial:
      values.type === "serial"
        ? {
            signals: serial.signals,
            hex: serial.hex,
            breaking: serial.breaking,
            onToggleSignal: (s: "dtr" | "rts") => void serial.toggleSignal(s),
            onBreak: () => void serial.doBreak(),
            onToggleHex: () => void serial.toggleHex(),
          }
        : undefined,
  };
  const paneMenu = {
    items: buildPaneMenuItems(menuState),
    recording: log.logging,
  };
  // 選んだときの処理は、いつも最新のものを呼ぶ。公開は、見た目が変わったときだけ
  // （毎回公開すると、購読している画面の再描画から、ここの再描画が続いてしまう）。
  const paneMenuRef = useRef(paneMenu);
  useEffect(() => {
    paneMenuRef.current = paneMenu;
  });
  const paneMenuKey = menuSignature(paneMenu);
  useEffect(
    () =>
      publishPaneMenu(tabId, {
        recording: paneMenuRef.current.recording,
        items: paneMenuRef.current.items.map((item, index) => ({
          ...item,
          onSelect: () => paneMenuRef.current.items[index]?.onSelect(),
        })),
      }),
    // 見た目（paneMenuKey）が変わったときだけ公開し直す。
    [tabId, paneMenuKey],
  );
  const controlError = log.error ?? serial.error;

  return (
    <div className="relative h-full w-full">
      {values.type === "ssh" && sessionId && (
        <SftpDialog
          open={sftpOpen && status === "connected"}
          onOpenChange={setSftpOpen}
          sessionId={sessionId}
          title={title}
        />
      )}
      {log.dialogPath !== null && (
        <LogDialog
          open
          onOpenChange={(open) => !open && log.closeDialog()}
          defaultPath={log.dialogPath}
          onSubmit={log.start}
        />
      )}
      {controlError && (
        <div
          role="alert"
          className="absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-3 bg-red-900/90 px-3 py-1 text-xs"
        >
          <span className="break-all">{controlError}</span>
          <button
            className="shrink-0 underline"
            onClick={() => {
              log.clearError();
              serial.clearError();
            }}
          >
            閉じる
          </button>
        </div>
      )}
      {macroView && (
        <div
          role="status"
          aria-label="マクロ"
          className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-between gap-3 bg-sky-950/95 px-3 py-1 text-xs text-sky-100"
        >
          <span className="break-all">
            マクロ実行中: {macroView.name}
            {macroView.line > 0 ? `（${macroView.line}行目）` : ""}
            {macroView.status &&
              ` — ${macroView.status.title ? `${macroView.status.title}: ` : ""}${macroView.status.message}`}
          </span>
          <button
            className="shrink-0 rounded border border-sky-400/60 px-2 py-0.5 hover:bg-sky-900"
            aria-label="マクロを停止"
            onClick={stopMacro}
          >
            停止
          </button>
        </div>
      )}
      {macroNotice && (
        <div
          role={macroNotice.error ? "alert" : "status"}
          className={`absolute inset-x-0 ${macroView ? "bottom-7" : "bottom-0"} z-20 flex items-center justify-between gap-3 px-3 py-1 text-xs ${
            macroNotice.error
              ? "bg-red-900/90 text-red-50"
              : "bg-neutral-800/95 text-neutral-200"
          }`}
        >
          <span className="break-all">{macroNotice.text}</span>
          <button
            className="shrink-0 underline"
            onClick={() => setMacroNotice(null)}
          >
            閉じる
          </button>
        </div>
      )}
      {saveNotice && (
        <div
          role="status"
          className="absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-3 bg-neutral-800/95 px-3 py-1 text-xs text-neutral-200"
        >
          <span className="break-all">{saveNotice}</span>
          <button
            className="shrink-0 underline"
            onClick={() => setSaveNotice(null)}
          >
            閉じる
          </button>
        </div>
      )}
      {bellFlash && (
        <div
          aria-hidden
          data-testid="bell-flash"
          className="pointer-events-none absolute inset-0 z-10 bg-white/10 ring-2 ring-inset ring-sky-400/60"
        />
      )}
      {searchOpen && (
        <SearchBar
          onFind={(term, options, direction, incremental) =>
            termRef.current?.find(term, options, direction, incremental) ??
            false
          }
          onClear={() => termRef.current?.clearSearch()}
          onClose={closeSearch}
        />
      )}
      <TerminalView
        ref={termRef}
        active={active}
        appearance={appearance}
        highlightRules={highlightRules}
        showTimestamps={showTimestamps}
        onBell={onBell}
        onInput={onInput}
        onResize={onResize}
        onContextMenu={({ x, y }) =>
          setMenu({
            x,
            y,
            items: buildMenuItems(termRef.current?.hasSelection() ?? false),
          })
        }
      />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => {
            setMenu(null);
            termRef.current?.focus();
          }}
        />
      )}
      {status === "idle" && deferStart && (
        <div
          role="status"
          className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 bg-neutral-900/90 px-3 py-2 text-sm text-neutral-200"
        >
          <span>前回のタブです（未接続）</span>
          <Button size="sm" onClick={reconnect}>
            接続
          </Button>
        </div>
      )}
      {(status === "error" || status === "closed") && (
        <div
          role="status"
          className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 bg-neutral-900/90 px-3 py-2 text-sm text-neutral-200"
        >
          <span>
            {status === "error"
              ? `接続エラー: ${error ?? "不明なエラー"}`
              : "セッションが終了しました"}
          </span>
          <span className="flex items-center gap-2">
            {autoReconnect.enabled && status === "error" && (
              <AutoReconnectNotice
                needsSecret={needsSecret}
                remaining={auto.remaining}
                attempt={auto.attempt}
                maxLabel={maxLabel}
                maxAttempts={autoReconnect.maxAttempts}
                exhausted={auto.exhausted}
                onCancel={auto.cancel}
              />
            )}
            <Button size="sm" onClick={reconnect}>
              再接続
            </Button>
          </span>
        </div>
      )}
    </div>
  );
}

/** 自動再接続の状況（カウントダウン・上限・再接続できない理由）の表示。 */
function AutoReconnectNotice({
  needsSecret,
  remaining,
  attempt,
  maxLabel,
  maxAttempts,
  exhausted,
  onCancel,
}: {
  needsSecret: boolean;
  remaining: number | null;
  attempt: number;
  maxLabel: string;
  maxAttempts: number;
  exhausted: boolean;
  onCancel: () => void;
}) {
  if (needsSecret) {
    return (
      <span className="text-amber-300">
        パスワード認証のため、自動再接続できません
      </span>
    );
  }
  if (exhausted) {
    return (
      <span className="text-amber-300">
        上限（{maxAttempts}回）に達したため、自動再接続を止めました
      </span>
    );
  }
  if (remaining === null) return null;
  return (
    <span className="flex items-center gap-2 text-sky-300">
      {remaining}秒後に自動再接続します（{attempt + 1}/{maxLabel}回目）
      <Button
        size="sm"
        variant="outline"
        aria-label="自動再接続をキャンセル"
        onClick={onCancel}
      >
        キャンセル
      </Button>
    </span>
  );
}

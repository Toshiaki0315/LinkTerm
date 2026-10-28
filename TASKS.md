# 開発タスク一覧 (TASKS) - LinkTerm

TDD（テスト駆動開発）の原則に従い、以下のフェーズに分けて段階的に実装します。

## Phase 1: プロジェクト基盤の構築

- [x] `npm create tauri-app@latest` によるプロジェクト初期化 (Tauri v2 + React + TypeScript + Vite)。
- [x] プロダクト名を `LinkTerm` に設定（`tauri.conf.json`, `Cargo.toml`, `package.json`）。
- [ ] フロントエンド設定: Tailwind CSS ✅ / Lucide Icons ✅ / shadcn/ui（未導入）。
- [x] テスト環境設定: Rust(Cargo test) および Frontend(Vitest + React Testing Library + happy-dom) のセットアップ。
- [x] GitHub ActionsによるCIパイプラインの構築（Formatチェックとテスト自動実行）。

## Phase 2: 共通インターフェース設計 (Rustバックエンド)

- [x] `TerminalSession` トレイトの定義。
- [x] 汎用エラー型 `TerminalError` の定義（`thiserror` クレート使用）。
- [x] TDD: 上記トレイトを実装したテスト用 `MockSession` の作成と単体テスト。

## Phase 3: PTY（ローカルシェル）実装

- [x] TDD: `portable-pty` を用いたPTY起動、送受信の単体テスト作成。
- [x] `LocalShellSession` の実装。

## Phase 4: SSH プロトコル実装

- [x] TDD: モック用SSHサーバーを用いたテスト作成。
- [x] `russh` を用いた `SshSession` の実装。
- [x] macOS Keychain (`keyring` 等) を用いた認証情報管理。

## Phase 5: Telnet & Serial 実装

- [x] TDD: Telnet IACパーサー、NAWS生成の単体テスト。
- [x] `TelnetSession` の実装。
- [x] TDD: LF/CRLF変換ロジックの関数テスト。
- [x] `tokio-serial` を用いた `SerialSession` の実装。

## Phase 6: Tauri IPC & フロントエンドフック

- [x] Tauri Commands (セッション開始・停止) の実装。
- [x] Tauri Events (データ送受信・終了通知) の実装。
- [x] Reactカスタムフック (`useTerminalSession`) のTDD実装。

## Phase 7: UI / UX 開発 (React + shadcn/ui)

- [x] `xterm.js` コンポーネント実装（**Keep-Aliveによる状態保持を徹底**）。
- [x] タブ管理UI（ShadcnのTabsコンポーネント応用）の実装。
- [x] 接続先設定ダイアログ（React Hook Form + Zod）の実装。
- [x] 配布: アドホック署名の DMG を作成（DISTRIBUTION.md）。Developer ID 署名・公証は未実施。
- [ ] アプリケーション全体のエンドツーエンド（統合）動作確認。

## Phase 8: 横断機能

- [x] 文字コード変換層（`encoding_rs`、接続ごとに選択）。
- [x] セッションログ（Tee分岐: 生データ/テキスト、タイムスタンプ、追記、0600権限、実行中の開始・停止）。
- [x] ESLint 導入とCIへの組み込み。
- [x] 実機・GUIでの動作確認: ローカルシェル / Telnet（Shift_JIS・NAWS） / SSH（公開鍵・ホスト鍵承認・突然切断）。
- [ ] 実機確認: シリアル（USBシリアル機器）、SSH パスワード/Agent 認証、Keychain 保存。
- [x] オリジナルアイコン、ショートカット、再接続、接続プロファイルの保存。
- [x] 設定メニュー（メニューバー「設定…」⌘,）: フォント・サイズ・スクロールバック・カーソル点滅・起動時に開くターミナル。
- [x] ローカルエコー切替（自動/オン/オフ、Telnet `remote_echo()` 自動判定）。
- [x] シリアル実用機能（HEX 表示、DTR/RTS、ブレーク送信、手入力ポート名）。
- [x] SSH 補強（`~/.ssh/config` 別名解決、ProxyJump）。`Include`（ワイルドカード可）と `Match all/host/originalhost` に対応。他の `Match` 条件は未対応。
- [x] 検索（⌘F）、タブ名変更・複製・並べ替え、配色テーマ、コピー便利機能、自動再接続、画面状態の復元。
- [ ] 上記新機能の実機・GUI 確認（シリアル実機、踏み台経由の実サーバ）。
- [x] SSH ポートフォワード（`-L`、`-D` SOCKS5（認証なし・CONNECTのみ）、127.0.0.1 限定。`~/.ssh/config` の `LocalForward` / `DynamicForward` 対応）。
- [x] シリアルの送受信改行変換。
- [x] SSH リモートフォワード（`-R`、サーバー側はループバック。`~/.ssh/config` の `RemoteForward` 対応）。
- [x] タブの色分け（8色。接続ダイアログ・右クリックで設定）。
- [x] 端末エミュレーション設定（TERM を VT100/VT102/VT220/xterm/ANSI/linux から接続ごとに選択＝SSH・Telnet。バックスペース DEL/BS、Option を Meta、カーソルの形は設定画面）。
- [x] 画面分割（⌘D 左右／⌘⇧D 上下、⌘]・⌘[ でペイン移動、⌘W で操作中のペインを閉じる、境目のドラッグで大きさ変更、右クリックメニューからも操作）。分割は画面復元の対象外（先頭のペインのみ復元）。
- [x] 最近使った接続（タブバーの履歴メニュー・接続ダイアログから選択。`recent.json`、パスワード類は保存しない）。

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

- [ ] TDD: Telnet IACパーサー、NAWS生成の単体テスト。
- [ ] `TelnetSession` の実装。
- [ ] TDD: LF/CRLF変換ロジックの関数テスト。
- [ ] `tokio-serial` を用いた `SerialSession` の実装。

## Phase 6: Tauri IPC & フロントエンドフック

- [ ] Tauri Commands (セッション開始・停止) の実装。
- [ ] Tauri Events (データ送受信・終了通知) の実装。
- [ ] Reactカスタムフック (`useTerminalSession`) のTDD実装。

## Phase 7: UI / UX 開発 (React + shadcn/ui)

- [ ] `xterm.js` コンポーネント実装（**Keep-Aliveによる状態保持を徹底**）。
- [ ] タブ管理UI（ShadcnのTabsコンポーネント応用）の実装。
- [ ] 接続先設定ダイアログ（React Hook Form + Zod）の実装。
- [ ] アプリケーション全体のエンドツーエンド（統合）動作確認。

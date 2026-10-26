# 要求仕様書 (SPECIFICATION) - LinkTerm

## 1. 全体アーキテクチャ・共通インターフェース

- フロントエンドとバックエンドの通信はTauri v2 IPC (Commands / Events) を利用する。
- すべてのターミナルセッションはRust側で共通の非同期トレイト `TerminalSession` を実装する。

## 2. セキュリティ要求

- SSHキーやパスワードの保存は macOS Keychain (`keyring` クレートなど) に限定し、平文でのファイル保存を禁止する。
- SSHのHost Key検証を必須とし、未知のホストへの初回接続時はユーザーに承認を求めるダイアログ（Reactコンポーネント）を表示する。

## 3. フロントエンド仕様 (React + shadcn/ui)

### 3.1 タブ管理システム

- 複数のターミナルセッションを保持し切り替えるUIを提供する。
- **【重要】** 各タブの `xterm.js` インスタンスはアンマウントせず、非表示状態（`hidden`）にして状態（スクロール、履歴）を保持する。

### 3.2 接続設定ダイアログ

- `React Hook Form` + `Zod` を使用したバリデーション。
- **SSH**: ホスト、ポート、ユーザー名、認証方式（パスワード / 鍵パス + パスフレーズ / Agent）の入力。
- **Serial**: ポート名（リストからの選択）、Baud rate、Data bits、Parity、Stop bits、Flow control。
- **Telnet**: ホスト、ポート、エンコーディング、CR/LF処理設定。

## 4. 各ターミナル仕様 (Rustバックエンド)

### 4.1 ローカルシェル (Internal Shell)

- macOSのPTY（`portable-pty`等）経由。環境変数透過。

### 4.2 SSH

- `russh` クレート等。公開鍵、パスワード、SSH Agent。KeepAlive対応。

### 4.3 Telnet

- TCPソケット ＋ IAC交渉。NAWS、ECHO制御、CR/LFモード切替。

### 4.4 シリアル通信 (Serial)

- `tokio-serial` クレート等。USB抜去時の即座なI/Oエラーハンドリング（フェイルセーフ）。

## 5. エンコーディングとログ処理 (設計要件)

- 生バイトデータ受信からxterm.js描画までの間にエンコーディング変換層を挟めるアーキテクチャ。
- ターミナルログ取得基盤としてのストリーム分岐（Tee）設計。

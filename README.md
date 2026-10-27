# LinkTerm

macOS向けのモダンなマルチプロトコルターミナルエミュレータです。
ローカルシェル、SSH、Telnet、シリアル通信をタブで切り替えて利用できます。現場での実用性に耐えうる堅牢性とセキュリティを最重要視して設計されています。

## 特徴

- **マルチプロトコル対応**: Local Shell (PTY), SSH, Telnet, Serial 通信を統合管理
- **モダン & 軽量**: Tauri v2 + Rust + React + Vite + Tailwind CSS (shadcn/ui) + xterm.js
- **セキュア**: 認証情報（SSHキー・パスワード）はmacOS Keychainで安全に管理
- **文字コード対応**: UTF-8 / Shift_JIS / EUC-JP / GBK / Big5 / EUC-KR / windows-1252 を接続ごとに選択
- **セッションログ**: 受信内容を生データ／テキストで記録（タイムスタンプ・追記対応、ファイルは所有者のみ読み書き可）
- **保存済みの接続**: 接続先をプロファイルとして保存（パスワード・パスフレーズは保存しない）
- **ショートカット**: ⌘T 新規接続 / ⌘W タブを閉じる / ⌘1〜9 タブ切替 / ⌘⇧[ ⌘⇧] 前後のタブ
- **再接続**: 切断・エラー後にワンクリックで再接続
- **設定**: メニューバー「LinkTerm → 設定…」（⌘,）でフォント（インストール済みのフォントからリストで選択）・サイズ・スクロールバック・カーソル点滅・起動時に開くターミナル（なし／ローカルシェル／保存済みの接続）を変更。保存先は `~/Library/Application Support/com.linkterm.app/settings.json`
- **ローカルエコー**: 接続ごと／実行中に 自動・オン・オフを切替（Telnet は `remote_echo()` を自動判定）
- **シリアル**: 送受信の改行変換、手入力のポート名、HEX ダンプ表示、DTR/RTS 操作、ブレーク送信
- **SSH**: `~/.ssh/config` のホスト別名・User・Port・IdentityFile の解決（`Include`・`Match host` 対応）、踏み台（ProxyJump、複数段可）。踏み台にはパスワードを送らず、Agent → 鍵の順で認証。ポートフォワード（`-L`、SOCKS5プロキシ `-D`、リモートフォワード `-R`。待ち受けは両側ともループバックのみ。`~/.ssh/config` の `LocalForward` / `DynamicForward` / `RemoteForward` も反映）
- **検索・タブ**: ⌘F 検索、タブの名前変更・複製・並べ替え、タブの色分け（接続ダイアログまたはタブの右クリックで設定。保存済みの接続や復元にも引き継ぐ）
- **最近使った接続**: タブバーの「▾」から最近の接続先（最大20件、パスワードは保存しない）を選んで再接続。接続ダイアログからも選べる
- **配色テーマ**: 暗い／明るい／Solarized など 6 種
- **コピー**: 選択でコピー、右クリックメニュー、URL クリックで開く
- **自動再接続・画面復元**: 切断時の自動再接続、終了時のタブ構成（接続先のみ。パスワードは含まない）を次回起動時に復元
- **高品質設計**: TDDに基づく開発プロセス、厳密なエラーハンドリング、接続切断への強い耐性

## 開発環境のセットアップ

### 必須要件

- macOS (11.0 Big Sur 以降推奨)
- Node.js (v18+)
- Rust (latest stable)

### 起動手順

```bash
npm install
npm run tauri dev
```

### 開発コマンド

```bash
npm test            # フロントエンドのテスト (Vitest)
npm run lint        # ESLint
npm run typecheck   # TypeScript 型チェック
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
```

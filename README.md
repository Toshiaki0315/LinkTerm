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

# LinkTerm

macOS向けのモダンなマルチプロトコルターミナルエミュレータです。
ローカルシェル、SSH、Telnet、シリアル通信をタブで切り替えて利用できます。現場での実用性に耐えうる堅牢性とセキュリティを最重要視して設計されています。

## 特徴

- **マルチプロトコル対応**: Local Shell (PTY), SSH, Telnet, Serial 通信を統合管理
- **モダン & 軽量**: Tauri v2 + Rust + React + Vite + Tailwind CSS (shadcn/ui) + xterm.js
- **セキュア**: 認証情報（SSHキー・パスワード）はmacOS Keychainで安全に管理
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

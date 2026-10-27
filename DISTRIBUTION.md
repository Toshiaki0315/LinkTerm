# 配布手順 (DISTRIBUTION) - LinkTerm

## 現在の方式: アドホック署名

Apple Developer Program 未登録のため、`src-tauri/tauri.conf.json` の `bundle.macOS.signingIdentity` を `"-"`（アドホック署名）にしています。公証（notarization）は行いません。

```bash
make dmg   # => src-tauri/target/release/bundle/dmg/LinkTerm_<版>_<arch>.dmg
```

署名の確認: `codesign -dv LinkTerm.app` で `Signature=adhoc`、`codesign --verify --deep --strict LinkTerm.app` がエラーなし。

### 受け取った人が初めて開くとき

アドホック署名のアプリは Gatekeeper に「開発元を確認できません」と止められます。次のどちらかで開きます。

- Finder で LinkTerm.app を右クリック →「開く」→ ダイアログで「開く」。
- または、ダウンロードの隔離属性を外す: `xattr -dr com.apple.quarantine /Applications/LinkTerm.app`

ビルドしたマシンの CPU 向け（Apple Silicon なら aarch64）のみ作られます。Intel 向けや両対応が必要なら `npm run tauri build -- --target universal-apple-darwin` を使います。

## 将来: Developer ID 署名と公証

Apple Developer Program 登録後、環境変数を設定してビルドすれば Tauri が署名と公証を行います。

1. 「Developer ID Application」証明書をキーチェーンに入れる。
2. 次を設定して `make dmg`（`tauri.conf.json` の `signingIdentity` は環境変数で上書き）:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: 氏名 (TEAMID)"
export APPLE_ID="apple-id@example.com"
export APPLE_PASSWORD="アプリ用パスワード"   # appleid.apple.com で発行。履歴やリポジトリに残さない
export APPLE_TEAM_ID="TEAMID"
```

3. 確認: `spctl -a -vv LinkTerm.app` が `accepted / source=Notarized Developer ID`。

この環境変数・パスワードは決してコミットしないでください。

# LinkTerm ビルド用 Makefile
#   make dev  : 開発モードで起動（ホットリロード）
#   make app  : リリース版 LinkTerm.app を作成
#   make dmg  : リリース版 LinkTerm.dmg を作成

BUNDLE_DIR := src-tauri/target/release/bundle

.DEFAULT_GOAL := help
.PHONY: help dev app dmg test clean

help: ## コマンド一覧を表示
	@grep -E '^[a-z]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-6s %s\n", $$1, $$2}'

# package.json / package-lock.json が更新されたときだけ依存関係を入れ直す。
node_modules: package.json package-lock.json
	npm ci
	@touch node_modules

dev: node_modules ## 開発モードで起動する
	npm run tauri dev

app: node_modules ## LinkTerm.app をビルドする
	npm run tauri build -- --bundles app
	@echo "=> $(BUNDLE_DIR)/macos/LinkTerm.app"

dmg: node_modules ## LinkTerm.dmg をビルドする
	npm run tauri build -- --bundles dmg
	@echo "=> $$(ls $(BUNDLE_DIR)/dmg/*.dmg)"

test: node_modules ## フロントエンドとRustのテストを実行する
	npm test
	cd src-tauri && cargo test

clean: ## ビルド成果物を削除する
	rm -rf dist
	cd src-tauri && cargo clean

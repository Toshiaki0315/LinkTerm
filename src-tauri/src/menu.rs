//! アプリケーションメニュー。
//!
//! 標準メニューの「ウィンドウを閉じる」(⌘W) は、キー入力を奪ってアプリごと閉じてしまう。
//! ⌘W は「タブを閉じる」として画面側で処理するため、その項目を除いたメニューを組み立てる。
//! コピー／ペーストなどの編集項目は xterm.js の ⌘C / ⌘V のために残す。

use tauri::menu::{Menu, MenuEvent, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Wry};

pub const SETTINGS_MENU_ID: &str = "settings";
/// 「設定…」が選ばれたことをフロントエンドへ伝えるイベント名。
pub const EVENT_OPEN_SETTINGS: &str = "menu-open-settings";

/// メニュー項目のIDに対応する、フロントエンドへ通知するイベント名。
pub fn event_for_menu_id(id: &str) -> Option<&'static str> {
    match id {
        SETTINGS_MENU_ID => Some(EVENT_OPEN_SETTINGS),
        _ => None,
    }
}

/// メニュー項目が選ばれたときの処理。
pub fn handle_event(app: &AppHandle, event: MenuEvent) {
    if let Some(name) = event_for_menu_id(event.id().as_ref())
        && let Err(e) = app.emit(name, ())
    {
        eprintln!("メニューイベントの送信に失敗しました ({name}): {e}");
    }
}

/// メニューの表示名（OS の言語設定によらず日本語で表示する）。
pub const MENU_LABELS: &[&str] = &[
    "LinkTermについて",
    "サービス",
    "LinkTermを隠す",
    "ほかを隠す",
    "すべてを表示",
    "LinkTermを終了",
    "編集",
    "取り消す",
    "やり直す",
    "切り取り",
    "コピー",
    "貼り付け",
    "すべてを選択",
    "表示",
    "フルスクリーンにする",
    "ウィンドウ",
    "しまう",
    "拡大/縮小",
];

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let settings = MenuItemBuilder::with_id(SETTINGS_MENU_ID, "設定…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "LinkTerm")
        .about_with_text("LinkTermについて", None)
        .separator()
        .item(&settings)
        .separator()
        .services_with_text("サービス")
        .separator()
        .hide_with_text("LinkTermを隠す")
        .hide_others_with_text("ほかを隠す")
        .show_all_with_text("すべてを表示")
        .separator()
        .quit_with_text("LinkTermを終了")
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "編集")
        .undo_with_text("取り消す")
        .redo_with_text("やり直す")
        .separator()
        .cut_with_text("切り取り")
        .copy_with_text("コピー")
        .paste_with_text("貼り付け")
        .select_all_with_text("すべてを選択")
        .build()?;
    let view_menu = SubmenuBuilder::new(app, "表示")
        .fullscreen_with_text("フルスクリーンにする")
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "ウィンドウ")
        .minimize_with_text("しまう")
        .maximize_with_text("拡大/縮小")
        .build()?;
    Menu::with_items(app, &[&app_menu, &edit_menu, &view_menu, &window_menu])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_menu_id_maps_to_the_open_settings_event() {
        assert_eq!(event_for_menu_id("settings"), Some("menu-open-settings"));
        assert_eq!(
            event_for_menu_id(SETTINGS_MENU_ID),
            Some(EVENT_OPEN_SETTINGS)
        );
    }

    #[test]
    fn menu_labels_are_japanese() {
        for label in MENU_LABELS {
            assert!(!label.is_ascii(), "{label}");
        }
    }

    #[test]
    fn unknown_menu_ids_are_ignored() {
        assert_eq!(event_for_menu_id(""), None);
        assert_eq!(event_for_menu_id("quit"), None);
        assert_eq!(event_for_menu_id("Settings"), None);
    }
}

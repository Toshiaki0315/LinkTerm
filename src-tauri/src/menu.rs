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

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let settings = MenuItemBuilder::with_id(SETTINGS_MENU_ID, "設定…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "LinkTerm")
        .about(None)
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view_menu = SubmenuBuilder::new(app, "View").fullscreen().build()?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
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
    fn unknown_menu_ids_are_ignored() {
        assert_eq!(event_for_menu_id(""), None);
        assert_eq!(event_for_menu_id("quit"), None);
        assert_eq!(event_for_menu_id("Settings"), None);
    }
}

//! アプリケーションメニュー。
//!
//! 標準メニューの「ウィンドウを閉じる」(⌘W) は、キー入力を奪ってアプリごと閉じてしまう。
//! ⌘W は「タブを閉じる」として画面側で処理するため、その項目を除いたメニューを組み立てる。
//! コピー／ペーストなどの編集項目は xterm.js の ⌘C / ⌘V のために残す。

use tauri::menu::{Menu, SubmenuBuilder};
use tauri::{AppHandle, Wry};

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let app_menu = SubmenuBuilder::new(app, "LinkTerm")
        .about(None)
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

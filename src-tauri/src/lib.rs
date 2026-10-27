pub mod approvals;
pub mod atomic_file;
pub mod commands;
pub mod fonts;
pub mod manager;
pub mod menu;
pub mod profiles;
pub mod session;
pub mod session_state;
pub mod settings;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .menu(menu::build)
        .on_menu_event(menu::handle_event)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let state = commands::AppState::new(app.handle())?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_local_shell,
            commands::start_ssh,
            commands::start_telnet,
            commands::start_serial,
            commands::list_serial_ports,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_close,
            commands::serial_set_control,
            commands::serial_send_break,
            commands::set_display_mode,
            commands::default_log_path,
            commands::start_session_log,
            commands::stop_session_log,
            commands::respond_host_key,
            commands::pending_host_key_requests,
            commands::list_profiles,
            commands::save_profile,
            commands::delete_profile,
            commands::list_fonts,
            commands::get_session_state,
            commands::save_session_state,
            commands::get_settings,
            commands::save_settings,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event
            && let Some(state) = handle.try_state::<commands::AppState>()
        {
            tauri::async_runtime::block_on(state.manager.close_all());
        }
    });
}

#[cfg(test)]
mod tests {
    /// フロントエンドが使う権限が capability に宣言されていること（宣言漏れは実行時にだけ失敗する）。
    #[test]
    fn capability_grants_exactly_the_clipboard_and_opener_permissions_the_ui_needs() {
        let text = include_str!("../capabilities/default.json");
        let json: serde_json::Value = serde_json::from_str(text).unwrap();
        let permissions: Vec<&str> = json["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect();
        for needed in [
            "core:default",
            "opener:default",
            "clipboard-manager:allow-read-text",
            "clipboard-manager:allow-write-text",
        ] {
            assert!(permissions.contains(&needed), "{needed} が未宣言");
        }
        // 画像などの余計なクリップボード権限は付けない。
        assert!(!permissions.iter().any(|p| p.contains("image")));
        assert!(!permissions.contains(&"clipboard-manager:default"));
    }
}

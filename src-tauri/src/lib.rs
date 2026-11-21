pub mod approvals;
pub mod atomic_file;
pub mod commands;
pub mod export;
pub mod file_dialogs;
pub mod fonts;
pub mod highlights;
pub mod keybindings;
pub mod macros;
pub mod manager;
pub mod menu;
pub mod profiles;
pub mod recent;
pub mod session;
pub mod session_state;
pub mod settings;
pub mod sftp;
pub mod sftp_commands;
#[cfg(test)]
mod sftp_e2e_tests;
pub mod snippets;
pub mod ssh_config;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .menu(menu::build)
        .on_menu_event(menu::handle_event)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let state = commands::AppState::new(app.handle())?;
            app.manage(state);
            app.manage(sftp_commands::SftpState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_local_shell,
            commands::start_ssh,
            commands::list_ssh_hosts,
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
            commands::export_profiles_dialog,
            commands::import_profiles_dialog,
            commands::delete_profile,
            commands::list_fonts,
            commands::get_session_state,
            commands::save_session_state,
            sftp_commands::sftp_list,
            sftp_commands::sftp_download,
            sftp_commands::sftp_upload,
            sftp_commands::sftp_mkdir,
            sftp_commands::sftp_remove,
            sftp_commands::sftp_cancel,
            commands::save_screen_text,
            commands::update_profile,
            commands::get_keybindings,
            commands::save_keybindings,
            commands::get_highlight_rules,
            commands::save_highlight_rules,
            commands::get_snippets,
            commands::save_snippets,
            commands::get_macros,
            commands::save_macros,
            commands::pick_macro_file,
            commands::get_recent_connections,
            commands::save_recent_connections,
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
    /// 権限の識別子（文字列、またはスコープつきのオブジェクト）を取り出す。
    fn identifiers(json: &serde_json::Value) -> Vec<String> {
        json["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                p.as_str()
                    .or_else(|| p["identifier"].as_str())
                    .unwrap()
                    .to_owned()
            })
            .collect()
    }

    /// フロントエンドが使う権限が capability に宣言されていること（宣言漏れは実行時にだけ失敗する）。
    #[test]
    fn capability_grants_exactly_the_clipboard_and_opener_permissions_the_ui_needs() {
        let text = include_str!("../capabilities/default.json");
        let json: serde_json::Value = serde_json::from_str(text).unwrap();
        let permissions = identifiers(&json);
        for needed in [
            "core:default",
            "opener:allow-open-url",
            "clipboard-manager:allow-read-text",
            "clipboard-manager:allow-write-text",
        ] {
            assert!(permissions.iter().any(|p| p == needed), "{needed} が未宣言");
        }
        // 画像などの余計なクリップボード権限は付けない。
        assert!(!permissions.iter().any(|p| p.contains("image")));
        assert!(!permissions.iter().any(|p| p == "clipboard-manager:default"));
    }

    /// ファイルを読み書きするダイアログは、バックエンドが開く。画面（WebView）が保存ダイアログを
    /// 直接使える権限は付けない（選ばれたパスを、そのまま任意のコマンドへ渡せてしまうため）。
    #[test]
    fn webview_cannot_open_the_save_dialog_directly() {
        let text = include_str!("../capabilities/default.json");
        let json: serde_json::Value = serde_json::from_str(text).unwrap();
        let permissions = identifiers(&json);
        assert!(!permissions.iter().any(|p| p == "dialog:allow-save"));
        assert!(!permissions.iter().any(|p| p == "dialog:default"));
    }

    /// 外部で開けるのは http / https の URL だけ。`opener:default` は、`mailto:`・`tel:` や
    /// Finder での項目表示、パスを開く権限まで含むので使わない。
    #[test]
    fn opener_is_limited_to_http_and_https_urls() {
        let text = include_str!("../capabilities/default.json");
        let json: serde_json::Value = serde_json::from_str(text).unwrap();
        let permissions = identifiers(&json);
        assert!(!permissions.iter().any(|p| p == "opener:default"));
        assert!(!permissions.iter().any(|p| p.contains("reveal-item")));
        assert!(!permissions.iter().any(|p| p.contains("open-path")));
        assert!(!permissions.iter().any(|p| p == "opener:allow-default-urls"));
        let scoped = json["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["identifier"] == "opener:allow-open-url")
            .expect("opener:allow-open-url にはスコープを付ける");
        let urls: Vec<&str> = scoped["allow"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["url"].as_str().unwrap())
            .collect();
        assert_eq!(urls, ["https://*", "http://*"]);
    }
}

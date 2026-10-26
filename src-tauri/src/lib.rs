pub mod approvals;
pub mod commands;
pub mod manager;
pub mod menu;
pub mod session;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .menu(menu::build)
        .plugin(tauri_plugin_opener::init())
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
            commands::default_log_path,
            commands::start_session_log,
            commands::stop_session_log,
            commands::respond_host_key,
            commands::pending_host_key_requests,
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

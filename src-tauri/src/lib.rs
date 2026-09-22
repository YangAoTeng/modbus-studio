//! Modbus Studio Tauri 应用入口（Rust 后端，替代原 Electron 主进程）。

mod commands;
mod protocol;
mod services;
mod state;
mod types;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(AppState::new(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::serial_list,
            commands::serial_open,
            commands::serial_close,
            commands::tcp_connect,
            commands::tcp_disconnect,
            commands::udp_connect,
            commands::udp_disconnect,
            commands::client_read_registers,
            commands::client_write_single,
            commands::client_write_multiple,
            commands::server_start_instance,
            commands::server_stop_instance,
            commands::server_update_instance_data,
            commands::project_open,
            commands::project_open_path,
            commands::project_save,
            commands::project_list_recent,
            commands::project_remove_recent,
            commands::dictionary_export,
            commands::dictionary_import,
            commands::log_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

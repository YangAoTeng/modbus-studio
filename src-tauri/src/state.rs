//! 全局共享状态，由 Tauri 注入（`tauri::Builder::manage`）。

use std::sync::{Arc, Mutex as StdMutex};

use tauri::AppHandle;

use crate::services::modbus_server::ModbusServer;
use crate::services::serial::SerialHandle;
use crate::services::tcp_client::TcpClient;
use crate::services::udp_client::UdpClient;

/// 应用运行时状态，供各 Tauri 命令共享。
pub struct AppState {
    pub serial: SerialHandle,
    pub tcp: TcpClient,
    pub udp: UdpClient,
    pub server: ModbusServer,
}

impl AppState {
    pub fn new(app: AppHandle) -> Self {
        Self {
            serial: Arc::new(StdMutex::new(None)),
            tcp: TcpClient::new(),
            udp: UdpClient::new(),
            server: ModbusServer::new(app),
        }
    }
}

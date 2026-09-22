//! Modbus Studio 前后端数据契约（Rust 侧）。
//!
//! 字段命名使用 `rename_all = "camelCase"`，以与 `src/shared/types.ts` 中的
//! TypeScript 接口以及前端 `invoke` 传参保持二进制兼容。

use serde::{Deserialize, Serialize};

/// 串口校验位。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Parity {
    None,
    Even,
    Odd,
}

/// 协议模式。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum ProtocolMode {
    Rtu,
    Tcp,
    Udp,
}

/// 串口配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialConfig {
    pub path: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub stop_bits: u8,
    pub parity: Parity,
    pub timeout: u64,
}

/// TCP / UDP 连接配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpConfig {
    pub host: String,
    pub port: u16,
    pub timeout: u64,
}

/// 读取寄存器参数（FC01~04）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadRegistersParams {
    pub protocol: Option<ProtocolMode>,
    pub slave_id: u8,
    pub function_code: u8,
    pub start_address: u32,
    pub quantity: u32,
    pub timeout: u64,
}

/// 写入单个寄存器 / 线圈参数（FC05 / FC06）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteRegisterParams {
    pub protocol: Option<ProtocolMode>,
    pub slave_id: u8,
    pub function_code: Option<u8>,
    pub address: u32,
    pub value: u16,
    pub timeout: u64,
}

/// 写入多个寄存器 / 线圈参数（FC15 / FC16）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteMultipleRegistersParams {
    pub protocol: Option<ProtocolMode>,
    pub slave_id: u8,
    pub function_code: Option<u8>,
    pub start_address: u32,
    pub values: Vec<u16>,
    pub timeout: u64,
}

/// 单次 Modbus 事务结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionResult {
    pub tx: String,
    pub rx: String,
    pub registers: Vec<u16>,
    pub elapsed_ms: u64,
    pub crc_valid: bool,
}

/// 四区数据区名称。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServerAreaName {
    Coil,
    Discrete,
    Input,
    Holding,
}

/// 从站实例配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInstanceConfig {
    pub id: String,
    pub name: String,
    pub slave_id: u8,
    pub tcp_host: String,
    pub tcp_port: u16,
    pub protocol: ProtocolMode,
    pub points: Option<Vec<RegisterDefinition>>,
    pub serial: Option<SerialConfig>,
}

/// 从站数据区单点更新。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerDataUpdate {
    pub area: ServerAreaName,
    pub address: u32,
    pub value: u16,
}

/// 从站事件（由后端推送到前端，前端 `listen('server_event')` 接收）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerEvent {
    pub r#type: String,
    pub instance_id: Option<String>,
    pub running: Option<bool>,
    pub protocol: Option<ProtocolMode>,
    pub update: Option<ServerDataUpdate>,
    pub log: Option<LogPayload>,
}

/// 报文日志条目（事件推送用，省略 id）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPayload {
    pub time: String,
    pub direction: String,
    pub protocol: String,
    pub raw: String,
    pub parsed: String,
    pub elapsed_ms: u64,
    pub status: String,
}

/// 完整报文日志条目（导出用，含 id）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PacketLogItem {
    pub id: u32,
    pub time: String,
    pub direction: String,
    pub protocol: String,
    pub raw: String,
    pub parsed: String,
    pub elapsed_ms: u64,
    pub status: String,
}

/// 最近打开工程记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub opened_at: String,
}

/// 寄存器字典条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterDefinition {
    pub group: String,
    pub address: u32,
    pub name: String,
    pub data_type: String,
    pub length: u32,
    pub access: String,
    pub factor: f64,
    pub unit: String,
    pub remark: String,
    pub slave_id: Option<u32>,
}

//! Tauri 命令：映射前端 `invoke` 调用到 Rust 服务 / 文件 / 对话框。
//!
//! 前端桥接（`src/renderer/bridge.ts`）按 `ModbusApi` 接口契约调用这些命令。

use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::FilePath;
use tauri_plugin_dialog::DialogExt;

use crate::protocol::crc16::frame_to_hex;
use crate::protocol::tcp_frame::{
    build_tcp_read_frame, build_tcp_write_multiple_coils_frame, build_tcp_write_multiple_frame,
    build_tcp_write_single_coil_frame, build_tcp_write_single_frame, parse_tcp_read_response,
};
use crate::services::modbus_client;
use crate::services::serial;
use crate::state::AppState;
use crate::types::*;

/// 把 dialog 返回的 `FilePath`（枚举：Path / Url 两种变体）转成可落盘的字符串路径。
/// `FilePath` 没有 `to_string_lossy` 方法；用官方 `into_path()`（Url 变体内部走 `Url::to_file_path`）。
fn file_path_to_string(fp: FilePath) -> String {
    fp.into_path()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

// ----------------------------- 串口 / 连接 -----------------------------

#[tauri::command]
pub async fn serial_list(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let _ = state;
    serial::list_ports().await
}

#[tauri::command]
pub async fn serial_open(state: State<'_, AppState>, config: SerialConfig) -> Result<(), String> {
    serial::open(&state.serial, config).await
}

#[tauri::command]
pub async fn serial_close(state: State<'_, AppState>) -> Result<(), String> {
    serial::close(&state.serial).await
}

#[tauri::command]
pub async fn tcp_connect(state: State<'_, AppState>, config: TcpConfig) -> Result<(), String> {
    state.tcp.connect(&config).await
}

#[tauri::command]
pub async fn tcp_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    state.tcp.disconnect().await
}

#[tauri::command]
pub async fn udp_connect(state: State<'_, AppState>, config: TcpConfig) -> Result<(), String> {
    state.udp.connect(&config).await
}

#[tauri::command]
pub async fn udp_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    state.udp.disconnect().await
}

// ----------------------------- 主站事务 -----------------------------

#[tauri::command]
pub async fn client_read_registers(
    state: State<'_, AppState>,
    params: ReadRegistersParams,
) -> Result<TransactionResult, String> {
    let protocol = params.protocol.unwrap_or(ProtocolMode::Rtu);
    match protocol {
        ProtocolMode::Tcp => {
            let tid = state.tcp.next_transaction_id();
            let req = build_tcp_read_frame(
                tid,
                params.slave_id,
                params.function_code,
                params.start_address as u16,
                params.quantity as u16,
            );
            let start = Instant::now();
            let resp = state.tcp.transact(&req, params.timeout).await?;
            let tx = frame_to_hex(&req);
            let registers = parse_tcp_read_response(&resp, tid, params.slave_id, params.function_code, params.quantity)
                .map_err(|e| format!("TX {} | {}", tx, e))?;
            Ok(TransactionResult {
                tx,
                rx: frame_to_hex(&resp),
                registers,
                elapsed_ms: elapsed(start),
                crc_valid: true,
            })
        }
        ProtocolMode::Udp => {
            let tid = state.udp.next_transaction_id();
            let req = build_tcp_read_frame(
                tid,
                params.slave_id,
                params.function_code,
                params.start_address as u16,
                params.quantity as u16,
            );
            let start = Instant::now();
            let resp = state.udp.transact(&req, params.timeout).await?;
            let tx = frame_to_hex(&req);
            let registers = parse_tcp_read_response(&resp, tid, params.slave_id, params.function_code, params.quantity)
                .map_err(|e| format!("TX {} | {}", tx, e))?;
            Ok(TransactionResult {
                tx,
                rx: frame_to_hex(&resp),
                registers,
                elapsed_ms: elapsed(start),
                crc_valid: true,
            })
        }
        ProtocolMode::Rtu => modbus_client::read_registers(&state.serial, &params).await,
    }
}

#[tauri::command]
pub async fn client_write_single(
    state: State<'_, AppState>,
    params: WriteRegisterParams,
) -> Result<TransactionResult, String> {
    let is_coil = params.function_code == Some(5);
    let protocol = params.protocol.unwrap_or(ProtocolMode::Rtu);
    match protocol {
        ProtocolMode::Tcp => tcp_like_write_single(&state.tcp, &params, is_coil).await,
        ProtocolMode::Udp => tcp_like_write_single_udp(&state.udp, &params, is_coil).await,
        ProtocolMode::Rtu => modbus_client::write_single_register(&state.serial, params).await,
    }
}

#[tauri::command]
pub async fn client_write_multiple(
    state: State<'_, AppState>,
    params: WriteMultipleRegistersParams,
) -> Result<TransactionResult, String> {
    if params.values.is_empty() || params.values.len() > 123 {
        return Err("写入数量必须在 1 到 123 之间".to_string());
    }
    let is_coil = params.function_code == Some(15);
    let protocol = params.protocol.unwrap_or(ProtocolMode::Rtu);
    match protocol {
        ProtocolMode::Tcp => tcp_like_write_multiple(&state.tcp, &params, is_coil).await,
        ProtocolMode::Udp => tcp_like_write_multiple_udp(&state.udp, &params, is_coil).await,
        ProtocolMode::Rtu => modbus_client::write_multiple_registers(&state.serial, params).await,
    }
}

// TCP 写单个（含 transact 源选择）。
async fn tcp_like_write_single(
    tcp: &crate::services::tcp_client::TcpClient,
    params: &WriteRegisterParams,
    is_coil: bool,
) -> Result<TransactionResult, String> {
    let tid = tcp.next_transaction_id();
    let req = if is_coil {
        build_tcp_write_single_coil_frame(tid, params.slave_id, params.address as u16, params.value != 0)
    } else {
        build_tcp_write_single_frame(tid, params.slave_id, params.address as u16, params.value)
    };
    let start = Instant::now();
    let resp = tcp.transact(&req, params.timeout).await?;
    let tx = frame_to_hex(&req);
    verify_tcp_write_single(&resp, tid, params.slave_id, is_coil, params.address as u16, params.value)
        .map_err(|e| format!("TX {} | {}", tx, e))?;
    Ok(TransactionResult {
        tx,
        rx: frame_to_hex(&resp),
        registers: vec![params.value],
        elapsed_ms: elapsed(start),
        crc_valid: true,
    })
}

async fn tcp_like_write_single_udp(
    udp: &crate::services::udp_client::UdpClient,
    params: &WriteRegisterParams,
    is_coil: bool,
) -> Result<TransactionResult, String> {
    let tid = udp.next_transaction_id();
    let req = if is_coil {
        build_tcp_write_single_coil_frame(tid, params.slave_id, params.address as u16, params.value != 0)
    } else {
        build_tcp_write_single_frame(tid, params.slave_id, params.address as u16, params.value)
    };
    let start = Instant::now();
    let resp = udp.transact(&req, params.timeout).await?;
    let tx = frame_to_hex(&req);
    verify_tcp_write_single(&resp, tid, params.slave_id, is_coil, params.address as u16, params.value)
        .map_err(|e| format!("TX {} | {}", tx, e))?;
    Ok(TransactionResult {
        tx,
        rx: frame_to_hex(&resp),
        registers: vec![params.value],
        elapsed_ms: elapsed(start),
        crc_valid: true,
    })
}

async fn tcp_like_write_multiple(
    tcp: &crate::services::tcp_client::TcpClient,
    params: &WriteMultipleRegistersParams,
    is_coil: bool,
) -> Result<TransactionResult, String> {
    let tid = tcp.next_transaction_id();
    let req = if is_coil {
        build_tcp_write_multiple_coils_frame(tid, params.slave_id, params.start_address as u16, &params.values)
    } else {
        build_tcp_write_multiple_frame(tid, params.slave_id, params.start_address as u16, &params.values)
    };
    let start = Instant::now();
    let resp = tcp.transact(&req, params.timeout).await?;
    let tx = frame_to_hex(&req);
    verify_tcp_write_multiple(&resp, tid, params.slave_id, is_coil, params.start_address as u16, params.values.len() as u16)
        .map_err(|e| format!("TX {} | {}", tx, e))?;
    Ok(TransactionResult {
        tx,
        rx: frame_to_hex(&resp),
        registers: params.values.clone(),
        elapsed_ms: elapsed(start),
        crc_valid: true,
    })
}

async fn tcp_like_write_multiple_udp(
    udp: &crate::services::udp_client::UdpClient,
    params: &WriteMultipleRegistersParams,
    is_coil: bool,
) -> Result<TransactionResult, String> {
    let tid = udp.next_transaction_id();
    let req = if is_coil {
        build_tcp_write_multiple_coils_frame(tid, params.slave_id, params.start_address as u16, &params.values)
    } else {
        build_tcp_write_multiple_frame(tid, params.slave_id, params.start_address as u16, &params.values)
    };
    let start = Instant::now();
    let resp = udp.transact(&req, params.timeout).await?;
    let tx = frame_to_hex(&req);
    verify_tcp_write_multiple(&resp, tid, params.slave_id, is_coil, params.start_address as u16, params.values.len() as u16)
        .map_err(|e| format!("TX {} | {}", tx, e))?;
    Ok(TransactionResult {
        tx,
        rx: frame_to_hex(&resp),
        registers: params.values.clone(),
        elapsed_ms: elapsed(start),
        crc_valid: true,
    })
}

fn verify_tcp_write_single(
    resp: &[u8],
    tid: u16,
    slave_id: u8,
    is_coil: bool,
    address: u16,
    value: u16,
) -> Result<(), String> {
    let expected_value: u16 = if is_coil {
        if value != 0 {
            0xff00
        } else {
            0x0000
        }
    } else {
        value
    };
    if resp.len() < 12
        || u16::from_be_bytes([resp[0], resp[1]]) != tid
        || resp[6] != slave_id
        || resp[7] != (if is_coil { 5 } else { 6 })
        || u16::from_be_bytes([resp[8], resp[9]]) != address
        || u16::from_be_bytes([resp[10], resp[11]]) != expected_value
    {
        return Err(format!("Modbus TCP 写响应头不匹配 [{}]", frame_to_hex(resp)));
    }
    Ok(())
}

fn verify_tcp_write_multiple(
    resp: &[u8],
    tid: u16,
    _slave_id: u8,
    is_coil: bool,
    start_address: u16,
    quantity: u16,
) -> Result<(), String> {
    let fc: u8 = if is_coil { 15 } else { 16 };
    if resp.len() < 12
        || u16::from_be_bytes([resp[0], resp[1]]) != tid
        || resp[7] != fc
        || u16::from_be_bytes([resp[8], resp[9]]) != start_address
        || u16::from_be_bytes([resp[10], resp[11]]) != quantity
    {
        return Err(format!("Modbus TCP 写响应范围不匹配 [{}]", frame_to_hex(resp)));
    }
    Ok(())
}

fn elapsed(start: Instant) -> u64 {
    (start.elapsed().as_millis() as u64).max(1)
}

// ----------------------------- 从站 -----------------------------

#[tauri::command]
pub async fn server_start_instance(
    state: State<'_, AppState>,
    instance: ServerInstanceConfig,
    data: Vec<ServerDataUpdate>,
) -> Result<(), String> {
    state.server.start_instance(instance, data).await
}

#[tauri::command]
pub async fn server_stop_instance(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.server.stop_instance(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn server_update_instance_data(
    state: State<'_, AppState>,
    id: String,
    update: ServerDataUpdate,
) -> Result<(), String> {
    state.server.update_instance_data(&id, update).await;
    Ok(())
}

// ----------------------------- 工程文件 -----------------------------

/// 打开工程返回结果。
#[derive(Serialize)]
pub struct ProjectOpenResult {
    pub path: String,
    pub data: Value,
}

#[tauri::command]
pub async fn project_open(app: AppHandle) -> Result<Option<ProjectOpenResult>, String> {
    let path = app
        .dialog()
        .file()
        .add_filter("Modbus Studio 工程", &["mbs", "json"])
        .blocking_pick_file();
    match path {
        Some(file_path) => {
            let p = file_path_to_string(file_path);
            read_project(&p).map(Some)
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn project_open_path(app: AppHandle, path: String) -> Result<ProjectOpenResult, String> {
    let _ = app;
    read_project(&path)
}

#[tauri::command]
pub async fn project_save(
    app: AppHandle,
    data: Value,
    path: Option<String>,
    save_as: bool,
) -> Result<Option<String>, String> {
    let target = if !save_as && path.is_some() {
        path
    } else {
        let default_name = data
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("未命名工程");
        let picked = app
            .dialog()
            .file()
            .add_filter("Modbus Studio 工程", &["mbs"])
            .set_file_name(default_name)
            .blocking_save_file();
        picked.map(file_path_to_string)
    };
    let target = match target {
        Some(t) => t,
        None => return Ok(None),
    };
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(&target, json).map_err(|e| e.to_string())?;
    if let Some(name) = data.get("name").and_then(|v| v.as_str()) {
        let _ = add_recent(&app, &target, name);
    }
    Ok(Some(target))
}

#[tauri::command]
pub async fn project_list_recent(app: AppHandle) -> Result<Vec<RecentProject>, String> {
    let _ = app;
    Ok(read_recent().unwrap_or_default())
}

#[tauri::command]
pub async fn project_remove_recent(app: AppHandle, path: String) -> Result<Vec<RecentProject>, String> {
    let _ = app;
    let projects = read_recent().unwrap_or_default();
    let filtered: Vec<RecentProject> = projects.into_iter().filter(|p| p.path != path).collect();
    write_recent(&filtered)?;
    Ok(filtered)
}

// ----------------------------- 字典 / 日志导入导出 -----------------------------

#[tauri::command]
pub async fn dictionary_export(app: AppHandle, items: Vec<RegisterDefinition>) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("CSV 文件", &["csv"])
        .add_filter("JSON 文件", &["json"])
        .blocking_save_file();
    let target = match picked {
        Some(p) => file_path_to_string(p),
        None => return Ok(None),
    };
    let content = if target.to_lowercase().ends_with(".csv") {
        build_dictionary_csv(&items)
    } else {
        build_dictionary_json(&items)
    };
    std::fs::write(&target, content).map_err(|e| e.to_string())?;
    Ok(Some(target))
}

#[tauri::command]
pub async fn dictionary_import(app: AppHandle) -> Result<Option<Vec<RegisterDefinition>>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("字典文件", &["csv", "json"])
        .add_filter("CSV 文件", &["csv"])
        .add_filter("JSON 文件", &["json"])
        .blocking_pick_file();
    let target = match picked {
        Some(p) => file_path_to_string(p),
        None => return Ok(None),
    };
    let bytes = std::fs::read(&target).map_err(|e| e.to_string())?;
    let text = read_text(&bytes);
    let items = if target.to_lowercase().ends_with(".csv") {
        parse_dictionary_csv(&text)
    } else {
        parse_dictionary_json(&text)
    };
    Ok(Some(items))
}

#[tauri::command]
pub async fn log_export(app: AppHandle, items: Vec<PacketLogItem>) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("CSV 文件", &["csv"])
        .add_filter("文本文件", &["txt"])
        .blocking_save_file();
    let target = match picked {
        Some(p) => file_path_to_string(p),
        None => return Ok(None),
    };
    let content = if target.to_lowercase().ends_with(".csv") {
        build_log_csv(&items)
    } else {
        build_log_txt(&items)
    };
    std::fs::write(&target, content).map_err(|e| e.to_string())?;
    Ok(Some(target))
}

// ----------------------------- 内部辅助 -----------------------------

fn read_project(path: &str) -> Result<ProjectOpenResult, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let text = read_text(&bytes);
    let data: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if let Some(name) = data.get("name").and_then(|v| v.as_str()) {
        let _ = add_recent_path(path, name);
    }
    Ok(ProjectOpenResult {
        path: path.to_string(),
        data,
    })
}

fn recent_path() -> Option<PathBuf> {
    let dir = dirs_data_dir()?;
    Some(dir.join("recent-projects.json"))
}

fn read_recent() -> Option<Vec<RecentProject>> {
    let path = recent_path()?;
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn write_recent(projects: &[RecentProject]) -> Result<(), String> {
    let path = recent_path().ok_or_else(|| "无法定位用户数据目录".to_string())?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(projects).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn add_recent(app: &AppHandle, path: &str, name: &str) -> Result<(), String> {
    let _ = app;
    add_recent_path(path, name)
}

fn add_recent_path(path: &str, name: &str) -> Result<(), String> {
    let mut projects = read_recent().unwrap_or_default();
    projects.retain(|p| p.path != path);
    projects.insert(
        0,
        RecentProject {
            path: path.to_string(),
            name: name.to_string(),
            opened_at: now_iso(),
        },
    );
    projects.truncate(10);
    write_recent(&projects)
}

fn dirs_data_dir() -> Option<PathBuf> {
    // 复用 Tauri 用户数据目录的约定：<config>/com.yunding.modbusstudio
    #[cfg(target_os = "windows")]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            return Some(PathBuf::from(local).join("com.yunding.modbusstudio"));
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return Some(
                PathBuf::from(home)
                    .join(".config")
                    .join("com.yunding.modbusstudio"),
            );
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return Some(
                PathBuf::from(home)
                    .join("Library")
                    .join("Application Support")
                    .join("com.yunding.modbusstudio"),
            );
        }
    }
    None
}

/// 解码文件内容为文本：优先 UTF-8，失败后按 GBK 解码（兼容 WPS/Excel 导出的 CSV）。
fn read_text(bytes: &[u8]) -> String {
    match String::from_utf8(bytes.to_vec()) {
        Ok(s) if !s.contains('\u{FFFD}') => s,
        _ => {
            let (cow, _, _) = encoding_rs::GBK.decode(bytes);
            cow.to_string()
        }
    }
}

fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // 简单 ISO-ish 时间戳，前端仅作展示
    format!("{}", secs)
}

fn format_address(address: u32) -> String {
    let area = address / 0x10000;
    let protocol = address & 0xffff;
    format!(
        "{}{}",
        area,
        format!("{:04X}", protocol)
    )
}

fn parse_address(text: &str) -> u32 {
    let t = text.trim();
    if t.len() == 5 {
        let b = t.as_bytes();
        if b[0] >= b'1' && b[0] <= b'4' && (1..5).all(|i| b[i].is_ascii_hexdigit()) {
            let area = (b[0] - b'0') as u32;
            if let Ok(proto) = u32::from_str_radix(&t[1..], 16) {
                return area * 0x10000 + proto;
            }
        }
    }
    if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return u32::from_str_radix(h, 16).unwrap_or(0x40000);
    }
    t.parse::<u32>().unwrap_or(0x40000)
}

fn build_dictionary_csv(items: &[RegisterDefinition]) -> String {
    let mut s = String::from("分组,地址,名称,数据类型,长度,从站,读写,比例因子,单位,备注\n");
    for it in items {
        s.push_str(&format!(
            "\"{}\",\"{}\",\"{}\",\"{}\",\"{}\",\"{}\",\"{}\",\"{}\",\"{}\",\"{}\"\n",
            it.group,
            format_address(it.address),
            it.name,
            it.data_type,
            it.length,
            it.slave_id.unwrap_or(0),
            it.access,
            it.factor,
            it.unit,
            it.remark
        ));
    }
    s
}

fn build_dictionary_json(items: &[RegisterDefinition]) -> String {
    let arr: Vec<Value> = items
        .iter()
        .map(|it| {
            serde_json::json!({
                "group": it.group,
                "address": format_address(it.address),
                "name": it.name,
                "dataType": it.data_type,
                "length": it.length,
                "slaveId": it.slave_id,
                "access": it.access,
                "factor": it.factor,
                "unit": it.unit,
                "remark": it.remark
            })
        })
        .collect();
    serde_json::to_string_pretty(&Value::Array(arr)).unwrap_or_else(|_| "[]".to_string())
}

fn parse_dictionary_csv(text: &str) -> Vec<RegisterDefinition> {
    let lines: Vec<&str> = text.split('\n').filter(|l| !l.trim().is_empty()).collect();
    if lines.len() < 2 {
        return Vec::new();
    }
    let has_slave_column = lines[0].contains("从站");
    let offset = if has_slave_column { 1 } else { 0 };
    let mut items = Vec::new();
    for line in &lines[1..] {
        let parts: Vec<String> = line
            .split(',')
            .map(|p| p.trim().trim_matches('"').to_string())
            .collect();
        let val = |i: usize| -> String { parts.get(i).cloned().unwrap_or_default() };
        let slave_raw: u32 = val(5).parse().unwrap_or(0);
        items.push(RegisterDefinition {
            group: if val(0).is_empty() { "默认分组".to_string() } else { val(0) },
            address: parse_address(&val(1)),
            name: val(2),
            data_type: if val(3).is_empty() { "UINT16".to_string() } else { val(3) },
            length: val(4).parse().unwrap_or(1),
            slave_id: if slave_raw > 0 { Some(slave_raw) } else { None },
            access: val(5 + offset).clone(),
            factor: val(6 + offset).parse().unwrap_or(1.0),
            unit: val(7 + offset).clone(),
            remark: val(8 + offset).clone(),
        });
    }
    items
}

fn parse_dictionary_json(text: &str) -> Vec<RegisterDefinition> {
    let value: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let array = match value {
        Value::Array(a) => a,
        _ => return Vec::new(),
    };
    array
        .into_iter()
        .filter_map(|item| {
            let obj = item.as_object()?;
            let address = match obj.get("address") {
                Some(Value::String(s)) => parse_address(s),
                Some(Value::Number(n)) => n.as_u64().unwrap_or(0) as u32,
                _ => 0x40000,
            };
            Some(RegisterDefinition {
                group: str_field(obj, "group"),
                address,
                name: str_field(obj, "name"),
                data_type: str_field(obj, "dataType"),
                length: obj
                    .get("length")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1) as u32,
                slave_id: obj.get("slaveId").and_then(|v| v.as_u64()).map(|n| n as u32),
                access: str_field(obj, "access"),
                factor: obj.get("factor").and_then(|v| v.as_f64()).unwrap_or(1.0),
                unit: str_field(obj, "unit"),
                remark: str_field(obj, "remark"),
            })
        })
        .collect()
}

fn str_field(obj: &serde_json::Map<String, Value>, key: &str) -> String {
    obj.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

fn build_log_csv(items: &[PacketLogItem]) -> String {
    let mut s = String::from("序号,时间,方向,协议,原始数据,解析结果,耗时(ms),状态\n");
    for it in items {
        s.push_str(&format!(
            "\"{}\",\"{}\",\"{}\",\"{}\",\"{}\",\"{}\",\"{}\",\"{}\"\n",
            it.id, it.time, it.direction, it.protocol, it.raw, it.parsed, it.elapsed_ms, it.status
        ));
    }
    s
}

fn build_log_txt(items: &[PacketLogItem]) -> String {
    let mut s = String::new();
    for it in items {
        s.push_str(&format!(
            "[{}] {} {} {} | {} | {}ms | {}\n",
            it.time, it.direction, it.protocol, it.raw, it.parsed, it.elapsed_ms, it.status
        ));
    }
    s
}

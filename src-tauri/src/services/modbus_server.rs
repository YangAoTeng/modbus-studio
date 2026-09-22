//! Modbus 从站服务：TCP / UDP / RTU 监听，四区数据模型与事件推送。
//!
//! 与 `src/main/services/ModbusServerService.ts` 等价。每个实例独立维护四区数据模型，
//! 通过 Tauri 事件 `server_event` 向前端推送 status / data / log 三类事件。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Local;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

use crate::protocol::crc16::{append_crc, frame_to_hex, verify_crc};
use crate::protocol::server_pdu::{create_server_data_model, process_server_pdu, ServerDataModel};
use crate::protocol::tcp_frame::build_tcp_frame;
use crate::services::serial::{data_bits_from_u8, stop_bits_from_u8};
use crate::types::*;

/// 从站服务（持有 AppHandle 以推送事件）。
pub struct ModbusServer {
    app: AppHandle,
    instances: AsyncMutex<HashMap<String, Instance>>,
}

/// 单个从站实例运行时状态。
struct Instance {
    config: ServerInstanceConfig,
    data: Arc<Mutex<ServerDataModel>>,
    running: bool,
    shutdown: Arc<AtomicBool>,
    handles: Vec<JoinHandle<()>>,
}

impl ModbusServer {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            instances: AsyncMutex::new(HashMap::new()),
        }
    }

    /// 启动或重启从站实例。
    pub async fn start_instance(
        &self,
        instance: ServerInstanceConfig,
        initial_data: Vec<ServerDataUpdate>,
    ) -> Result<(), String> {
        self.stop_instance(&instance.id).await;
        let data = Arc::new(Mutex::new(create_server_data_model()));
        {
            let mut guard = data.lock().unwrap();
            for item in &initial_data {
                set_data(&mut guard, item);
            }
        }
        let shutdown = Arc::new(AtomicBool::new(false));
        let mut handles = Vec::new();

        let (host, port) = (instance.tcp_host.clone(), instance.tcp_port);
        let slave_id = instance.slave_id;
        let id = instance.id.clone();
        let name = instance.name.clone();
        let protocol = instance.protocol;

        match protocol {
            ProtocolMode::Tcp => {
                let h = self
                    .spawn_tcp(&data, &shutdown, host, port, slave_id, id, name)
                    .await?;
                handles.push(h);
            }
            ProtocolMode::Udp => {
                let h = self
                    .spawn_udp(&data, &shutdown, host, port, slave_id, id, name)
                    .await?;
                handles.push(h);
            }
            ProtocolMode::Rtu => {
                let serial = instance.serial.clone().unwrap_or(SerialConfig {
                    path: String::new(),
                    baud_rate: 9600,
                    data_bits: 8,
                    stop_bits: 1,
                    parity: Parity::None,
                    timeout: 1000,
                });
                let h = self.spawn_rtu(&data, &shutdown, serial, slave_id, id, name);
                handles.push(h);
            }
        }

        let record = Instance {
            config: instance,
            data,
            running: true,
            shutdown,
            handles,
        };
        let record_id = record.config.id.clone();
        self.instances.lock().await.insert(record_id.clone(), record);

        self.emit_event(ServerEvent {
            r#type: "status".into(),
            instance_id: Some(record_id),
            running: Some(true),
            protocol: Some(protocol),
            update: None,
            log: None,
        });
        Ok(())
    }

    /// 停止指定实例（关闭监听 / 串口并广播停止状态）。
    pub async fn stop_instance(&self, id: &str) {
        let mut map = self.instances.lock().await;
        if let Some(instance) = map.remove(id) {
            instance.shutdown.store(true, Ordering::SeqCst);
            for handle in instance.handles {
                handle.abort();
            }
            if instance.running {
                self.emit_event(ServerEvent {
                    r#type: "status".into(),
                    instance_id: Some(id.to_string()),
                    running: Some(false),
                    protocol: Some(instance.config.protocol),
                    update: None,
                    log: None,
                });
            }
        }
    }

    /// 更新实例数据区单点值。
    pub async fn update_instance_data(&self, id: &str, update: ServerDataUpdate) {
        let map = self.instances.lock().await;
        if let Some(instance) = map.get(id) {
            let mut guard = instance.data.lock().unwrap();
            set_data(&mut guard, &update);
        }
    }

    async fn spawn_tcp(
        &self,
        data: &Arc<Mutex<ServerDataModel>>,
        shutdown: &Arc<AtomicBool>,
        host: String,
        port: u16,
        slave_id: u8,
        instance_id: String,
        name: String,
    ) -> Result<JoinHandle<()>, String> {
        let listener = TcpListener::bind((host, port))
            .await
            .map_err(|e| e.to_string())?;
        let data = data.clone();
        let shutdown = shutdown.clone();
        let app = self.app.clone();
        let handle = tokio::spawn(async move {
            loop {
                if shutdown.load(Ordering::SeqCst) {
                    break;
                }
                let accepted = tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(200)) => None,
                    res = listener.accept() => Some(res),
                };
                let (socket, _) = match accepted {
                    Some(Ok(v)) => v,
                    _ => continue,
                };
                let data = data.clone();
                let shutdown = shutdown.clone();
                let app = app.clone();
                let iid = instance_id.clone();
                let nm = name.clone();
                tokio::spawn(handle_tcp(socket, data, app, iid, nm, slave_id, shutdown));
            }
        });
        Ok(handle)
    }

    async fn spawn_udp(
        &self,
        data: &Arc<Mutex<ServerDataModel>>,
        shutdown: &Arc<AtomicBool>,
        host: String,
        port: u16,
        slave_id: u8,
        instance_id: String,
        name: String,
    ) -> Result<JoinHandle<()>, String> {
        let socket = UdpSocket::bind((host, port))
            .await
            .map_err(|e| e.to_string())?;
        let data = data.clone();
        let shutdown = shutdown.clone();
        let app = self.app.clone();
        let handle = tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            loop {
                if shutdown.load(Ordering::SeqCst) {
                    break;
                }
                match tokio::time::timeout(Duration::from_millis(200), socket.recv_from(&mut buf)).await {
                    Ok(Ok((n, remote))) => {
                        let request = buf[..n].to_vec();
                        if request.len() < 7 {
                            continue;
                        }
                        let frame_len = 6 + u16::from_be_bytes([request[4], request[5]]) as usize;
                        if request.len() < frame_len {
                            continue;
                        }
                        let req = request[..frame_len].to_vec();
                        if req[6] != slave_id {
                            continue;
                        }
                        let (response, log_rx, log_tx) =
                            process_tcp_like(&data, &app, &instance_id, &name, slave_id, &req);
                        let _ = socket.send_to(&response, remote).await;
                        emit_log(&app, &instance_id, &name, "UDP", &log_rx);
                        emit_log(&app, &instance_id, &name, "UDP", &log_tx);
                    }
                    _ => continue,
                }
            }
        });
        Ok(handle)
    }

    fn spawn_rtu(
        &self,
        data: &Arc<Mutex<ServerDataModel>>,
        shutdown: &Arc<AtomicBool>,
        config: SerialConfig,
        slave_id: u8,
        instance_id: String,
        name: String,
    ) -> JoinHandle<()> {
        let data = data.clone();
        let shutdown = shutdown.clone();
        let app = self.app.clone();
        tokio::task::spawn_blocking(move || {
            let port = match serialport::new(config.path.clone(), config.baud_rate)
                .data_bits(data_bits_from_u8(config.data_bits))
                .stop_bits(stop_bits_from_u8(config.stop_bits))
                .parity(match config.parity {
                    Parity::None => serialport::Parity::None,
                    Parity::Even => serialport::Parity::Even,
                    Parity::Odd => serialport::Parity::Odd,
                })
                .timeout(Duration::from_millis(250))
                .open()
            {
                Ok(p) => p,
                Err(_) => return,
            };
            let mut buffer: Vec<u8> = Vec::new();
            let mut buf = [0u8; 256];
            let mut port = port;
            loop {
                if shutdown.load(Ordering::SeqCst) {
                    break;
                }
                match port.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        buffer.extend_from_slice(&buf[..n]);
                        while buffer.len() >= 8 {
                            let fc = buffer[1];
                            let frame_len = if fc == 15 || fc == 16 {
                                9 + buffer[6] as usize
                            } else {
                                8
                            };
                            if buffer.len() < frame_len {
                                break;
                            }
                            let request = buffer[..frame_len].to_vec();
                            buffer.drain(..frame_len);
                            if request[0] != slave_id || !verify_crc(&request) {
                                continue;
                            }
                            let (response, log_rx, log_tx) =
                                process_rtu(&data, &app, &instance_id, &name, slave_id, &request);
                            let _ = port.write_all(&response);
                            let _ = port.flush();
                            emit_log(&app, &instance_id, &name, "RTU", &log_rx);
                            emit_log(&app, &instance_id, &name, "RTU", &log_tx);
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                    Err(_) => break,
                }
            }
        })
    }

    fn emit_event(&self, event: ServerEvent) {
        let _ = self.app.emit("server_event", event);
    }
}

/// TCP 连接处理：按 MBAP 长度拆帧并响应。
async fn handle_tcp(
    mut socket: TcpStream,
    data: Arc<Mutex<ServerDataModel>>,
    app: AppHandle,
    instance_id: String,
    name: String,
    slave_id: u8,
    shutdown: Arc<AtomicBool>,
) {
    let mut buffer: Vec<u8> = Vec::new();
    let mut buf = [0u8; 1024];
    loop {
        if shutdown.load(Ordering::SeqCst) {
            break;
        }
        match tokio::time::timeout(Duration::from_millis(200), socket.read(&mut buf)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                buffer.extend_from_slice(&buf[..n]);
                while buffer.len() >= 6 {
                    let frame_len = 6 + u16::from_be_bytes([buffer[4], buffer[5]]) as usize;
                    if buffer.len() < frame_len {
                        break;
                    }
                    let request = buffer[..frame_len].to_vec();
                    buffer.drain(..frame_len);
                    if request[6] != slave_id {
                        continue;
                    }
                    let (response, log_rx, log_tx) =
                        process_tcp_like(&data, &app, &instance_id, &name, slave_id, &request);
                    let _ = socket.write_all(&response).await;
                    let _ = socket.flush().await;
                    emit_log(&app, &instance_id, &name, "TCP", &log_rx);
                    emit_log(&app, &instance_id, &name, "TCP", &log_tx);
                }
            }
            _ => continue,
        }
    }
}

/// 处理一条 MBAP 请求（TCP / UDP 共用），返回响应与两条日志。
fn process_tcp_like(
    data: &Arc<Mutex<ServerDataModel>>,
    app: &AppHandle,
    instance_id: &str,
    name: &str,
    _slave_id: u8,
    request: &[u8],
) -> (Vec<u8>, LogPayload, LogPayload) {
    let transaction_id = u16::from_be_bytes([request[0], request[1]]);
    let unit_id = request[6];
    let pdu = &request[7..];
    let mut guard = data.lock().unwrap();
    let log_rx = LogPayload {
        time: now_time(),
        direction: "RX".into(),
        protocol: "TCP".into(),
        raw: frame_to_hex(request),
        parsed: format!("[{}] 收到功能码 {:02X}", name, pdu.first().copied().unwrap_or(0)),
        elapsed_ms: 0,
        status: "成功".into(),
    };
    let app2 = app.clone();
    let iid = instance_id.to_string();
    let mut on_update = |update: ServerDataUpdate| {
        let _ = app2.emit(
            "server_event",
            ServerEvent {
                r#type: "data".into(),
                instance_id: Some(iid.clone()),
                running: None,
                protocol: None,
                update: Some(update),
                log: None,
            },
        );
    };
    let response_pdu = process_server_pdu(pdu, &mut guard, &mut on_update);
    let response = build_tcp_frame(transaction_id, unit_id, &response_pdu);
    let log_tx = LogPayload {
        time: now_time(),
        direction: "TX".into(),
        protocol: "TCP".into(),
        raw: frame_to_hex(&response),
        parsed: format!("[{}] 已响应", name),
        elapsed_ms: 0,
        status: "发送".into(),
    };
    (response, log_rx, log_tx)
}

/// 处理一条 RTU 请求（从站串口），返回响应与两条日志。
fn process_rtu(
    data: &Arc<Mutex<ServerDataModel>>,
    app: &AppHandle,
    instance_id: &str,
    name: &str,
    slave_id: u8,
    request: &[u8],
) -> (Vec<u8>, LogPayload, LogPayload) {
    let pdu = &request[1..request.len() - 2];
    let mut guard = data.lock().unwrap();
    let log_rx = LogPayload {
        time: now_time(),
        direction: "RX".into(),
        protocol: "RTU".into(),
        raw: frame_to_hex(request),
        parsed: format!("[{}] 收到功能码 {:02X}", name, pdu.first().copied().unwrap_or(0)),
        elapsed_ms: 0,
        status: "成功".into(),
    };
    let app2 = app.clone();
    let iid = instance_id.to_string();
    let mut on_update = |update: ServerDataUpdate| {
        let _ = app2.emit(
            "server_event",
            ServerEvent {
                r#type: "data".into(),
                instance_id: Some(iid.clone()),
                running: None,
                protocol: None,
                update: Some(update),
                log: None,
            },
        );
    };
    let response_pdu = process_server_pdu(pdu, &mut guard, &mut on_update);
    let mut response = Vec::with_capacity(response_pdu.len() + 3);
    response.push(slave_id);
    response.extend_from_slice(&response_pdu);
    let response = append_crc(&response);
    let log_tx = LogPayload {
        time: now_time(),
        direction: "TX".into(),
        protocol: "RTU".into(),
        raw: frame_to_hex(&response),
        parsed: format!("[{}] 已响应", name),
        elapsed_ms: 0,
        status: "发送".into(),
    };
    (response, log_rx, log_tx)
}

/// 写入数据区单点值（按区分发）。
fn set_data(data: &mut ServerDataModel, update: &ServerDataUpdate) {
    let address = update.address as usize;
    match update.area {
        ServerAreaName::Coil => {
            if address < data.coil.len() {
                data.coil[address] = (update.value != 0) as u8;
            }
        }
        ServerAreaName::Discrete => {
            if address < data.discrete.len() {
                data.discrete[address] = (update.value != 0) as u8;
            }
        }
        ServerAreaName::Input => {
            if address < data.input.len() {
                data.input[address] = update.value;
            }
        }
        ServerAreaName::Holding => {
            if address < data.holding.len() {
                data.holding[address] = update.value;
            }
        }
    }
}

/// 推送一条报文日志事件。
fn emit_log(app: &AppHandle, instance_id: &str, name: &str, protocol: &str, log: &LogPayload) {
    let _ = app.emit(
        "server_event",
        ServerEvent {
            r#type: "log".into(),
            instance_id: Some(instance_id.to_string()),
            running: None,
            protocol: Some(match protocol {
                "TCP" => ProtocolMode::Tcp,
                "UDP" => ProtocolMode::Udp,
                _ => ProtocolMode::Rtu,
            }),
            update: None,
            log: Some(log.clone()),
        },
    );
    let _ = name;
}

/// 当前本地时间（HH:MM:SS），用于日志展示。
fn now_time() -> String {
    Local::now().format("%H:%M:%S").to_string()
}

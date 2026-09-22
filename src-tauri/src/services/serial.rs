//! 串口服务：枚举、打开 / 关闭、RTU 事务收发。
//!
//! 与 `src/main/services/SerialService.ts` 等价。阻塞 I/O 通过 `spawn_blocking` 执行，
//! 句柄以 `Arc<std::sync::Mutex<...>>` 共享给 RTU 主站事务使用。

use std::io::{ErrorKind, Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serialport::{DataBits, Parity as SpParity, SerialPort, StopBits};
use tokio::task;

use crate::types::{Parity, SerialConfig};

/// 共享串口句柄（None 表示未打开）。
pub type SerialHandle = Arc<Mutex<Option<Box<dyn SerialPort + Send>>>>;

/// 枚举系统可用串口路径。
pub async fn list_ports() -> Result<Vec<String>, String> {
    task::spawn_blocking(|| {
        serialport::available_ports()
            .map(|ports| ports.into_iter().map(|p| p.port_name).collect())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn to_serialport_parity(p: Parity) -> SpParity {
    match p {
        Parity::None => SpParity::None,
        Parity::Even => SpParity::Even,
        Parity::Odd => SpParity::Odd,
    }
}

/// serialport 4 的 `DataBits` 没有 `from_bits`，只有 `TryFrom<u8>`；这里显式匹配更稳。
pub fn data_bits_from_u8(b: u8) -> DataBits {
    match b {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        8 => DataBits::Eight,
        _ => DataBits::Eight,
    }
}

/// 同上，`StopBits` 也没有 `from_bits`。
pub fn stop_bits_from_u8(b: u8) -> StopBits {
    match b {
        1 => StopBits::One,
        2 => StopBits::Two,
        _ => StopBits::One,
    }
}

/// 按配置打开串口并存入共享句柄。
pub async fn open(handle: &SerialHandle, config: SerialConfig) -> Result<(), String> {
    let path = config.path.clone();
    let baud = config.baud_rate;
    let data_bits = data_bits_from_u8(config.data_bits);
    let stop_bits = stop_bits_from_u8(config.stop_bits);
    let parity = to_serialport_parity(config.parity);
    let timeout = Duration::from_millis(config.timeout);

    let port = task::spawn_blocking(move || {
        serialport::new(path, baud)
            .data_bits(data_bits)
            .stop_bits(stop_bits)
            .parity(parity)
            .timeout(timeout)
            .open()
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    *handle.lock().unwrap() = Some(port);
    Ok(())
}

/// 关闭串口。先取出旧句柄再 drop，确保同一时刻仅一个实例。
pub async fn close(handle: &SerialHandle) -> Result<(), String> {
    let old = { std::mem::replace(&mut *handle.lock().unwrap(), None) };
    if let Some(mut port) = old {
        let _ = task::spawn_blocking(move || port.flush()).await;
    }
    Ok(())
}

/// 发送 RTU 请求并读取完整响应帧。超时或串口错误则拒绝。
pub async fn transact(handle: &SerialHandle, request: &[u8], timeout_ms: u64) -> Result<Vec<u8>, String> {
    let handle = handle.clone();
    let request = request.to_vec();
    let timeout = Duration::from_millis(timeout_ms);
    task::spawn_blocking(move || {
        let mut guard = handle.lock().unwrap();
        let port = guard.as_mut().ok_or_else(|| "串口尚未连接".to_string())?;
        port.set_timeout(timeout).ok();

        port.write_all(&request).map_err(|e| e.to_string())?;
        port.flush().map_err(|e| e.to_string())?;

        let mut response: Vec<u8> = Vec::new();
        let mut buf = [0u8; 256];
        let start = Instant::now();
        let mut expected_length = 0usize;
        let tx_hex = crate::protocol::crc16::frame_to_hex(&request);

        loop {
            match port.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    response.extend_from_slice(&buf[..n]);
                    if response.len() >= 2 && expected_length == 0 {
                        let fc = response[1];
                        if (fc & 0x80) != 0 {
                            expected_length = 5;
                        } else if fc == 0x06 || fc == 0x10 {
                            expected_length = 8;
                        } else if response.len() >= 3 {
                            expected_length = response[2] as usize + 5;
                        }
                    }
                    if expected_length > 0 && response.len() >= expected_length {
                        response.truncate(expected_length);
                        break;
                    }
                }
                Err(ref e) if e.kind() == ErrorKind::TimedOut => {
                    if response.is_empty() {
                        return Err("等待 Modbus 响应超时".to_string());
                    }
                    break;
                }
                Err(e) => return Err(e.to_string()),
            }
            if start.elapsed() > timeout + Duration::from_millis(500) {
                if response.is_empty() {
                    return Err("等待 Modbus 响应超时".to_string());
                }
                break;
            }
        }
        if response.is_empty() {
            return Err(format!("TX {} | 无响应", tx_hex));
        }
        Ok(response)
    })
    .await
    .map_err(|e| e.to_string())?
}

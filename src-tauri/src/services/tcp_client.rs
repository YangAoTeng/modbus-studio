//! Modbus TCP 客户端服务：连接管理与 MBAP 事务收发。
//!
//! 与 `src/main/services/TcpClientService.ts` 等价，使用 tokio 异步实现。

use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::time::{Duration, Instant};

use crate::types::TcpConfig;

/// TCP 客户端状态（句柄与事务计数器）。
pub struct TcpClient {
    stream: Arc<Mutex<Option<TcpStream>>>,
    transaction_id: AtomicU16,
}

impl TcpClient {
    pub fn new() -> Self {
        Self {
            stream: Arc::new(Mutex::new(None)),
            transaction_id: AtomicU16::new(1),
        }
    }

    /// 建立 Modbus TCP 连接（先断开旧连接）。
    pub async fn connect(&self, config: &TcpConfig) -> Result<(), String> {
        self.disconnect().await.ok();
        let stream = TcpStream::connect((config.host.clone(), config.port))
            .await
            .map_err(|e| e.to_string())?;
        *self.stream.lock().await = Some(stream);
        Ok(())
    }

    /// 断开连接。
    pub async fn disconnect(&self) -> Result<(), String> {
        if let Some(mut stream) = self.stream.lock().await.take() {
            let _ = stream.shutdown().await;
        }
        Ok(())
    }

    /// 返回下一个事务标识（1..=0xffff 循环）。
    pub fn next_transaction_id(&self) -> u16 {
        let current = self.transaction_id.load(Ordering::SeqCst);
        let next = if current >= 0xffff { 1 } else { current + 1 };
        self.transaction_id.store(next, Ordering::SeqCst);
        current
    }

    /// 发送 TCP 请求并读取完整 MBAP 响应帧。
    pub async fn transact(&self, request: &[u8], timeout_ms: u64) -> Result<Vec<u8>, String> {
        let mut stream = self.stream.lock().await;
        let stream = stream.as_mut().ok_or_else(|| "Modbus TCP 尚未连接".to_string())?;
        stream
            .write_all(request)
            .await
            .map_err(|e| e.to_string())?;

        let mut response: Vec<u8> = Vec::new();
        let mut buf = [0u8; 1024];
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            match tokio::time::timeout_at(deadline.into(), stream.read(&mut buf)).await {
                Ok(Ok(0)) => break,
                Ok(Ok(n)) => {
                    response.extend_from_slice(&buf[..n]);
                    if response.len() >= 6 {
                        let frame_len =
                            6 + u16::from_be_bytes([response[4], response[5]]) as usize;
                        if response.len() >= frame_len {
                            response.truncate(frame_len);
                            break;
                        }
                    }
                }
                Ok(Err(e)) => return Err(e.to_string()),
                Err(_) => return Err("等待 Modbus TCP 响应超时".to_string()),
            }
        }
        if response.is_empty() {
            return Err("等待 Modbus TCP 响应超时".to_string());
        }
        Ok(response)
    }
}

impl Default for TcpClient {
    fn default() -> Self {
        Self::new()
    }
}

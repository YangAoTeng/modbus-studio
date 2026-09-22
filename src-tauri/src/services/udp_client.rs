//! Modbus UDP 客户端服务：无连接，每次事务用一个数据报。
//!
//! 与 `src/main/services/UdpClientService.ts` 等价，UDP 帧格式与 TCP 相同（MBAP + PDU）。

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;

use tokio::net::UdpSocket;
use tokio::sync::Mutex;
use tokio::time::{Duration, Instant};

use crate::types::TcpConfig;

/// UDP 客户端状态。
pub struct UdpClient {
    socket: Arc<Mutex<Option<UdpSocket>>>,
    host: Arc<Mutex<String>>,
    port: Arc<Mutex<u16>>,
    transaction_id: AtomicU16,
}

impl UdpClient {
    pub fn new() -> Self {
        Self {
            socket: Arc::new(Mutex::new(None)),
            host: Arc::new(Mutex::new("127.0.0.1".to_string())),
            port: Arc::new(Mutex::new(502)),
            transaction_id: AtomicU16::new(1),
        }
    }

    /// 保存目标地址（UDP 无连接）。
    pub async fn connect(&self, config: &TcpConfig) -> Result<(), String> {
        self.disconnect().await.ok();
        *self.host.lock().await = config.host.clone();
        *self.port.lock().await = config.port;
        let socket = UdpSocket::bind("0.0.0.0:0")
            .await
            .map_err(|e| e.to_string())?;
        *self.socket.lock().await = Some(socket);
        Ok(())
    }

    /// 关闭套接字。
    pub async fn disconnect(&self) -> Result<(), String> {
        *self.socket.lock().await = None;
        Ok(())
    }

    /// 返回下一个事务标识。
    pub fn next_transaction_id(&self) -> u16 {
        let current = self.transaction_id.load(Ordering::SeqCst);
        let next = if current >= 0xffff { 1 } else { current + 1 };
        self.transaction_id.store(next, Ordering::SeqCst);
        current
    }

    /// 发送 UDP 请求并等待一个完整 MBAP 响应数据报。
    pub async fn transact(&self, request: &[u8], timeout_ms: u64) -> Result<Vec<u8>, String> {
        let socket = self.socket.lock().await;
        let socket = socket.as_ref().ok_or_else(|| "Modbus UDP 尚未连接".to_string())?;
        let host = self.host.lock().await.clone();
        let port = *self.port.lock().await;
        let addr: SocketAddr = format!("{}:{}", host, port)
            .parse()
            .map_err(|e: std::net::AddrParseError| e.to_string())?;

        socket
            .send_to(request, addr)
            .await
            .map_err(|e| e.to_string())?;

        let mut response = vec![0u8; 1024];
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            match tokio::time::timeout_at(deadline.into(), socket.recv_from(&mut response)).await {
                Ok(Ok((n, _))) => {
                    response.truncate(n);
                    return Ok(response);
                }
                Ok(Err(e)) => return Err(e.to_string()),
                Err(_) => return Err("等待 Modbus UDP 响应超时".to_string()),
            }
        }
    }
}

impl Default for UdpClient {
    fn default() -> Self {
        Self::new()
    }
}

//! Modbus 协议层（与前端 TS 协议实现逻辑等价）。

pub mod crc16;
pub mod rtu_frame;
pub mod server_pdu;
pub mod tcp_frame;

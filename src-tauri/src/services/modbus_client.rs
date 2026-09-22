//! Modbus RTU 主站事务（通过串口收发）。
//!
//! 与 `src/main/services/ModbusClientService.ts` 等价。TCP / UDP 主站事务在
//! `commands.rs` 中编排（仅 transact 源不同），此处仅实现 RTU 分支。

use std::time::Instant;

use crate::protocol::crc16::frame_to_hex;
use crate::protocol::rtu_frame::{
    build_read_frame, build_write_multiple_coils_frame, build_write_multiple_frame,
    build_write_single_coil_frame, build_write_single_frame, parse_read_response,
    verify_write_multiple_response, verify_write_single_response,
};
use crate::services::serial::{self, SerialHandle};
use crate::types::{ReadRegistersParams, TransactionResult, WriteMultipleRegistersParams, WriteRegisterParams};

fn elapsed(start: Instant) -> u64 {
    let ms = start.elapsed().as_millis() as u64;
    ms.max(1)
}

/// 读取数据（FC01~04）。
pub async fn read_registers(handle: &SerialHandle, params: &ReadRegistersParams) -> Result<TransactionResult, String> {
    let request = build_read_frame(
        params.slave_id,
        params.function_code,
        params.start_address as u16,
        params.quantity as u16,
    );
    let start = Instant::now();
    let response = serial::transact(handle, &request, params.timeout).await?;
    let tx_hex = frame_to_hex(&request);
    let registers = parse_read_response(&response, params.slave_id, params.function_code, params.quantity)
        .map_err(|e| format!("TX {} | {}", tx_hex, e))?;
    Ok(TransactionResult {
        tx: tx_hex,
        rx: frame_to_hex(&response),
        registers,
        elapsed_ms: elapsed(start),
        crc_valid: true,
    })
}

/// 写入单个线圈（FC05）或保持寄存器（FC06）。
pub async fn write_single_register(handle: &SerialHandle, params: WriteRegisterParams) -> Result<TransactionResult, String> {
    let is_coil = params.function_code == Some(5);
    let request = if is_coil {
        build_write_single_coil_frame(params.slave_id, params.address as u16, params.value != 0)
    } else {
        build_write_single_frame(params.slave_id, params.address as u16, params.value)
    };
    let start = Instant::now();
    let response = serial::transact(handle, &request, params.timeout).await?;
    verify_write_single_response(&response, &request[..request.len() - 2])
        .map_err(|e| format!("TX {} | {}", frame_to_hex(&request), e))?;
    Ok(TransactionResult {
        tx: frame_to_hex(&request),
        rx: frame_to_hex(&response),
        registers: vec![params.value],
        elapsed_ms: elapsed(start),
        crc_valid: true,
    })
}

/// 写入多个线圈（FC15）或保持寄存器（FC16）。
pub async fn write_multiple_registers(handle: &SerialHandle, params: WriteMultipleRegistersParams) -> Result<TransactionResult, String> {
    if params.values.is_empty() || params.values.len() > 123 {
        return Err("写入数量必须在 1 到 123 之间".to_string());
    }
    let is_coil = params.function_code == Some(15);
    let request = if is_coil {
        build_write_multiple_coils_frame(params.slave_id, params.start_address as u16, &params.values)
    } else {
        build_write_multiple_frame(params.slave_id, params.start_address as u16, &params.values)
    };
    let start = Instant::now();
    let response = serial::transact(handle, &request, params.timeout).await?;
    let fc: u8 = if is_coil { 15 } else { 16 };
    verify_write_multiple_response(&response, params.slave_id, fc, params.start_address as u16, params.values.len() as u16)
        .map_err(|e| format!("TX {} | {}", frame_to_hex(&request), e))?;
    Ok(TransactionResult {
        tx: frame_to_hex(&request),
        rx: frame_to_hex(&response),
        registers: params.values,
        elapsed_ms: elapsed(start),
        crc_valid: true,
    })
}

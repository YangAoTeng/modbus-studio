//! Modbus RTU 帧构造与解析。
//!
//! 与 `src/main/protocol/rtu-frame.ts` 逻辑等价。所有构造返回完整帧（含 CRC），
//! 解析对 CRC、从机地址、功能码、长度与异常码做校验。

use crate::protocol::crc16::{append_crc, frame_to_hex, verify_crc};

/// 构造读取请求帧（FC01~04）。
pub fn build_read_frame(slave_id: u8, function_code: u8, start_address: u16, quantity: u16) -> Vec<u8> {
    let payload = [
        slave_id,
        function_code,
        (start_address >> 8) as u8,
        (start_address & 0xff) as u8,
        (quantity >> 8) as u8,
        (quantity & 0xff) as u8,
    ];
    append_crc(&payload)
}

/// 构造写单个保持寄存器请求帧（FC06）。
pub fn build_write_single_frame(slave_id: u8, address: u16, value: u16) -> Vec<u8> {
    let payload = [
        slave_id,
        0x06,
        (address >> 8) as u8,
        (address & 0xff) as u8,
        (value >> 8) as u8,
        (value & 0xff) as u8,
    ];
    append_crc(&payload)
}

/// 构造写多个保持寄存器请求帧（FC16）。
pub fn build_write_multiple_frame(slave_id: u8, start_address: u16, values: &[u16]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(7 + values.len() * 2);
    payload.push(slave_id);
    payload.push(0x10);
    payload.extend_from_slice(&start_address.to_be_bytes());
    payload.extend_from_slice(&(values.len() as u16).to_be_bytes());
    payload.push((values.len() * 2) as u8);
    for &v in values {
        payload.extend_from_slice(&v.to_be_bytes());
    }
    append_crc(&payload)
}

/// 构造写单个线圈请求帧（FC05，0xFF00=ON / 0x0000=OFF）。
pub fn build_write_single_coil_frame(slave_id: u8, address: u16, value: bool) -> Vec<u8> {
    let v: u16 = if value { 0xff00 } else { 0x0000 };
    let payload = [
        slave_id,
        0x05,
        (address >> 8) as u8,
        (address & 0xff) as u8,
        (v >> 8) as u8,
        (v & 0xff) as u8,
    ];
    append_crc(&payload)
}

/// 构造写多个线圈请求帧（FC15，位数据 LSB-first 打包）。
pub fn build_write_multiple_coils_frame(slave_id: u8, start_address: u16, values: &[u16]) -> Vec<u8> {
    let byte_count = (values.len() + 7) / 8;
    let mut payload = Vec::with_capacity(7 + byte_count);
    payload.push(slave_id);
    payload.push(0x0f);
    payload.extend_from_slice(&start_address.to_be_bytes());
    payload.extend_from_slice(&(values.len() as u16).to_be_bytes());
    payload.push(byte_count as u8);
    for (i, &val) in values.iter().enumerate() {
        if val != 0 {
            payload[7 + i / 8] |= 1 << (i % 8);
        }
    }
    append_crc(&payload)
}

/// 解析读取响应帧，返回位或寄存器值数组。
pub fn parse_read_response(frame: &[u8], slave_id: u8, function_code: u8, quantity: u32) -> Result<Vec<u16>, String> {
    if !verify_crc(frame) {
        return Err(format!("响应报文 CRC 校验失败 [{}]", frame_to_hex(frame)));
    }
    if frame.is_empty() || frame[0] != slave_id {
        return Err(format!("响应从机地址不匹配 [{}]", frame_to_hex(frame)));
    }
    if (frame[1] & 0x80) != 0 {
        return Err(format!(
            "从机返回异常码 0x{:02X} [{}]",
            frame[2],
            frame_to_hex(frame)
        ));
    }
    if frame[1] != function_code {
        return Err(format!("响应功能码不匹配 [{}]", frame_to_hex(frame)));
    }
    let byte_count = frame[2] as usize;
    let expected_length = byte_count + 5;
    if frame.len() < expected_length {
        return Err(format!(
            "响应报文长度不足：期望 {} 字节，实际 {} 字节 [{}]",
            expected_length,
            frame.len(),
            frame_to_hex(frame)
        ));
    }
    let mut values: Vec<u16> = Vec::new();
    if function_code == 1 || function_code == 2 {
        for i in 0..byte_count {
            if values.len() as u32 >= quantity {
                break;
            }
            let byte_val = frame[3 + i];
            for bit in 0..8 {
                if values.len() as u32 >= quantity {
                    break;
                }
                values.push(((byte_val >> bit) & 1) as u16);
            }
        }
    } else {
        if byte_count % 2 != 0 {
            return Err(format!("寄存器响应字节数必须为偶数 [{}]", frame_to_hex(frame)));
        }
        for index in (0..byte_count).step_by(2) {
            values.push(u16::from_be_bytes([frame[3 + index], frame[4 + index]]));
        }
    }
    Ok(values)
}

/// 校验写单个线圈 / 寄存器响应（回显请求 PDU，不含 CRC 前 5 字节）。
pub fn verify_write_single_response(response: &[u8], request: &[u8]) -> Result<(), String> {
    if !verify_crc(response) {
        return Err(format!("写响应 CRC 校验失败 [{}]", frame_to_hex(response)));
    }
    for i in 0..request.len() {
        if response[i] != request[i] {
            return Err(format!("写响应与请求不匹配 [{}]", frame_to_hex(response)));
        }
    }
    Ok(())
}

/// 校验写多个线圈 / 寄存器响应（功能码 + 起始地址 + 数量）。
pub fn verify_write_multiple_response(
    response: &[u8],
    slave_id: u8,
    function_code: u8,
    start_address: u16,
    quantity: u16,
) -> Result<(), String> {
    if !verify_crc(response) {
        return Err(format!("写响应 CRC 校验失败 [{}]", frame_to_hex(response)));
    }
    if response[0] != slave_id
        || response[1] != function_code
        || u16::from_be_bytes([response[2], response[3]]) != start_address
        || u16::from_be_bytes([response[4], response[5]]) != quantity
    {
        return Err(format!("写多个响应与请求不匹配 [{}]", frame_to_hex(response)));
    }
    Ok(())
}

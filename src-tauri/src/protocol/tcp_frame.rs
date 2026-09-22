//! Modbus TCP / UDP 帧构造与解析（MBAP 头 + PDU）。
//!
//! 与 `src/main/protocol/tcp-frame.ts` 逻辑等价。TCP 与 UDP 帧格式相同，
//! 区别仅在传输层（见 services 层）。

use crate::protocol::crc16::frame_to_hex;

/// 构造完整 Modbus TCP 报文（MBAP 头 + PDU）。
pub fn build_tcp_frame(transaction_id: u16, unit_id: u8, pdu: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(7 + pdu.len());
    frame.extend_from_slice(&transaction_id.to_be_bytes());
    frame.extend_from_slice(&0u16.to_be_bytes()); // 协议标识 = 0
    frame.extend_from_slice(&((pdu.len() + 1) as u16).to_be_bytes());
    frame.push(unit_id);
    frame.extend_from_slice(pdu);
    frame
}

/// 构造读取请求帧（FC01~04）。
pub fn build_tcp_read_frame(
    transaction_id: u16,
    unit_id: u8,
    function_code: u8,
    start_address: u16,
    quantity: u16,
) -> Vec<u8> {
    let pdu = [
        function_code,
        (start_address >> 8) as u8,
        (start_address & 0xff) as u8,
        (quantity >> 8) as u8,
        (quantity & 0xff) as u8,
    ];
    build_tcp_frame(transaction_id, unit_id, &pdu)
}

/// 构造写单个保持寄存器请求帧（FC06）。
pub fn build_tcp_write_single_frame(transaction_id: u16, unit_id: u8, address: u16, value: u16) -> Vec<u8> {
    let pdu = [
        0x06,
        (address >> 8) as u8,
        (address & 0xff) as u8,
        (value >> 8) as u8,
        (value & 0xff) as u8,
    ];
    build_tcp_frame(transaction_id, unit_id, &pdu)
}

/// 构造写多个保持寄存器请求帧（FC16）。
pub fn build_tcp_write_multiple_frame(transaction_id: u16, unit_id: u8, start_address: u16, values: &[u16]) -> Vec<u8> {
    let mut pdu = Vec::with_capacity(6 + values.len() * 2);
    pdu.push(0x10);
    pdu.extend_from_slice(&start_address.to_be_bytes());
    pdu.extend_from_slice(&(values.len() as u16).to_be_bytes());
    pdu.push((values.len() * 2) as u8);
    for &v in values {
        pdu.extend_from_slice(&v.to_be_bytes());
    }
    build_tcp_frame(transaction_id, unit_id, &pdu)
}

/// 构造写单个线圈请求帧（FC05）。
pub fn build_tcp_write_single_coil_frame(transaction_id: u16, unit_id: u8, address: u16, value: bool) -> Vec<u8> {
    let v: u16 = if value { 0xff00 } else { 0x0000 };
    let pdu = [
        0x05,
        (address >> 8) as u8,
        (address & 0xff) as u8,
        (v >> 8) as u8,
        (v & 0xff) as u8,
    ];
    build_tcp_frame(transaction_id, unit_id, &pdu)
}

/// 构造写多个线圈请求帧（FC15）。
pub fn build_tcp_write_multiple_coils_frame(transaction_id: u16, unit_id: u8, start_address: u16, values: &[u16]) -> Vec<u8> {
    let byte_count = (values.len() + 7) / 8;
    let mut pdu = Vec::with_capacity(7 + byte_count);
    pdu.push(0x0f);
    pdu.extend_from_slice(&start_address.to_be_bytes());
    pdu.extend_from_slice(&(values.len() as u16).to_be_bytes());
    pdu.push(byte_count as u8);
    for (i, &val) in values.iter().enumerate() {
        if val != 0 {
            pdu[6 + i / 8] |= 1 << (i % 8);
        }
    }
    build_tcp_frame(transaction_id, unit_id, &pdu)
}

/// 解析 Modbus TCP 读取响应，返回位或寄存器值数组。
pub fn parse_tcp_read_response(
    frame: &[u8],
    transaction_id: u16,
    unit_id: u8,
    function_code: u8,
    quantity: u32,
) -> Result<Vec<u16>, String> {
    if frame.len() < 9
        || u16::from_be_bytes([frame[0], frame[1]]) != transaction_id
        || u16::from_be_bytes([frame[2], frame[3]]) != 0
    {
        return Err(format!("Modbus TCP 响应头无效 [{}]", frame_to_hex(frame)));
    }
    if frame[6] != unit_id {
        return Err(format!("Modbus TCP 单元标识不匹配 [{}]", frame_to_hex(frame)));
    }
    if (frame[7] & 0x80) != 0 {
        return Err(format!(
            "从机返回异常码 0x{:02X} [{}]",
            frame[8],
            frame_to_hex(frame)
        ));
    }
    if frame[7] != function_code {
        return Err(format!("Modbus TCP 功能码不匹配 [{}]", frame_to_hex(frame)));
    }
    let byte_count = frame[8] as usize;
    let expected_length = 9 + byte_count;
    if frame.len() < expected_length {
        return Err(format!(
            "Modbus TCP 响应长度不足：期望 {} 字节，实际 {} 字节 [{}]",
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
            let byte_val = frame[9 + i];
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
        for offset in (0..byte_count).step_by(2) {
            values.push(u16::from_be_bytes([frame[9 + offset], frame[10 + offset]]));
        }
    }
    Ok(values)
}

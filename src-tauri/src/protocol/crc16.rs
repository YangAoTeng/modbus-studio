//! Modbus RTU CRC16 校验（多项式 0xA001，低字节在前）。

/// 计算 Modbus RTU CRC16 校验值。
pub fn calculate_crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0xffff;
    for &byte in data {
        crc ^= byte as u16;
        for _ in 0..8 {
            crc = if (crc & 0x0001) != 0 {
                (crc >> 1) ^ 0xa001
            } else {
                crc >> 1
            };
        }
    }
    crc
}

/// 为报文主体追加 CRC16（低字节、高字节顺序）。
pub fn append_crc(payload: &[u8]) -> Vec<u8> {
    let crc = calculate_crc16(payload);
    let mut frame = Vec::with_capacity(payload.len() + 2);
    frame.extend_from_slice(payload);
    frame.push((crc & 0xff) as u8);
    frame.push(((crc >> 8) & 0xff) as u8);
    frame
}

/// 校验完整 RTU 报文的 CRC。
pub fn verify_crc(frame: &[u8]) -> bool {
    if frame.len() < 4 {
        return false;
    }
    let expected = calculate_crc16(&frame[..frame.len() - 2]);
    frame[frame.len() - 2] == (expected & 0xff) as u8
        && frame[frame.len() - 1] == ((expected >> 8) & 0xff) as u8
}

/// 将二进制报文格式化为大写十六进制、空格分隔的文本。
pub fn frame_to_hex(frame: &[u8]) -> String {
    frame
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join(" ")
}

//! Modbus Server 四区数据模型与 PDU 处理。
//!
//! 与 `src/main/protocol/server-pdu.ts` 逻辑等价。支持 FC01/02/03/04/05/06/15/16。

use crate::types::ServerAreaName;
use crate::types::ServerDataUpdate;

/// 从站四区数据模型（每区完整 65536 地址空间）。
pub struct ServerDataModel {
    pub coil: Vec<u8>,
    pub discrete: Vec<u8>,
    pub input: Vec<u16>,
    pub holding: Vec<u16>,
}

/// 创建初始为零的四区数据模型。
pub fn create_server_data_model() -> ServerDataModel {
    ServerDataModel {
        coil: vec![0u8; 65536],
        discrete: vec![0u8; 65536],
        input: vec![0u16; 65536],
        holding: vec![0u16; 65536],
    }
}

/// 处理 Modbus Server PDU 请求并返回响应 PDU。
///
/// 主站写入的数据变化通过 `on_update` 回调上报。
pub fn process_server_pdu(
    pdu: &[u8],
    data: &mut ServerDataModel,
    on_update: &mut dyn FnMut(ServerDataUpdate),
) -> Vec<u8> {
    let function_code = if pdu.is_empty() { 0 } else { pdu[0] };
    let result: Result<Vec<u8>, ()> = (|| {
        match function_code {
            1 | 2 => read_bits(function_code, pdu, if function_code == 1 { &data.coil } else { &data.discrete }),
            3 | 4 => read_registers(function_code, pdu, if function_code == 3 { &data.holding } else { &data.input }),
            5 => write_single_coil(pdu, &mut data.coil, on_update),
            6 => write_single_register(pdu, &mut data.holding, on_update),
            15 => write_multiple_coils(pdu, &mut data.coil, on_update),
            16 => write_multiple_registers(pdu, &mut data.holding, on_update),
            _ => Err(()),
        }
    })();
    match result {
        Ok(resp) => resp,
        Err(_) => vec![function_code | 0x80, 0x01],
    }
}

fn read_bits(function_code: u8, pdu: &[u8], source: &[u8]) -> Result<Vec<u8>, ()> {
    if pdu.len() < 5 {
        return Err(());
    }
    let start = u16::from_be_bytes([pdu[1], pdu[2]]) as usize;
    let quantity = u16::from_be_bytes([pdu[3], pdu[4]]) as usize;
    if quantity < 1 || quantity > 2000 || start + quantity > source.len() {
        return Err(());
    }
    let mut response = vec![0u8; 2 + (quantity + 7) / 8];
    response[0] = function_code;
    response[1] = (response.len() - 2) as u8;
    for index in 0..quantity {
        if source[start + index] != 0 {
            response[2 + index / 8] |= 1 << (index % 8);
        }
    }
    Ok(response)
}

fn read_registers(function_code: u8, pdu: &[u8], source: &[u16]) -> Result<Vec<u8>, ()> {
    if pdu.len() < 5 {
        return Err(());
    }
    let start = u16::from_be_bytes([pdu[1], pdu[2]]) as usize;
    let quantity = u16::from_be_bytes([pdu[3], pdu[4]]) as usize;
    if quantity < 1 || quantity > 125 || start + quantity > source.len() {
        return Err(());
    }
    let mut response = vec![0u8; 2 + quantity * 2];
    response[0] = function_code;
    response[1] = (quantity * 2) as u8;
    for index in 0..quantity {
        response[2 + index * 2..2 + index * 2 + 2]
            .copy_from_slice(&source[start + index].to_be_bytes());
    }
    Ok(response)
}

fn write_single_coil(pdu: &[u8], target: &mut [u8], on_update: &mut dyn FnMut(ServerDataUpdate)) -> Result<Vec<u8>, ()> {
    if pdu.len() < 5 {
        return Err(());
    }
    let address = u16::from_be_bytes([pdu[1], pdu[2]]) as usize;
    let raw_value = u16::from_be_bytes([pdu[3], pdu[4]]);
    if raw_value != 0xff00 && raw_value != 0x0000 {
        return Err(());
    }
    target[address] = if raw_value == 0xff00 { 1 } else { 0 };
    on_update(ServerDataUpdate {
        area: ServerAreaName::Coil,
        address: address as u32,
        value: target[address] as u16,
    });
    Ok(pdu[..5].to_vec())
}

fn write_single_register(pdu: &[u8], target: &mut [u16], on_update: &mut dyn FnMut(ServerDataUpdate)) -> Result<Vec<u8>, ()> {
    if pdu.len() < 5 {
        return Err(());
    }
    let address = u16::from_be_bytes([pdu[1], pdu[2]]) as usize;
    target[address] = u16::from_be_bytes([pdu[3], pdu[4]]);
    on_update(ServerDataUpdate {
        area: ServerAreaName::Holding,
        address: address as u32,
        value: target[address],
    });
    Ok(pdu[..5].to_vec())
}

fn write_multiple_coils(pdu: &[u8], target: &mut [u8], on_update: &mut dyn FnMut(ServerDataUpdate)) -> Result<Vec<u8>, ()> {
    if pdu.len() < 6 {
        return Err(());
    }
    let start = u16::from_be_bytes([pdu[1], pdu[2]]) as usize;
    let quantity = u16::from_be_bytes([pdu[3], pdu[4]]) as usize;
    if quantity < 1
        || quantity > 1968
        || start + quantity > target.len()
        || pdu[5] as usize != (quantity + 7) / 8
    {
        return Err(());
    }
    for index in 0..quantity {
        target[start + index] = ((pdu[6 + index / 8] >> (index % 8)) & 1) as u8;
        on_update(ServerDataUpdate {
            area: ServerAreaName::Coil,
            address: (start + index) as u32,
            value: target[start + index] as u16,
        });
    }
    Ok(vec![15, pdu[1], pdu[2], pdu[3], pdu[4]])
}

fn write_multiple_registers(pdu: &[u8], target: &mut [u16], on_update: &mut dyn FnMut(ServerDataUpdate)) -> Result<Vec<u8>, ()> {
    if pdu.len() < 6 {
        return Err(());
    }
    let start = u16::from_be_bytes([pdu[1], pdu[2]]) as usize;
    let quantity = u16::from_be_bytes([pdu[3], pdu[4]]) as usize;
    if quantity < 1
        || quantity > 123
        || start + quantity > target.len()
        || pdu[5] as usize != quantity * 2
    {
        return Err(());
    }
    for index in 0..quantity {
        target[start + index] = u16::from_be_bytes([pdu[6 + index * 2], pdu[7 + index * 2]]);
        on_update(ServerDataUpdate {
            area: ServerAreaName::Holding,
            address: (start + index) as u32,
            value: target[start + index],
        });
    }
    Ok(vec![16, pdu[1], pdu[2], pdu[3], pdu[4]])
}

import { appendCrc, verifyCrc } from './crc16'

/**
 * @brief 构造读取数据的 Modbus RTU 请求帧。
 *
 * PDU 结构对 FC01~04 完全一致：功能码 + 起始地址(2B) + 数量(2B)。
 * @param slaveId 从机地址。
 * @param functionCode 功能码 01～04。
 * @param startAddress 起始地址。
 * @param quantity 读取数量（线圈/离散输入为位数，寄存器为字数）。
 * @returns 完整 RTU 请求帧。
 */
export function buildReadFrame(slaveId: number, functionCode: 1 | 2 | 3 | 4, startAddress: number, quantity: number): Buffer {
  return appendCrc(Uint8Array.from([
    slaveId,
    functionCode,
    (startAddress >>> 8) & 0xff,
    startAddress & 0xff,
    (quantity >>> 8) & 0xff,
    quantity & 0xff
  ]))
}

/**
 * @brief 构造写单个保持寄存器的 Modbus RTU 请求帧。
 *
 * 使用 06 功能码编码寄存器地址和 16 位写入值，并在末尾追加 CRC。
 * @param slaveId 从机地址。
 * @param address 寄存器地址。
 * @param value 16 位写入值。
 * @returns 完整 RTU 请求帧。
 */
export function buildWriteSingleFrame(slaveId: number, address: number, value: number): Buffer {
  return appendCrc(Uint8Array.from([
    slaveId,
    0x06,
    (address >>> 8) & 0xff,
    address & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  ]))
}

/**
 * @brief 构造写多个保持寄存器的 Modbus RTU 请求帧。
 *
 * 使用 16 功能码编码起始地址、寄存器数量、字节数和大端寄存器数据，并追加 CRC。
 * @param slaveId 从机地址。
 * @param startAddress 起始寄存器地址。
 * @param values 待写入的 16 位寄存器值。
 * @returns 完整 RTU 请求帧。
 */
export function buildWriteMultipleFrame(slaveId: number, startAddress: number, values: number[]): Buffer {
  const payload = Buffer.alloc(7 + values.length * 2)
  payload[0] = slaveId
  payload[1] = 0x10
  payload.writeUInt16BE(startAddress, 2)
  payload.writeUInt16BE(values.length, 4)
  payload[6] = values.length * 2
  values.forEach((value, index) => payload.writeUInt16BE(value, 7 + index * 2))
  return appendCrc(payload)
}

/**
 * @brief 解析读取响应帧（寄存器或位）。
 *
 * FC01/02 返回 LSB-first 打包的位数据，FC03/04 返回 16 位寄存器数组。
 * @param frame 接收到的完整 RTU 响应帧。
 * @param slaveId 期望的从机地址。
 * @param functionCode 期望的功能码 01～04。
 * @returns 解析后的值数组（线圈/离散为 0 或 1，寄存器为 16 位无符号整数）。
 */
export function parseReadResponse(frame: Buffer, slaveId: number, functionCode: 1 | 2 | 3 | 4, quantity: number): number[] {
  if (!verifyCrc(frame)) throw new Error('响应报文 CRC 校验失败')
  if (frame[0] !== slaveId) throw new Error('响应从机地址不匹配')
  if ((frame[1] & 0x80) !== 0) throw new Error(`从机返回异常码 0x${frame[2].toString(16).padStart(2, '0')}`)
  if (frame[1] !== functionCode) throw new Error('响应功能码不匹配')
  const byteCount = frame[2]
  const expectedLength = byteCount + 5
  if (frame.length < expectedLength) throw new Error(`响应报文长度不足：期望 ${expectedLength} 字节，实际 ${frame.length} 字节`)
  const values: number[] = []
  if (functionCode === 1 || functionCode === 2) {
    for (let i = 0; i < byteCount && values.length < quantity; i += 1) {
      const byteVal = frame[3 + i]
      for (let bit = 0; bit < 8 && values.length < quantity; bit += 1) values.push((byteVal >> bit) & 1)
    }
  } else {
    if (byteCount % 2 !== 0) throw new Error('寄存器响应字节数必须为偶数')
    for (let index = 0; index < byteCount; index += 2) values.push(frame.readUInt16BE(3 + index))
  }
  return values
}

/**
 * @brief 构造写单个线圈的 Modbus RTU 请求帧。
 *
 * 使用 05 功能码，值 0xFF00 表示 ON，0x0000 表示 OFF。
 * @param slaveId 从机地址。
 * @param address 线圈地址。
 * @param value true 为 ON。
 * @returns 完整 RTU 请求帧。
 */
export function buildWriteSingleCoilFrame(slaveId: number, address: number, value: boolean): Buffer {
  return appendCrc(Uint8Array.from([
    slaveId,
    0x05,
    (address >>> 8) & 0xff,
    address & 0xff,
    value ? 0xff : 0x00,
    0x00
  ]))
}

/**
 * @brief 构造写多个线圈的 Modbus RTU 请求帧。
 *
 * 使用 15 功能码，位数据按 LSB-first 打包。
 * @param slaveId 从机地址。
 * @param startAddress 起始线圈地址。
 * @param values 线圈值数组。
 * @returns 完整 RTU 请求帧。
 */
export function buildWriteMultipleCoilsFrame(slaveId: number, startAddress: number, values: number[]): Buffer {
  const byteCount = Math.ceil(values.length / 8)
  const payload = Buffer.alloc(7 + byteCount)
  payload[0] = slaveId
  payload[1] = 0x0f
  payload.writeUInt16BE(startAddress, 2)
  payload.writeUInt16BE(values.length, 4)
  payload[6] = byteCount
  for (let i = 0; i < values.length; i += 1) {
    if (values[i]) payload[7 + Math.floor(i / 8)] |= 1 << (i % 8)
  }
  return appendCrc(payload)
}

/**
 * @brief 校验写单个线圈/寄存器的 RTU 响应。
 *
 * FC05 和 FC06 的响应回显请求的 5 字节 PDU，逐字节比对即可。
 * @param response 响应帧。
 * @param request 请求帧（含 CRC 之前部分）。
 */
export function verifyWriteSingleResponse(response: Buffer, request: Uint8Array): void {
  if (!verifyCrc(response)) throw new Error('写响应 CRC 校验失败')
  for (let i = 0; i < request.length; i += 1) {
    if (response[i] !== request[i]) throw new Error('写响应与请求不匹配')
  }
}

/**
 * @brief 校验写多个线圈/寄存器的 RTU 响应。
 *
 * FC15 和 FC16 的响应仅回显功能码、起始地址和数量（共 5 字节 PDU）。
 * @param response 响应帧。
 * @param slaveId 从机地址。
 * @param functionCode 功能码。
 * @param startAddress 起始地址。
 * @param quantity 写入数量。
 */
export function verifyWriteMultipleResponse(response: Buffer, slaveId: number, functionCode: 15 | 16, startAddress: number, quantity: number): void {
  if (!verifyCrc(response)) throw new Error('写响应 CRC 校验失败')
  if (response[0] !== slaveId || response[1] !== functionCode || response.readUInt16BE(2) !== startAddress || response.readUInt16BE(4) !== quantity) {
    throw new Error('写多个响应与请求不匹配')
  }
}

/**
 * @brief 将二进制报文格式化为十六进制文本。
 *
 * 每个字节使用两位大写十六进制表示，并用空格分隔，便于日志展示和复制。
 * @param frame 二进制报文。
 * @returns 十六进制字符串。
 */
export function frameToHex(frame: Uint8Array): string {
  return Array.from(frame, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ')
}

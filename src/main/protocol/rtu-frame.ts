import { appendCrc, verifyCrc } from './crc16'

/**
 * @brief 构造读取寄存器的 Modbus RTU 请求帧。
 *
 * 支持 03 和 04 功能码，将从机地址、起始地址和数量编码为大端字段并追加 CRC。
 * @param slaveId 从机地址。
 * @param functionCode 功能码 03 或 04。
 * @param startAddress 起始寄存器地址。
 * @param quantity 读取寄存器数量。
 * @returns 完整 RTU 请求帧。
 */
export function buildReadFrame(slaveId: number, functionCode: 3 | 4, startAddress: number, quantity: number): Buffer {
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
 * @brief 解析读取寄存器响应帧。
 *
 * 检查从机地址、功能码、异常响应、字节数和 CRC，然后提取 16 位寄存器数组。
 * @param frame 接收到的完整 RTU 响应帧。
 * @param slaveId 期望的从机地址。
 * @param functionCode 期望的功能码。
 * @returns 解析后的寄存器数组。
 */
export function parseReadResponse(frame: Buffer, slaveId: number, functionCode: 3 | 4): number[] {
  if (!verifyCrc(frame)) throw new Error('响应报文 CRC 校验失败')
  if (frame[0] !== slaveId) throw new Error('响应从机地址不匹配')
  if ((frame[1] & 0x80) !== 0) throw new Error(`从机返回异常码 0x${frame[2].toString(16).padStart(2, '0')}`)
  if (frame[1] !== functionCode) throw new Error('响应功能码不匹配')
  const byteCount = frame[2]
  if (frame.length !== byteCount + 5 || byteCount % 2 !== 0) throw new Error('响应报文长度不正确')
  const values: number[] = []
  for (let index = 0; index < byteCount; index += 2) {
    values.push(frame.readUInt16BE(3 + index))
  }
  return values
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

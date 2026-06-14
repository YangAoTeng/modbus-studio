/**
 * @brief 计算 Modbus RTU CRC16 校验值。
 *
 * 按 Modbus 多项式 0xA001 对报文逐字节计算，返回低字节在前的 16 位校验值。
 * @param data 不包含 CRC 字段的报文字节。
 * @returns CRC16 校验值。
 */
export function calculateCrc16(data: Uint8Array): number {
  let crc = 0xffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x0001) !== 0 ? (crc >>> 1) ^ 0xa001 : crc >>> 1
    }
  }
  return crc
}

/**
 * @brief 为 Modbus RTU 报文追加 CRC 字段。
 *
 * 计算报文主体的 CRC16，并按照低字节、高字节顺序追加到报文尾部。
 * @param payload 不包含 CRC 的报文主体。
 * @returns 包含 CRC 的完整报文。
 */
export function appendCrc(payload: Uint8Array): Buffer {
  const crc = calculateCrc16(payload)
  return Buffer.concat([Buffer.from(payload), Buffer.from([crc & 0xff, (crc >>> 8) & 0xff])])
}

/**
 * @brief 校验完整 Modbus RTU 报文的 CRC。
 *
 * 将接收报文尾部两字节与重新计算的 CRC 比较，用于识别传输错误。
 * @param frame 完整 RTU 报文。
 * @returns CRC 正确时返回 true。
 */
export function verifyCrc(frame: Uint8Array): boolean {
  if (frame.length < 4) return false
  const expected = calculateCrc16(frame.subarray(0, -2))
  return frame[frame.length - 2] === (expected & 0xff) && frame[frame.length - 1] === ((expected >>> 8) & 0xff)
}

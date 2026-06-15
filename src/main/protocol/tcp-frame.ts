/**
 * @brief 构造 Modbus TCP ADU 报文。
 *
 * 生成 MBAP 头并附加功能码数据单元，事务标识用于匹配请求和响应。
 * @param transactionId 事务标识。
 * @param unitId 单元标识。
 * @param pdu Modbus PDU。
 * @returns 完整 Modbus TCP 报文。
 */
export function buildTcpFrame(transactionId: number, unitId: number, pdu: Uint8Array): Buffer {
  const frame = Buffer.alloc(7 + pdu.length)
  frame.writeUInt16BE(transactionId, 0)
  frame.writeUInt16BE(0, 2)
  frame.writeUInt16BE(pdu.length + 1, 4)
  frame[6] = unitId
  Buffer.from(pdu).copy(frame, 7)
  return frame
}

/**
 * @brief 构造读取寄存器的 Modbus TCP 请求。
 *
 * 支持 03 和 04 功能码，并使用 MBAP 头封装请求参数。
 * @param transactionId 事务标识。
 * @param unitId 单元标识。
 * @param functionCode 功能码。
 * @param startAddress 起始地址。
 * @param quantity 读取数量。
 * @returns 完整 TCP 请求报文。
 */
export function buildTcpReadFrame(transactionId: number, unitId: number, functionCode: 1 | 2 | 3 | 4, startAddress: number, quantity: number): Buffer {
  const pdu = Buffer.alloc(5)
  pdu[0] = functionCode
  pdu.writeUInt16BE(startAddress, 1)
  pdu.writeUInt16BE(quantity, 3)
  return buildTcpFrame(transactionId, unitId, pdu)
}

/**
 * @brief 构造写单个寄存器的 Modbus TCP 请求。
 *
 * 使用 06 功能码编码地址和值。
 * @param transactionId 事务标识。
 * @param unitId 单元标识。
 * @param address 寄存器地址。
 * @param value 写入值。
 * @returns 完整 TCP 请求报文。
 */
export function buildTcpWriteSingleFrame(transactionId: number, unitId: number, address: number, value: number): Buffer {
  const pdu = Buffer.alloc(5)
  pdu[0] = 0x06
  pdu.writeUInt16BE(address, 1)
  pdu.writeUInt16BE(value, 3)
  return buildTcpFrame(transactionId, unitId, pdu)
}

/**
 * @brief 构造写多个寄存器的 Modbus TCP 请求。
 *
 * 使用 16 功能码编码连续寄存器值。
 * @param transactionId 事务标识。
 * @param unitId 单元标识。
 * @param startAddress 起始地址。
 * @param values 写入值数组。
 * @returns 完整 TCP 请求报文。
 */
export function buildTcpWriteMultipleFrame(transactionId: number, unitId: number, startAddress: number, values: number[]): Buffer {
  const pdu = Buffer.alloc(6 + values.length * 2)
  pdu[0] = 0x10
  pdu.writeUInt16BE(startAddress, 1)
  pdu.writeUInt16BE(values.length, 3)
  pdu[5] = values.length * 2
  values.forEach((value, index) => pdu.writeUInt16BE(value, 6 + index * 2))
  return buildTcpFrame(transactionId, unitId, pdu)
}

/**
 * @brief 构造写单个线圈的 Modbus TCP 请求。
 * @param transactionId 事务标识。
 * @param unitId 单元标识。
 * @param address 线圈地址。
 * @param value 线圈值。
 * @returns 完整 TCP 请求报文。
 */
export function buildTcpWriteSingleCoilFrame(transactionId: number, unitId: number, address: number, value: boolean): Buffer {
  const pdu = Buffer.alloc(5)
  pdu[0] = 0x05
  pdu.writeUInt16BE(address, 1)
  pdu.writeUInt16BE(value ? 0xff00 : 0x0000, 3)
  return buildTcpFrame(transactionId, unitId, pdu)
}

/**
 * @brief 构造写多个线圈的 Modbus TCP 请求。
 * @param transactionId 事务标识。
 * @param unitId 单元标识。
 * @param startAddress 起始地址。
 * @param values 线圈值数组。
 * @returns 完整 TCP 请求报文。
 */
export function buildTcpWriteMultipleCoilsFrame(transactionId: number, unitId: number, startAddress: number, values: number[]): Buffer {
  const byteCount = Math.ceil(values.length / 8)
  const pdu = Buffer.alloc(7 + byteCount)
  pdu[0] = 0x0f
  pdu.writeUInt16BE(startAddress, 1)
  pdu.writeUInt16BE(values.length, 3)
  pdu[5] = byteCount
  for (let i = 0; i < values.length; i += 1) {
    if (values[i]) pdu[6 + Math.floor(i / 8)] |= 1 << (i % 8)
  }
  return buildTcpFrame(transactionId, unitId, pdu)
}

/**
 * @brief 解析 Modbus TCP 读取响应。
 *
 * 校验事务标识、协议标识、单元标识和功能码，然后提取 16 位寄存器数据。
 * @param frame 完整 TCP 响应。
 * @param transactionId 期望事务标识。
 * @param unitId 期望单元标识。
 * @param functionCode 期望功能码。
 * @returns 寄存器数组。
 */
export function parseTcpReadResponse(frame: Buffer, transactionId: number, unitId: number, functionCode: 1 | 2 | 3 | 4, quantity: number): number[] {
  if (frame.length < 9 || frame.readUInt16BE(0) !== transactionId || frame.readUInt16BE(2) !== 0) throw new Error('Modbus TCP 响应头无效')
  if (frame[6] !== unitId) throw new Error('Modbus TCP 单元标识不匹配')
  if ((frame[7] & 0x80) !== 0) throw new Error(`从机返回异常码 0x${frame[8].toString(16).padStart(2, '0')}`)
  if (frame[7] !== functionCode) throw new Error('Modbus TCP 功能码不匹配')
  const byteCount = frame[8]
  const expectedLength = 9 + byteCount
  if (frame.length < expectedLength) throw new Error(`Modbus TCP 响应长度不足：期望 ${expectedLength} 字节，实际 ${frame.length} 字节`)
  const values: number[] = []
  if (functionCode === 1 || functionCode === 2) {
    for (let i = 0; i < byteCount && values.length < quantity; i += 1) {
      const byteVal = frame[9 + i]
      for (let bit = 0; bit < 8 && values.length < quantity; bit += 1) values.push((byteVal >> bit) & 1)
    }
  } else {
    if (byteCount % 2 !== 0) throw new Error('寄存器响应字节数必须为偶数')
    for (let offset = 0; offset < byteCount; offset += 2) values.push(frame.readUInt16BE(9 + offset))
  }
  return values
}

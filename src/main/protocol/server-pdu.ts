import type { ServerAreaName, ServerDataUpdate } from '../../shared/types'

export interface ServerDataModel {
  coil: Uint8Array
  discrete: Uint8Array
  input: Uint16Array
  holding: Uint16Array
}

/**
 * @brief 创建 Modbus Server 四区数据模型。
 *
 * 为线圈、离散输入、输入寄存器和保持寄存器各分配完整地址空间。
 * @returns 初始化为零的四区数据模型。
 */
export function createServerDataModel(): ServerDataModel {
  return { coil: new Uint8Array(65536), discrete: new Uint8Array(65536), input: new Uint16Array(65536), holding: new Uint16Array(65536) }
}

/**
 * @brief 处理 Modbus Server PDU 请求。
 *
 * 支持 01、02、03、04、05、06、15、16 功能码，并通过回调上报外部主站写入的数据变化。
 * @param pdu 请求 PDU。
 * @param data 四区数据模型。
 * @param onUpdate 数据写入回调。
 * @returns 响应 PDU。
 */
export function processServerPdu(pdu: Buffer, data: ServerDataModel, onUpdate: (update: ServerDataUpdate) => void): Buffer {
  const functionCode = pdu[0]
  try {
    if ([1, 2].includes(functionCode)) return readBits(functionCode, pdu, functionCode === 1 ? data.coil : data.discrete)
    if ([3, 4].includes(functionCode)) return readRegisters(functionCode, pdu, functionCode === 3 ? data.holding : data.input)
    if (functionCode === 5) return writeSingleCoil(pdu, data.coil, onUpdate)
    if (functionCode === 6) return writeSingleRegister(pdu, data.holding, onUpdate)
    if (functionCode === 15) return writeMultipleCoils(pdu, data.coil, onUpdate)
    if (functionCode === 16) return writeMultipleRegisters(pdu, data.holding, onUpdate)
    return Buffer.from([functionCode | 0x80, 0x01])
  } catch {
    return Buffer.from([functionCode | 0x80, 0x03])
  }
}

/** @brief 读取位数据并打包为响应。详细说明：校验数量和地址范围后按低位优先方式压缩线圈状态。 */
function readBits(functionCode: number, pdu: Buffer, source: Uint8Array): Buffer {
  const start = pdu.readUInt16BE(1)
  const quantity = pdu.readUInt16BE(3)
  if (quantity < 1 || quantity > 2000 || start + quantity > source.length) throw new Error('非法位读取范围')
  const response = Buffer.alloc(2 + Math.ceil(quantity / 8))
  response[0] = functionCode
  response[1] = response.length - 2
  for (let index = 0; index < quantity; index += 1) if (source[start + index]) response[2 + Math.floor(index / 8)] |= 1 << (index % 8)
  return response
}

/** @brief 读取寄存器数据并构造响应。详细说明：校验范围后按大端顺序编码每个 16 位寄存器。 */
function readRegisters(functionCode: number, pdu: Buffer, source: Uint16Array): Buffer {
  const start = pdu.readUInt16BE(1)
  const quantity = pdu.readUInt16BE(3)
  if (quantity < 1 || quantity > 125 || start + quantity > source.length) throw new Error('非法寄存器读取范围')
  const response = Buffer.alloc(2 + quantity * 2)
  response[0] = functionCode
  response[1] = quantity * 2
  for (let index = 0; index < quantity; index += 1) response.writeUInt16BE(source[start + index], 2 + index * 2)
  return response
}

/** @brief 写入单个线圈。详细说明：仅接受 0xFF00 和 0x0000，并回显原始请求。 */
function writeSingleCoil(pdu: Buffer, target: Uint8Array, onUpdate: (update: ServerDataUpdate) => void): Buffer {
  const address = pdu.readUInt16BE(1)
  const rawValue = pdu.readUInt16BE(3)
  if (rawValue !== 0xff00 && rawValue !== 0x0000) throw new Error('线圈值无效')
  target[address] = rawValue === 0xff00 ? 1 : 0
  onUpdate({ area: 'coil', address, value: target[address] })
  return Buffer.from(pdu.subarray(0, 5))
}

/** @brief 写入单个保持寄存器。详细说明：更新数据模型、上报变化并回显请求。 */
function writeSingleRegister(pdu: Buffer, target: Uint16Array, onUpdate: (update: ServerDataUpdate) => void): Buffer {
  const address = pdu.readUInt16BE(1)
  target[address] = pdu.readUInt16BE(3)
  onUpdate({ area: 'holding', address, value: target[address] })
  return Buffer.from(pdu.subarray(0, 5))
}

/** @brief 写入多个线圈。详细说明：按低位优先解析压缩数据并返回写入起始地址和数量。 */
function writeMultipleCoils(pdu: Buffer, target: Uint8Array, onUpdate: (update: ServerDataUpdate) => void): Buffer {
  const start = pdu.readUInt16BE(1)
  const quantity = pdu.readUInt16BE(3)
  if (quantity < 1 || quantity > 1968 || start + quantity > target.length || pdu[5] !== Math.ceil(quantity / 8)) throw new Error('线圈写入长度无效')
  for (let index = 0; index < quantity; index += 1) {
    target[start + index] = (pdu[6 + Math.floor(index / 8)] >>> (index % 8)) & 1
    onUpdate({ area: 'coil', address: start + index, value: target[start + index] })
  }
  return Buffer.from([15, pdu[1], pdu[2], pdu[3], pdu[4]])
}

/** @brief 写入多个保持寄存器。详细说明：逐项解析大端数据并返回写入起始地址和数量。 */
function writeMultipleRegisters(pdu: Buffer, target: Uint16Array, onUpdate: (update: ServerDataUpdate) => void): Buffer {
  const start = pdu.readUInt16BE(1)
  const quantity = pdu.readUInt16BE(3)
  if (quantity < 1 || quantity > 123 || start + quantity > target.length || pdu[5] !== quantity * 2) throw new Error('寄存器写入长度无效')
  for (let index = 0; index < quantity; index += 1) {
    target[start + index] = pdu.readUInt16BE(6 + index * 2)
    onUpdate({ area: 'holding', address: start + index, value: target[start + index] })
  }
  return Buffer.from([16, pdu[1], pdu[2], pdu[3], pdu[4]])
}

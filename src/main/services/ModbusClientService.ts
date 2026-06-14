import type { ReadRegistersParams, TransactionResult, WriteMultipleRegistersParams, WriteRegisterParams } from '../../shared/types'
import { buildReadFrame, buildWriteMultipleFrame, buildWriteSingleFrame, frameToHex, parseReadResponse } from '../protocol/rtu-frame'
import { verifyCrc } from '../protocol/crc16'
import { SerialService } from './SerialService'

export class ModbusClientService {
  public constructor(private readonly serial: SerialService) {}

  /**
   * @brief 读取保持寄存器或输入寄存器。
   *
   * 根据参数构造 03 或 04 请求，完成串口事务并校验响应，最终返回日志和寄存器数据。
   * @param params 读取参数。
   * @returns Modbus 事务结果。
   */
  public async readRegisters(params: ReadRegistersParams): Promise<TransactionResult> {
    const request = buildReadFrame(params.slaveId, params.functionCode, params.startAddress, params.quantity)
    const startedAt = performance.now()
    const response = await this.serial.transact(request, params.timeout)
    const registers = parseReadResponse(response, params.slaveId, params.functionCode)
    return {
      tx: frameToHex(request),
      rx: frameToHex(response),
      registers,
      elapsedMs: Math.max(1, Math.round(performance.now() - startedAt)),
      crcValid: true
    }
  }

  /**
   * @brief 写入单个保持寄存器。
   *
   * 使用 06 功能码发送写请求，并检查从机回显报文的长度、内容及 CRC。
   * @param params 写寄存器参数。
   * @returns Modbus 事务结果。
   */
  public async writeSingleRegister(params: WriteRegisterParams): Promise<TransactionResult> {
    const request = buildWriteSingleFrame(params.slaveId, params.address, params.value)
    const startedAt = performance.now()
    const response = await this.serial.transact(request, params.timeout)
    if (!verifyCrc(response)) throw new Error('写响应 CRC 校验失败')
    if (!request.equals(response)) throw new Error('写响应内容与请求不一致')
    return {
      tx: frameToHex(request),
      rx: frameToHex(response),
      registers: [params.value],
      elapsedMs: Math.max(1, Math.round(performance.now() - startedAt)),
      crcValid: true
    }
  }

  /**
   * @brief 写入多个连续保持寄存器。
   *
   * 使用 16 功能码发送连续数据，校验响应 CRC、功能码、起始地址和写入数量。
   * @param params 多寄存器写入参数。
   * @returns Modbus 事务结果。
   */
  public async writeMultipleRegisters(params: WriteMultipleRegistersParams): Promise<TransactionResult> {
    if (params.values.length < 1 || params.values.length > 123) throw new Error('写入数量必须在 1 到 123 之间')
    const request = buildWriteMultipleFrame(params.slaveId, params.startAddress, params.values)
    const startedAt = performance.now()
    const response = await this.serial.transact(request, params.timeout)
    if (!verifyCrc(response)) throw new Error('写响应 CRC 校验失败')
    if (response[0] !== params.slaveId || response[1] !== 0x10) throw new Error('写响应地址或功能码不匹配')
    if (response.readUInt16BE(2) !== params.startAddress || response.readUInt16BE(4) !== params.values.length) throw new Error('写响应范围不匹配')
    return { tx: frameToHex(request), rx: frameToHex(response), registers: params.values, elapsedMs: Math.max(1, Math.round(performance.now() - startedAt)), crcValid: true }
  }
}

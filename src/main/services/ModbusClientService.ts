import type { ReadRegistersParams, TransactionResult, WriteMultipleRegistersParams, WriteRegisterParams } from '../../shared/types'
import { buildReadFrame, buildWriteMultipleCoilsFrame, buildWriteMultipleFrame, buildWriteSingleCoilFrame, buildWriteSingleFrame, frameToHex, parseReadResponse, verifyWriteMultipleResponse, verifyWriteSingleResponse } from '../protocol/rtu-frame'
import { SerialService } from './SerialService'

export class ModbusClientService {
  public constructor(private readonly serial: SerialService) {}

  /**
   * @brief 读取数据（线圈、离散输入、保持寄存器或输入寄存器）。
   *
   * 支持 FC01～04，自动根据功能码解析位或寄存器响应。
   * @param params 读取参数。
   * @returns Modbus 事务结果。
   */
  public async readRegisters(params: ReadRegistersParams): Promise<TransactionResult> {
    const request = buildReadFrame(params.slaveId, params.functionCode, params.startAddress, params.quantity)
    const startedAt = performance.now()
    const response = await this.serial.transact(request, params.timeout)
    const registers = parseReadResponse(response, params.slaveId, params.functionCode, params.quantity)
    return { tx: frameToHex(request), rx: frameToHex(response), registers, elapsedMs: Math.max(1, Math.round(performance.now() - startedAt)), crcValid: true }
  }

  /**
   * @brief 写入单个线圈或保持寄存器。
   *
   * FC05 写线圈（0xFF00 ON / 0x0000 OFF），FC06 写保持寄存器。
   * @param params 写入参数。
   * @returns Modbus 事务结果。
   */
  public async writeSingleRegister(params: WriteRegisterParams): Promise<TransactionResult> {
    const isCoil = params.functionCode === 5
    const request = isCoil
      ? buildWriteSingleCoilFrame(params.slaveId, params.address, Boolean(params.value))
      : buildWriteSingleFrame(params.slaveId, params.address, params.value)
    const startedAt = performance.now()
    const response = await this.serial.transact(request, params.timeout)
    verifyWriteSingleResponse(response, request.subarray(0, request.length - 2))
    return { tx: frameToHex(request), rx: frameToHex(response), registers: [params.value], elapsedMs: Math.max(1, Math.round(performance.now() - startedAt)), crcValid: true }
  }

  /**
   * @brief 写入多个线圈或保持寄存器。
   *
   * FC15 写多个线圈（LSB-first 打包），FC16 写多个保持寄存器。
   * @param params 多写入参数。
   * @returns Modbus 事务结果。
   */
  public async writeMultipleRegisters(params: WriteMultipleRegistersParams): Promise<TransactionResult> {
    if (params.values.length < 1 || params.values.length > 123) throw new Error('写入数量必须在 1 到 123 之间')
    const isCoil = params.functionCode === 15
    const request = isCoil
      ? buildWriteMultipleCoilsFrame(params.slaveId, params.startAddress, params.values)
      : buildWriteMultipleFrame(params.slaveId, params.startAddress, params.values)
    const startedAt = performance.now()
    const response = await this.serial.transact(request, params.timeout)
    const fc: 15 | 16 = isCoil ? 15 : 16
    verifyWriteMultipleResponse(response, params.slaveId, fc, params.startAddress, params.values.length)
    return { tx: frameToHex(request), rx: frameToHex(response), registers: params.values, elapsedMs: Math.max(1, Math.round(performance.now() - startedAt)), crcValid: true }
  }
}

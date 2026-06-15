import { Socket } from 'node:net'
import type { ReadRegistersParams, TcpConfig, TransactionResult, WriteMultipleRegistersParams, WriteRegisterParams } from '../../shared/types'
import { frameToHex } from '../protocol/rtu-frame'
import { buildTcpReadFrame, buildTcpWriteMultipleCoilsFrame, buildTcpWriteMultipleFrame, buildTcpWriteSingleCoilFrame, buildTcpWriteSingleFrame, parseTcpReadResponse } from '../protocol/tcp-frame'

export class TcpClientService {
  private socket: Socket | null = null
  private transactionId = 1

  /**
   * @brief 建立 Modbus TCP 连接。
   *
   * 关闭旧连接后连接指定主机和端口，并按配置设置套接字超时时间。
   * @param config TCP 连接参数。
   */
  public async connect(config: TcpConfig): Promise<void> {
    await this.disconnect()
    const socket = new Socket()
    socket.setTimeout(config.timeout)
    await new Promise<void>((resolve, reject) => {
      const onConnect = (): void => { socket.off('error', onError); resolve() }
      const onError = (error: Error): void => { socket.off('connect', onConnect); reject(error) }
      socket.once('connect', onConnect)
      socket.once('error', onError)
      socket.connect(config.port, config.host)
    })
    this.socket = socket
  }

  /** @brief 断开 Modbus TCP 连接。 */
  public async disconnect(): Promise<void> {
    const socket = this.socket
    this.socket = null
    if (!socket || socket.destroyed) return
    await new Promise<void>((resolve) => {
      socket.once('close', resolve)
      socket.end()
      setTimeout(() => { if (!socket.destroyed) socket.destroy(); resolve() }, 300)
    })
  }

  /**
   * @brief 读取数据（线圈、离散输入或寄存器）。
   *
   * 支持 FC01～04，自动按功能码解包位或寄存器值。
   * @param params 读取参数。
   * @returns TCP 事务结果。
   */
  public async readRegisters(params: ReadRegistersParams): Promise<TransactionResult> {
    const transactionId = this.nextTransactionId()
    const request = buildTcpReadFrame(transactionId, params.slaveId, params.functionCode, params.startAddress, params.quantity)
    const startedAt = performance.now()
    const response = await this.transact(request, params.timeout)
    return { tx: frameToHex(request), rx: frameToHex(response), registers: parseTcpReadResponse(response, transactionId, params.slaveId, params.functionCode, params.quantity), elapsedMs: Math.max(1, Math.round(performance.now() - startedAt)), crcValid: true }
  }

  /**
   * @brief 写入单个线圈（FC05）或保持寄存器（FC06）。
   * @param params 写入参数。
   * @returns TCP 事务结果。
   */
  public async writeSingleRegister(params: WriteRegisterParams): Promise<TransactionResult> {
    const transactionId = this.nextTransactionId()
    const isCoil = params.functionCode === 5
    const request = isCoil
      ? buildTcpWriteSingleCoilFrame(transactionId, params.slaveId, params.address, Boolean(params.value))
      : buildTcpWriteSingleFrame(transactionId, params.slaveId, params.address, params.value)
    const startedAt = performance.now()
    const response = await this.transact(request, params.timeout)
    // 分字段校验：MBAP 事务标识 + 单元标识 + PDU 功能码/地址/值
    if (response.readUInt16BE(0) !== transactionId || response[6] !== params.slaveId || response[7] !== (isCoil ? 0x05 : 0x06)) throw new Error('Modbus TCP 写响应头不匹配')
    if (response.readUInt16BE(8) !== params.address || response.readUInt16BE(10) !== (isCoil ? (params.value ? 0xff00 : 0x0000) : params.value)) throw new Error('Modbus TCP 写响应地址或值不匹配')
    return { tx: frameToHex(request), rx: frameToHex(response), registers: [params.value], elapsedMs: Math.max(1, Math.round(performance.now() - startedAt)), crcValid: true }
  }

  /**
   * @brief 写入多个线圈（FC15）或保持寄存器（FC16）。
   * @param params 多写入参数。
   * @returns TCP 事务结果。
   */
  public async writeMultipleRegisters(params: WriteMultipleRegistersParams): Promise<TransactionResult> {
    const transactionId = this.nextTransactionId()
    const isCoil = params.functionCode === 15
    const request = isCoil
      ? buildTcpWriteMultipleCoilsFrame(transactionId, params.slaveId, params.startAddress, params.values)
      : buildTcpWriteMultipleFrame(transactionId, params.slaveId, params.startAddress, params.values)
    const startedAt = performance.now()
    const response = await this.transact(request, params.timeout)
    const fc = isCoil ? 0x0f : 0x10
    if (response.readUInt16BE(0) !== transactionId || response[7] !== fc || response.readUInt16BE(8) !== params.startAddress || response.readUInt16BE(10) !== params.values.length) throw new Error('Modbus TCP 写响应范围不匹配')
    return { tx: frameToHex(request), rx: frameToHex(response), registers: params.values, elapsedMs: Math.max(1, Math.round(performance.now() - startedAt)), crcValid: true }
  }

  /** @brief 返回下一个 TCP 事务标识。 */
  private nextTransactionId(): number {
    const current = this.transactionId
    this.transactionId = this.transactionId >= 0xffff ? 1 : this.transactionId + 1
    return current
  }

  /** @brief 发送 TCP 请求并等待完整 MBAP 响应。 */
  private async transact(request: Buffer, timeout: number): Promise<Buffer> {
    const socket = this.socket
    if (!socket || socket.destroyed) throw new Error('Modbus TCP 尚未连接')
    const activeSocket = socket
    return new Promise<Buffer>((resolve, reject) => {
      let response = Buffer.alloc(0)
      const timer = setTimeout(() => finish(new Error('等待 Modbus TCP 响应超时')), timeout)
      function finish(error?: Error): void { clearTimeout(timer); activeSocket.off('data', onData); activeSocket.off('error', onError); error ? reject(error) : resolve(response) }
      function onData(chunk: Buffer): void { response = Buffer.concat([response, chunk]); if (response.length >= 6 && response.length >= 6 + response.readUInt16BE(4)) { response = response.subarray(0, 6 + response.readUInt16BE(4)); finish() } }
      function onError(error: Error): void { finish(error) }
      activeSocket.on('data', onData)
      activeSocket.on('error', onError)
      activeSocket.write(request, (error) => error && finish(error))
    })
  }
}

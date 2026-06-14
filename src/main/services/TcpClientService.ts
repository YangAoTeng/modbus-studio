import { Socket } from 'node:net'
import type { ReadRegistersParams, TcpConfig, TransactionResult, WriteMultipleRegistersParams, WriteRegisterParams } from '../../shared/types'
import { frameToHex } from '../protocol/rtu-frame'
import { buildTcpReadFrame, buildTcpWriteMultipleFrame, buildTcpWriteSingleFrame, parseTcpReadResponse } from '../protocol/tcp-frame'

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
      /** @brief 处理连接成功。详细说明：移除临时错误监听并完成连接 Promise。 */
      const onConnect = (): void => { socket.off('error', onError); resolve() }
      /** @brief 处理连接失败。详细说明：移除临时连接监听并返回网络错误。 */
      const onError = (error: Error): void => { socket.off('connect', onConnect); reject(error) }
      socket.once('connect', onConnect)
      socket.once('error', onError)
      socket.connect(config.port, config.host)
    })
    this.socket = socket
  }

  /**
   * @brief 断开 Modbus TCP 连接。
   *
   * 正常结束当前套接字并释放引用，未连接时直接返回。
   */
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
   * @brief 读取 TCP 保持寄存器或输入寄存器。
   *
   * 构造带事务标识的请求，等待完整 MBAP 响应并解析寄存器值。
   * @param params 读取参数。
   * @returns TCP 事务结果。
   */
  public async readRegisters(params: ReadRegistersParams): Promise<TransactionResult> {
    const transactionId = this.nextTransactionId()
    const request = buildTcpReadFrame(transactionId, params.slaveId, params.functionCode, params.startAddress, params.quantity)
    const startedAt = performance.now()
    const response = await this.transact(request, params.timeout)
    return { tx: frameToHex(request), rx: frameToHex(response), registers: parseTcpReadResponse(response, transactionId, params.slaveId, params.functionCode), elapsedMs: Math.max(1, Math.round(performance.now() - startedAt)), crcValid: true }
  }

  /**
   * @brief 通过 TCP 写入单个保持寄存器。
   *
   * 发送 06 功能码请求并检查响应 PDU 是否与请求一致。
   * @param params 单寄存器写入参数。
   * @returns TCP 事务结果。
   */
  public async writeSingleRegister(params: WriteRegisterParams): Promise<TransactionResult> {
    const transactionId = this.nextTransactionId()
    const request = buildTcpWriteSingleFrame(transactionId, params.slaveId, params.address, params.value)
    const startedAt = performance.now()
    const response = await this.transact(request, params.timeout)
    if (!request.equals(response)) throw new Error('Modbus TCP 写响应与请求不一致')
    return { tx: frameToHex(request), rx: frameToHex(response), registers: [params.value], elapsedMs: Math.max(1, Math.round(performance.now() - startedAt)), crcValid: true }
  }

  /**
   * @brief 通过 TCP 写入多个保持寄存器。
   *
   * 发送 16 功能码请求并校验事务标识、功能码、起始地址和数量。
   * @param params 多寄存器写入参数。
   * @returns TCP 事务结果。
   */
  public async writeMultipleRegisters(params: WriteMultipleRegistersParams): Promise<TransactionResult> {
    const transactionId = this.nextTransactionId()
    const request = buildTcpWriteMultipleFrame(transactionId, params.slaveId, params.startAddress, params.values)
    const startedAt = performance.now()
    const response = await this.transact(request, params.timeout)
    if (response.readUInt16BE(0) !== transactionId || response[7] !== 0x10 || response.readUInt16BE(8) !== params.startAddress || response.readUInt16BE(10) !== params.values.length) throw new Error('Modbus TCP 写响应范围不匹配')
    return { tx: frameToHex(request), rx: frameToHex(response), registers: params.values, elapsedMs: Math.max(1, Math.round(performance.now() - startedAt)), crcValid: true }
  }

  /**
   * @brief 返回下一个 TCP 事务标识。
   *
   * 在 1 到 65535 范围内循环递增，避免使用保留的零值。
   * @returns 新事务标识。
   */
  private nextTransactionId(): number {
    const current = this.transactionId
    this.transactionId = this.transactionId >= 0xffff ? 1 : this.transactionId + 1
    return current
  }

  /**
   * @brief 发送 TCP 请求并等待完整响应。
   *
   * 按 MBAP 长度字段处理分包和粘包，达到完整帧长度后结束本次事务。
   * @param request 请求报文。
   * @param timeout 超时时间。
   * @returns 完整响应报文。
   */
  private async transact(request: Buffer, timeout: number): Promise<Buffer> {
    const socket = this.socket
    if (!socket || socket.destroyed) throw new Error('Modbus TCP 尚未连接')
    const activeSocket = socket
    return new Promise<Buffer>((resolve, reject) => {
      let response = Buffer.alloc(0)
      const timer = setTimeout(() => finish(new Error('等待 Modbus TCP 响应超时')), timeout)
      /** @brief 结束 TCP 事务。详细说明：清理监听器和定时器，并返回响应或错误。 */
      function finish(error?: Error): void { clearTimeout(timer); activeSocket.off('data', onData); activeSocket.off('error', onError); error ? reject(error) : resolve(response) }
      /** @brief 接收 TCP 数据。详细说明：累积数据并根据 MBAP 长度判断完整响应。 */
      function onData(chunk: Buffer): void { response = Buffer.concat([response, chunk]); if (response.length >= 6 && response.length >= 6 + response.readUInt16BE(4)) { response = response.subarray(0, 6 + response.readUInt16BE(4)); finish() } }
      /** @brief 处理 TCP 错误。详细说明：终止当前事务并向调用方传递错误。 */
      function onError(error: Error): void { finish(error) }
      activeSocket.on('data', onData)
      activeSocket.on('error', onError)
      activeSocket.write(request, (error) => error && finish(error))
    })
  }
}

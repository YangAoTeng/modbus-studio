import { EventEmitter } from 'node:events'
import { createServer, type Server, type Socket } from 'node:net'
import { SerialPort } from 'serialport'
import type { ServerConfig, ServerDataUpdate, ServerEvent } from '../../shared/types'
import { appendCrc, verifyCrc } from '../protocol/crc16'
import { frameToHex } from '../protocol/rtu-frame'
import { createServerDataModel, processServerPdu } from '../protocol/server-pdu'
import { buildTcpFrame } from '../protocol/tcp-frame'

export class ModbusServerService extends EventEmitter {
  private readonly data = createServerDataModel()
  private tcpServer: Server | null = null
  private readonly tcpSockets = new Set<Socket>()
  private serialPort: SerialPort | null = null
  private running = false

  /**
   * @brief 启动 Modbus RTU 或 TCP Server。
   *
   * 停止旧服务、载入界面数据后按配置启动对应监听，并广播运行状态。
   * @param config Server 配置。
   * @param initialData 初始四区数据。
   */
  public async start(config: ServerConfig, initialData: ServerDataUpdate[]): Promise<void> {
    await this.stop()
    initialData.forEach((item) => this.updateData(item))
    if (config.protocol === 'TCP') await this.startTcp(config)
    else await this.startRtu(config)
    this.running = true
    this.emitServerEvent({ type: 'status', running: true, protocol: config.protocol })
  }

  /**
   * @brief 停止当前 Modbus Server。
   *
   * 关闭 TCP 监听器和 RTU 串口，并广播停止状态。
   */
  public async stop(): Promise<void> {
    const tcpServer = this.tcpServer
    const serialPort = this.serialPort
    this.tcpServer = null
    this.serialPort = null
    this.tcpSockets.forEach((socket) => socket.destroy())
    this.tcpSockets.clear()
    if (tcpServer) await new Promise<void>((resolve) => tcpServer.close(() => resolve()))
    if (serialPort?.isOpen) await new Promise<void>((resolve) => serialPort.close(() => resolve()))
    if (this.running) this.emitServerEvent({ type: 'status', running: false })
    this.running = false
  }

  /**
   * @brief 更新 Server 数据区中的单个值。
   *
   * 将界面编辑值写入对应类型数组，地址采用 Modbus PDU 的零基地址。
   * @param update 数据区更新。
   */
  public updateData(update: ServerDataUpdate): void {
    this.data[update.area][update.address] = update.value
  }

  /** @brief 启动 TCP Server。详细说明：监听指定地址和端口，为每个连接维护独立粘包缓冲区。 */
  private async startTcp(config: ServerConfig): Promise<void> {
    const server = createServer((socket) => this.handleTcpSocket(socket, config.slaveId))
    await new Promise<void>((resolve, reject) => {
      /** @brief 处理 TCP 监听成功。详细说明：移除错误监听并完成启动。 */
      const onListening = (): void => { server.off('error', onError); resolve() }
      /** @brief 处理 TCP 监听失败。详细说明：移除监听成功事件并返回错误。 */
      const onError = (error: Error): void => { server.off('listening', onListening); reject(error) }
      server.once('listening', onListening)
      server.once('error', onError)
      server.listen(config.tcp.port, config.tcp.host)
    })
    this.tcpServer = server
  }

  /** @brief 处理 TCP 客户端连接。详细说明：根据 MBAP 长度拆分请求并逐帧生成响应。 */
  private handleTcpSocket(socket: Socket, slaveId: number): void {
    this.tcpSockets.add(socket)
    let buffer = Buffer.alloc(0)
    socket.once('close', () => this.tcpSockets.delete(socket))
    socket.on('error', () => this.tcpSockets.delete(socket))
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 6) {
        const frameLength = 6 + buffer.readUInt16BE(4)
        if (buffer.length < frameLength) break
        const request = buffer.subarray(0, frameLength)
        buffer = buffer.subarray(frameLength)
        if (request[6] !== slaveId) continue
        const responsePdu = processServerPdu(request.subarray(7), this.data, (update) => this.reportUpdate(update))
        const response = buildTcpFrame(request.readUInt16BE(0), request[6], responsePdu)
        socket.write(response)
        this.reportLog('TCP', request, response)
      }
    })
  }

  /** @brief 启动 RTU Server。详细说明：打开串口并按功能码推断请求长度，完整收帧后生成响应。 */
  private async startRtu(config: ServerConfig): Promise<void> {
    const port = new SerialPort({ path: config.serial.path, baudRate: config.serial.baudRate, dataBits: config.serial.dataBits, stopBits: config.serial.stopBits, parity: config.serial.parity, autoOpen: false })
    await new Promise<void>((resolve, reject) => port.open((error) => error ? reject(error) : resolve()))
    let buffer = Buffer.alloc(0)
    port.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 8) {
        const functionCode = buffer[1]
        const frameLength = functionCode === 15 || functionCode === 16 ? 9 + buffer[6] : 8
        if (buffer.length < frameLength) break
        const request = buffer.subarray(0, frameLength)
        buffer = buffer.subarray(frameLength)
        if (request[0] !== config.slaveId || !verifyCrc(request)) continue
        const responsePdu = processServerPdu(request.subarray(1, -2), this.data, (update) => this.reportUpdate(update))
        const response = appendCrc(Buffer.concat([Buffer.from([config.slaveId]), responsePdu]))
        port.write(response)
        this.reportLog('RTU', request, response)
      }
    })
    this.serialPort = port
  }

  /** @brief 上报数据变化。详细说明：同步外部主站写入到渲染进程 Server 表格。 */
  private reportUpdate(update: ServerDataUpdate): void {
    this.emitServerEvent({ type: 'data', update })
  }

  /** @brief 上报 Server 报文日志。详细说明：生成 RX 请求和 TX 响应两条日志供界面统计与查看。 */
  private reportLog(protocol: 'RTU' | 'TCP', request: Buffer, response: Buffer): void {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    this.emitServerEvent({ type: 'log', log: { time, direction: 'RX', protocol, raw: frameToHex(request), parsed: `Server 收到功能码 ${request[protocol === 'RTU' ? 1 : 7].toString(16).padStart(2, '0').toUpperCase()}`, elapsedMs: 0, status: '成功' } })
    this.emitServerEvent({ type: 'log', log: { time, direction: 'TX', protocol, raw: frameToHex(response), parsed: 'Server 已响应', elapsedMs: 0, status: '发送' } })
  }

  /** @brief 广播 Server 事件。详细说明：通过 EventEmitter 将状态、数据和日志交给主进程 IPC 转发。 */
  private emitServerEvent(event: ServerEvent): void {
    this.emit('server-event', event)
  }
}

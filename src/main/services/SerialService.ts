import { SerialPort } from 'serialport'
import type { SerialConfig } from '../../shared/types'

export class SerialService {
  private port: SerialPort | null = null

  /**
   * @brief 获取当前系统可用串口列表。
   *
   * 调用 serialport 枚举接口并仅返回串口路径，供渲染进程下拉框显示。
   * @returns 串口路径数组。
   */
  public async listPorts(): Promise<string[]> {
    const ports = await SerialPort.list()
    return ports.map((item) => item.path)
  }

  /**
   * @brief 按指定参数打开串口。
   *
   * 打开前会关闭旧连接，保证同一时刻只维护一个串口实例。
   * @param config 串口通信参数。
   */
  public async open(config: SerialConfig): Promise<void> {
    await this.close()
    this.port = new SerialPort({
      path: config.path,
      baudRate: config.baudRate,
      dataBits: config.dataBits,
      stopBits: config.stopBits,
      parity: config.parity,
      autoOpen: false
    })
    await new Promise<void>((resolve, reject) => this.port?.open((error) => error ? reject(error) : resolve()))
  }

  /**
   * @brief 关闭当前串口连接。
   *
   * 在串口已打开时等待关闭完成，未打开时直接释放实例引用。
   */
  public async close(): Promise<void> {
    const current = this.port
    this.port = null
    if (!current?.isOpen) return
    await new Promise<void>((resolve, reject) => current.close((error) => error ? reject(error) : resolve()))
  }

  /**
   * @brief 发送请求并等待一帧 Modbus RTU 响应。
   *
   * 写入报文后按功能码推断响应长度，接收完整帧即返回，超时或串口错误则拒绝。
   * @param request 待发送 RTU 报文。
   * @param timeout 超时时间，单位毫秒。
   * @returns 完整响应报文。
   */
  public async transact(request: Buffer, timeout: number): Promise<Buffer> {
    if (!this.port?.isOpen) throw new Error('串口尚未连接')
    const port = this.port
    return new Promise<Buffer>((resolve, reject) => {
      let response = Buffer.alloc(0)
      let expectedLength = 0
      const timer = setTimeout(() => finish(new Error('等待 Modbus 响应超时')), timeout)

      /**
       * @brief 清理本次事务监听器并结束等待。
       *
       * 统一移除数据和错误监听器，避免连续轮询时产生监听器泄漏。
       * @param error 可选错误对象。
       */
      function finish(error?: Error): void {
        clearTimeout(timer)
        port.off('data', onData)
        port.off('error', onError)
        error ? reject(error) : resolve(response)
      }

      /**
       * @brief 处理串口接收数据。
       *
       * 拼接分段数据并根据正常响应或异常响应推断整帧长度。
       * @param chunk 新接收的数据块。
       */
      function onData(chunk: Buffer): void {
        response = Buffer.concat([response, chunk])
        if (response.length >= 2 && expectedLength === 0) {
          if ((response[1] & 0x80) !== 0) expectedLength = 5
          else if (response[1] === 0x06 || response[1] === 0x10) expectedLength = 8
          else if (response.length >= 3) expectedLength = response[2] + 5
        }
        if (expectedLength > 0 && response.length >= expectedLength) {
          response = response.subarray(0, expectedLength)
          finish()
        }
      }

      /**
       * @brief 转发串口运行错误。
       * @param error 串口错误对象。
       */
      function onError(error: Error): void {
        finish(error)
      }

      port.on('data', onData)
      port.on('error', onError)
      port.write(request, (error) => {
        if (error) finish(error)
        else port.drain((drainError) => drainError && finish(drainError))
      })
    })
  }
}

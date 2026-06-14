import { createStore } from 'vuex'
import type { PacketLogItem, ProjectData, ProtocolMode, RegisterDefinition, SerialConfig, TcpConfig } from '../../shared/types'

export interface RootState {
  protocol: ProtocolMode
  connected: boolean
  connecting: boolean
  ports: string[]
  connection: SerialConfig
  tcp: TcpConfig
  server: {
    protocol: ProtocolMode
    slaveId: number
    tcpHost: string
    tcpPort: number
  }
  client: {
    slaveId: number
    functionCode: 3 | 4
    startAddress: number
    quantity: number
    pollInterval: number
    polling: boolean
    registers: number[]
    lastElapsedMs: number
  }
  logs: PacketLogItem[]
  dictionary: RegisterDefinition[]
  project: {
    path: string
    name: string
    description: string
    version: string
  }
}

let logSequence = 1

/**
 * @brief 生成默认寄存器字典。
 *
 * 提供温度控制类设备的示例点位，首次打开软件即可观察字典和工程管理页面效果。
 * @returns 默认寄存器定义数组。
 */
function createDefaultDictionary(): RegisterDefinition[] {
  return [
    { group: '温度传感器', address: 40001, name: '温度值', dataType: 'FLOAT_ABCD', length: 2, access: 'R', factor: 0.1, unit: '°C', remark: '当前温度值' },
    { group: '温度传感器', address: 40003, name: '湿度值', dataType: 'UINT16', length: 1, access: 'R', factor: 1, unit: '%', remark: '相对湿度' },
    { group: '温度传感器', address: 40004, name: '压力值', dataType: 'UINT32', length: 2, access: 'R', factor: 0.01, unit: 'kPa', remark: '压力值' },
    { group: '系统状态', address: 40006, name: '系统状态', dataType: 'UINT16', length: 1, access: 'R', factor: 1, unit: '无', remark: '系统运行状态' },
    { group: '控制参数', address: 40009, name: '设定温度', dataType: 'FLOAT_ABCD', length: 2, access: 'RW', factor: 0.1, unit: '°C', remark: '目标温度' }
  ]
}

const store = createStore<RootState>({
  state: {
    protocol: 'RTU',
    connected: false,
    connecting: false,
    ports: [],
    connection: { path: 'COM3', baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', timeout: 1000 },
    tcp: { host: '127.0.0.1', port: 502, timeout: 1000 },
    server: { protocol: 'TCP', slaveId: 1, tcpHost: '0.0.0.0', tcpPort: 502 },
    client: { slaveId: 1, functionCode: 3, startAddress: 0, quantity: 10, pollInterval: 1000, polling: false, registers: [], lastElapsedMs: 0 },
    logs: [],
    dictionary: createDefaultDictionary(),
    project: { path: '', name: '温度监控系统', description: '温度传感器轮询和配置', version: '1.1.0' }
  },
  mutations: {
    setPorts(state, ports: string[]) { state.ports = ports },
    setConnecting(state, value: boolean) { state.connecting = value },
    setConnected(state, value: boolean) { state.connected = value },
    setProtocol(state, value: ProtocolMode) { state.protocol = value },
    setPolling(state, value: boolean) { state.client.polling = value },
    setRegisters(state, payload: { values: number[]; elapsedMs: number }) {
      state.client.registers = payload.values
      state.client.lastElapsedMs = payload.elapsedMs
    },
    addLog(state, item: Omit<PacketLogItem, 'id'>) {
      state.logs.unshift({ id: logSequence++, ...item })
      if (state.logs.length > 1000) state.logs.length = 1000
    },
    clearLogs(state) { state.logs = [] },
    addDictionaryItem(state, item: RegisterDefinition) { state.dictionary.push(item) },
    removeDictionaryItem(state, index: number) { state.dictionary.splice(index, 1) },
    applyProject(state, payload: { path: string; data: ProjectData }) {
      state.project = { path: payload.path, name: payload.data.name, description: payload.data.description, version: payload.data.version }
      state.protocol = payload.data.protocol ?? 'RTU'
      Object.assign(state.connection, payload.data.connection)
      if (payload.data.tcp) Object.assign(state.tcp, payload.data.tcp)
      if (payload.data.server) Object.assign(state.server, payload.data.server)
      Object.assign(state.client, payload.data.client)
      state.dictionary = payload.data.registerDictionary
    },
    setProjectPath(state, path: string) { state.project.path = path }
  },
  actions: {
    /**
     * @brief 扫描系统串口。
     *
     * 调用主进程串口枚举接口并更新下拉列表；未检测到串口时保留当前配置值。
     */
    async refreshPorts({ commit, state }) {
      if (!window.modbusApi) {
        commit('setPorts', [state.connection.path])
        return
      }
      const ports = await window.modbusApi.serial.listPorts()
      commit('setPorts', ports.length > 0 ? ports : [state.connection.path])
    },
    /**
     * @brief 切换串口连接状态。
     *
     * 已连接时关闭串口，未连接时按当前配置打开串口，并维护连接中状态。
     */
    async toggleConnection({ commit, state }) {
      commit('setConnecting', true)
      try {
        if (state.connected) {
          if (state.protocol === 'TCP') await window.modbusApi.tcp.disconnect()
          else await window.modbusApi.serial.close()
          commit('setConnected', false)
          commit('setPolling', false)
        } else {
          if (state.protocol === 'TCP') await window.modbusApi.tcp.connect(state.tcp)
          else await window.modbusApi.serial.open(state.connection)
          commit('setConnected', true)
        }
      } finally {
        commit('setConnecting', false)
      }
    },
    /**
     * @brief 执行一次寄存器读取。
     *
     * 调用主进程完成真实 RTU 事务，并分别记录 TX、RX 日志和更新寄存器表。
     */
    async readOnce({ commit, state }) {
      const result = await window.modbusApi.client.readRegisters({
        protocol: state.protocol,
        slaveId: state.client.slaveId,
        functionCode: state.client.functionCode,
        startAddress: state.client.startAddress,
        quantity: state.client.quantity,
        timeout: state.protocol === 'TCP' ? state.tcp.timeout : state.connection.timeout
      })
      const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
      commit('addLog', { time, direction: 'TX', protocol: state.protocol, raw: result.tx, parsed: `读取功能码 ${state.client.functionCode.toString().padStart(2, '0')}，起始地址 ${state.client.startAddress}，数量 ${state.client.quantity}`, elapsedMs: 0, status: '发送' })
      commit('addLog', { time, direction: 'RX', protocol: state.protocol, raw: result.rx, parsed: `收到 ${result.registers.length} 个寄存器${state.protocol === 'RTU' ? `，CRC ${result.crcValid ? '正确' : '错误'}` : ''}`, elapsedMs: result.elapsedMs, status: '成功' })
      commit('setRegisters', { values: result.registers, elapsedMs: result.elapsedMs })
    },
    /**
     * @brief 写入一个或多个保持寄存器。
     *
     * 根据值数组长度选择 06 或 16 功能码，成功后记录发送和接收报文。
     * @param context Vuex 动作上下文。
     * @param payload 写入地址和值数组。
     */
    async writeRegisters({ commit, state }, payload: { address: number; values: number[] }) {
      const common = { protocol: state.protocol, slaveId: state.client.slaveId, timeout: state.protocol === 'TCP' ? state.tcp.timeout : state.connection.timeout }
      const result = payload.values.length === 1
        ? await window.modbusApi.client.writeSingleRegister({ ...common, address: payload.address, value: payload.values[0] })
        : await window.modbusApi.client.writeMultipleRegisters({ ...common, startAddress: payload.address, values: payload.values })
      const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
      const code = payload.values.length === 1 ? '06' : '16'
      commit('addLog', { time, direction: 'TX', protocol: state.protocol, raw: result.tx, parsed: `${code} 写保持寄存器，起始地址 ${payload.address}，数量 ${payload.values.length}`, elapsedMs: 0, status: '发送' })
      commit('addLog', { time, direction: 'RX', protocol: state.protocol, raw: result.rx, parsed: '写入成功', elapsedMs: result.elapsedMs, status: '成功' })
    },
    /**
     * @brief 打开工程文件并载入状态。
     *
     * 读取用户选择的 MBS 或 JSON 文件，将连接、Client 和字典配置应用到当前工程。
     */
    async openProject({ commit }) {
      const result = await window.modbusApi.project.open()
      if (result) commit('applyProject', result)
    },
    /**
     * @brief 保存当前工程状态。
     *
     * 将连接配置、轮询参数和寄存器字典序列化为 MBS 文件，首次保存时弹出路径选择框。
     */
    async saveProject({ commit, state }) {
      const data: ProjectData = {
        name: state.project.name,
        description: state.project.description,
        version: state.project.version,
        connection: { ...state.connection },
        protocol: state.protocol,
        tcp: { ...state.tcp },
        server: { ...state.server },
        client: { slaveId: state.client.slaveId, functionCode: state.client.functionCode, startAddress: state.client.startAddress, quantity: state.client.quantity, timeout: state.connection.timeout, pollInterval: state.client.pollInterval },
        registerDictionary: state.dictionary
      }
      const path = await window.modbusApi.project.save(data, state.project.path || undefined)
      if (path) commit('setProjectPath', path)
    }
  }
})

export default store

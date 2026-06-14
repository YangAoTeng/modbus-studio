import { createStore } from 'vuex'
import type { PacketLogItem, ProjectData, ProtocolMode, RecentProject, RegisterDefinition, SerialConfig, TcpConfig } from '../../shared/types'

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
    dictionaryRegisters: Record<string, number[]>
    requestCount: number
  }
  client: {
    slaveId: number
    functionCode: 3 | 4
    startAddress: number
    quantity: number
    pollInterval: number
    polling: boolean
    registers: number[]
    dictionaryRegisters: Record<string, number[]>
    lastElapsedMs: number
  }
  logs: PacketLogItem[]
  dictionary: RegisterDefinition[]
  project: {
    path: string
    name: string
    description: string
    version: string
    dirty: boolean
  }
  recentProjects: RecentProject[]
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
    server: { protocol: 'TCP', slaveId: 1, tcpHost: '0.0.0.0', tcpPort: 502, dictionaryRegisters: {}, requestCount: 0 },
    client: { slaveId: 1, functionCode: 3, startAddress: 0, quantity: 10, pollInterval: 1000, polling: false, registers: [], dictionaryRegisters: {}, lastElapsedMs: 0 },
    logs: [],
    dictionary: createDefaultDictionary(),
    project: { path: '', name: '未命名工程', description: '', version: '1.1.0', dirty: false },
    recentProjects: []
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
    setDictionaryRegisters(state, payload: { key: string; values: number[]; elapsedMs: number }) {
      state.client.dictionaryRegisters = { ...state.client.dictionaryRegisters, [payload.key]: payload.values }
      state.client.lastElapsedMs = payload.elapsedMs
    },
    setServerDictionaryRegisters(state, payload: { key: string; values: number[] }) {
      state.server.dictionaryRegisters = { ...state.server.dictionaryRegisters, [payload.key]: payload.values }
    },
    incrementServerRequestCount(state) { state.server.requestCount += 1 },
    addLog(state, item: Omit<PacketLogItem, 'id'>) {
      state.logs.unshift({ id: logSequence++, ...item })
      if (state.logs.length > 1000) state.logs.length = 1000
    },
    clearLogs(state) { state.logs = [] },
    addDictionaryItem(state, item: RegisterDefinition) { state.dictionary.push(item); state.project.dirty = true },
    updateDictionaryItem(state, payload: { index: number; item: RegisterDefinition }) { state.dictionary.splice(payload.index, 1, payload.item); state.project.dirty = true },
    removeDictionaryItem(state, index: number) { state.dictionary.splice(index, 1); state.project.dirty = true },
    applyProject(state, payload: { path: string; data: ProjectData }) {
      state.project = { path: payload.path, name: payload.data.name, description: payload.data.description, version: payload.data.version, dirty: false }
      state.protocol = payload.data.protocol ?? 'RTU'
      Object.assign(state.connection, payload.data.connection)
      if (payload.data.tcp) Object.assign(state.tcp, payload.data.tcp)
      if (payload.data.server) Object.assign(state.server, payload.data.server)
      Object.assign(state.client, payload.data.client, {
        polling: false,
        registers: [],
        dictionaryRegisters: payload.data.clientData?.dictionaryRegisters ?? {},
        lastElapsedMs: payload.data.clientData?.lastElapsedMs ?? 0
      })
      state.server.dictionaryRegisters = payload.data.serverData?.dictionaryRegisters ?? {}
      state.server.requestCount = payload.data.serverData?.requestCount ?? 0
      state.logs = payload.data.packetLogs?.map((item) => ({ ...item })) ?? []
      logSequence = state.logs.reduce((maximum, item) => Math.max(maximum, item.id), 0) + 1
      state.dictionary = payload.data.registerDictionary
    },
    resetProject(state) {
      state.protocol = 'RTU'
      Object.assign(state.connection, { path: 'COM3', baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', timeout: 1000 })
      Object.assign(state.tcp, { host: '127.0.0.1', port: 502, timeout: 1000 })
      Object.assign(state.server, { protocol: 'TCP', slaveId: 1, tcpHost: '0.0.0.0', tcpPort: 502, dictionaryRegisters: {}, requestCount: 0 })
      Object.assign(state.client, { slaveId: 1, functionCode: 3, startAddress: 0, quantity: 10, pollInterval: 1000, polling: false, registers: [], dictionaryRegisters: {}, lastElapsedMs: 0 })
      state.logs = []
      state.dictionary = []
      state.project = { path: '', name: '未命名工程', description: '', version: '1.1.0', dirty: false }
    },
    setProjectPath(state, path: string) { state.project.path = path; state.project.dirty = false },
    setProjectDirty(state, value: boolean) { state.project.dirty = value },
    setRecentProjects(state, projects: RecentProject[]) { state.recentProjects = projects }
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
          if (state.protocol === 'TCP') {
            await window.modbusApi.tcp.connect({
              host: String(state.tcp.host),
              port: Number(state.tcp.port),
              timeout: Number(state.tcp.timeout)
            })
          } else {
            await window.modbusApi.serial.open({
              path: String(state.connection.path),
              baudRate: Number(state.connection.baudRate),
              dataBits: state.connection.dataBits,
              stopBits: state.connection.stopBits,
              parity: state.connection.parity,
              timeout: Number(state.connection.timeout)
            })
          }
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
     * @brief 按寄存器字典执行一轮读取。
     *
     * 仅读取权限为 R 或 RW 的 3xxxx、4xxxx 条目，并严格使用每个字典项指定的地址和长度。
     */
    async readDictionary({ commit, state }) {
      const readableItems = state.dictionary.filter((item) => item.access !== 'W' && ((item.address >= 30001 && item.address <= 39999) || (item.address >= 40001 && item.address <= 49999)))
      for (const item of readableItems) {
        const functionCode: 3 | 4 = item.address >= 40001 ? 3 : 4
        const baseAddress = functionCode === 3 ? 40001 : 30001
        const protocolAddress = item.address - baseAddress
        const result = await window.modbusApi.client.readRegisters({
          protocol: state.protocol,
          slaveId: state.client.slaveId,
          functionCode,
          startAddress: protocolAddress,
          quantity: item.length,
          timeout: state.protocol === 'TCP' ? state.tcp.timeout : state.connection.timeout
        })
        const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
        commit('addLog', { time, direction: 'TX', protocol: state.protocol, raw: result.tx, parsed: `字典读取 ${item.name}，地址 ${item.address}，长度 ${item.length}`, elapsedMs: 0, status: '发送' })
        commit('addLog', { time, direction: 'RX', protocol: state.protocol, raw: result.rx, parsed: `${item.name} 读取成功`, elapsedMs: result.elapsedMs, status: '成功' })
        commit('setDictionaryRegisters', { key: String(item.address), values: result.registers, elapsedMs: result.elapsedMs })
      }
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
    async openProject({ commit, dispatch }) {
      const result = await window.modbusApi.project.open()
      if (!result) return false
      commit('applyProject', result)
      await dispatch('refreshRecentProjects')
      return true
    },
    /**
     * @brief 保存当前工程状态。
     *
     * 将连接配置、轮询参数和寄存器字典序列化为 MBS 文件，首次保存时弹出路径选择框。
     */
    async saveProject({ commit, state, dispatch }, saveAs = false) {
      const data: ProjectData = {
        name: state.project.name,
        description: state.project.description,
        version: state.project.version,
        connection: { ...state.connection },
        protocol: state.protocol,
        tcp: { ...state.tcp },
        server: { protocol: state.server.protocol, slaveId: state.server.slaveId, tcpHost: state.server.tcpHost, tcpPort: state.server.tcpPort },
        client: { slaveId: state.client.slaveId, functionCode: state.client.functionCode, startAddress: state.client.startAddress, quantity: state.client.quantity, timeout: state.connection.timeout, pollInterval: state.client.pollInterval },
        registerDictionary: state.dictionary.map((item) => ({ ...item })),
        clientData: {
          dictionaryRegisters: Object.fromEntries(Object.entries(state.client.dictionaryRegisters).map(([key, values]) => [key, [...values]])),
          lastElapsedMs: state.client.lastElapsedMs
        },
        serverData: {
          dictionaryRegisters: Object.fromEntries(state.dictionary.map((item) => {
            const values = state.server.dictionaryRegisters[String(item.address)] ?? Array.from({ length: Math.max(1, item.length) }, () => 0)
            return [String(item.address), [...values]]
          })),
          requestCount: state.server.requestCount
        },
        packetLogs: state.logs.map((item) => ({ ...item }))
      }
      const serializableData = JSON.parse(JSON.stringify(data)) as ProjectData
      const path = await window.modbusApi.project.save(serializableData, state.project.path || undefined, saveAs)
      if (!path) return false
      commit('setProjectPath', path)
      await dispatch('refreshRecentProjects')
      return true
    },
    /**
     * @brief 打开最近工程。
     *
     * 直接读取最近列表中的路径并应用工程数据，同时刷新最近工程排序。
     * @param context Vuex 动作上下文。
     * @param path 工程文件路径。
     */
    async openRecentProject({ commit, dispatch }, path: string) {
      const result = await window.modbusApi.project.openPath(path)
      commit('applyProject', result)
      await dispatch('refreshRecentProjects')
    },
    /**
     * @brief 刷新最近工程列表。
     *
     * 从主进程用户数据目录读取最多十条最近工程记录。
     */
    async refreshRecentProjects({ commit }) {
      if (!window.modbusApi) return
      commit('setRecentProjects', await window.modbusApi.project.listRecent())
    },
    /**
     * @brief 移除最近工程记录。
     *
     * 仅删除最近列表记录，不删除磁盘上的工程文件。
     * @param context Vuex 动作上下文。
     * @param path 工程文件路径。
     */
    async removeRecentProject({ commit }, path: string) {
      commit('setRecentProjects', await window.modbusApi.project.removeRecent(path))
    }
  }
})

export default store

import { createStore } from 'vuex'
import type { PacketLogItem, ProjectData, ProtocolMode, RecentProject, RegisterDefinition, SerialConfig, TcpConfig } from '../../shared/types'
import { resolveRegisterAddress } from '../utils/register-data'

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
    mergeRead: boolean
    reading: boolean
    registers: number[]
    dictionaryRegisters: Record<string, number[]>
    dictionaryErrors: Record<string, string>
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

/* 全局轮询状态 —— 存放于 store 模块作用域而非组件内，确保切换页面后轮询继续运行 */
let pollTimer: ReturnType<typeof setInterval> | undefined
let pollPromise: Promise<void> | null = null
let lastPollError = ''

/**
 * @brief 生成默认寄存器字典。
 *
 * 提供温度控制类设备的示例点位，首次打开软件即可观察字典和工程管理页面效果。
 * @returns 默认寄存器定义数组。
 */
function createDefaultDictionary(): RegisterDefinition[] {
  return []
}

/**
 * @brief 合并读取分组。
 *
 * 表示一次连续地址范围 Modbus 读取所覆盖的多个字典条目及各自在响应中的偏移量。
 */
interface ReadGroup {
  functionCode: 1 | 2 | 3 | 4
  startAddress: number
  quantity: number
  items: { item: RegisterDefinition; offset: number }[]
}

/** @brief 地址范围 → 功能码映射表。 */
const ADDRESS_FC_MAP: { min: number; max: number; functionCode: 1 | 2 | 3 | 4; baseAddress: number }[] = [
  { min: 1, max: 9999, functionCode: 1, baseAddress: 1 },
  { min: 10001, max: 19999, functionCode: 2, baseAddress: 10001 },
  { min: 30001, max: 39999, functionCode: 4, baseAddress: 30001 },
  { min: 40001, max: 49999, functionCode: 3, baseAddress: 40001 }
]

/**
 * @brief 获取地址对应的功能码和协议地址。
 */
function getAddressInfo(address: number): { functionCode: 1 | 2 | 3 | 4; protocolAddress: number } | null {
  for (const entry of ADDRESS_FC_MAP) {
    if (address >= entry.min && address <= entry.max) return { functionCode: entry.functionCode, protocolAddress: address - entry.baseAddress }
  }
  return null
}

/**
 * @brief 将可读字典条目按连续地址分组（支持全部四区）。
 */
function groupConsecutiveItems(items: RegisterDefinition[]): ReadGroup[] {
  if (items.length === 0) return []
  const sorted = [...items].sort((a, b) => a.address - b.address)
  const groups: ReadGroup[] = []
  let current: ReadGroup | null = null
  for (const item of sorted) {
    const info = getAddressInfo(item.address)
    if (!info) continue
    if (current && current.functionCode === info.functionCode && current.startAddress + current.quantity === info.protocolAddress) {
      const offset = current.quantity
      current.quantity += item.length
      current.items.push({ item, offset })
    } else {
      current = { functionCode: info.functionCode, startAddress: info.protocolAddress, quantity: item.length, items: [{ item, offset: 0 }] }
      groups.push(current)
    }
  }
  return groups
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
    client: { slaveId: 1, functionCode: 3, startAddress: 0, quantity: 10, pollInterval: 1000, polling: false, mergeRead: false, reading: false, registers: [], dictionaryRegisters: {}, dictionaryErrors: {}, lastElapsedMs: 0 },
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
    setMergeRead(state, value: boolean) { state.client.mergeRead = value },
    setReading(state, value: boolean) { state.client.reading = value },
    setRegisters(state, payload: { values: number[]; elapsedMs: number }) {
      state.client.registers = payload.values
      state.client.lastElapsedMs = payload.elapsedMs
    },
    setDictionaryRegisters(state, payload: { key: string; values: number[]; elapsedMs: number }) {
      state.client.dictionaryRegisters = { ...state.client.dictionaryRegisters, [payload.key]: payload.values }
      state.client.lastElapsedMs = payload.elapsedMs
    },
    setDictionaryError(state, payload: { key: string; error: string }) {
      if (payload.error) {
        state.client.dictionaryErrors = { ...state.client.dictionaryErrors, [payload.key]: payload.error }
      } else {
        const next = { ...state.client.dictionaryErrors }
        delete next[payload.key]
        state.client.dictionaryErrors = next
      }
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
      Object.assign(state.client, { slaveId: 1, functionCode: 3, startAddress: 0, quantity: 10, pollInterval: 1000, polling: false, mergeRead: false, reading: false, registers: [], dictionaryRegisters: {}, dictionaryErrors: {}, lastElapsedMs: 0 })
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
    async toggleConnection({ commit, state, dispatch }) {
      commit('setConnecting', true)
      try {
        if (state.connected) {
          await dispatch('stopPolling')
          if (state.protocol === 'TCP') await window.modbusApi.tcp.disconnect()
          else await window.modbusApi.serial.close()
          commit('setConnected', false)
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
          await dispatch('startPolling')
        }
      } finally {
        commit('setConnecting', false)
      }
    },
    /**
     * @brief 执行一轮字典轮询（内部实现）。
     *
     * 防重入包装 readDictionary，失败时去重报错，维护 reading 状态与 pollPromise 引用。
     */
    async runPollCycle({ commit, state, dispatch }) {
      if (!state.connected || state.client.reading) return
      commit('setReading', true)
      pollPromise = (async () => {
        try {
          await dispatch('readDictionary')
          lastPollError = ''
        } catch (error) {
          const message = (error as Error).message
          const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
          commit('addLog', { time, direction: 'RX', protocol: state.protocol, raw: '-', parsed: `轮询异常：${message}`, elapsedMs: 0, status: '失败' })
          if (message !== lastPollError) {
            const { ElMessage } = await import('element-plus')
            ElMessage.error(`字典轮询失败：${message}`)
          }
          lastPollError = message
        } finally {
          commit('setReading', false)
          pollPromise = null
        }
      })()
      await pollPromise
    },

    /**
     * @brief 启动字典循环读取。
     *
     * 清除已有定时器后立即执行一轮读取，再按 pollInterval 周期调度。
     * 连接建立后由 toggleConnection 自动调用；pollInterval 变更时由 setPollInterval 重启。
     */
    async startPolling({ commit, state, dispatch }) {
      await dispatch('stopPolling')
      commit('setPolling', true)
      await dispatch('runPollCycle')
      if (state.client.pollInterval > 0) {
        pollTimer = setInterval(() => { void dispatch('runPollCycle') }, state.client.pollInterval)
      }
    },

    /**
     * @brief 停止字典循环读取。
     *
     * 清除定时器并标记轮询结束；断开连接或更改轮询参数时调用。
     */
    async stopPolling({ commit }) {
      if (pollTimer !== undefined) { clearInterval(pollTimer); pollTimer = undefined }
      commit('setPolling', false)
      commit('setReading', false)
    },

    /**
     * @brief 等待当前轮询完成。
     *
     * 供 commitCell 等写入操作在暂停轮询后等待进行中的读取事务结束。
     */
    async waitForPollComplete() {
      if (pollPromise) {
        try { await pollPromise } catch { /* 错误已由 runPollCycle 处理 */ }
      }
    },

    /**
     * @brief 更新轮询间隔并在连接状态时重启轮询。
     * @param context Vuex 动作上下文。
     * @param intervalMs 新轮询间隔（毫秒）。
     */
    async setPollInterval({ commit, state, dispatch }, intervalMs: number) {
      state.client.pollInterval = intervalMs
      if (state.connected) await dispatch('startPolling')
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
     * @brief 按寄存器字典执行一轮读取（全部四区）。
     *
     * 自动根据地址范围选择 FC01～04，线圈和离散输入返回 0/1 位值。
     */
    async readDictionary({ commit, state }) {
      const readableItems = state.dictionary.filter((item) => {
        if (item.access === 'W') return false
        return getAddressInfo(item.address) !== null
      })
      if (readableItems.length === 0) return
      const timeout = state.protocol === 'TCP' ? state.tcp.timeout : state.connection.timeout

      if (state.client.mergeRead) {
        const groups = groupConsecutiveItems(readableItems)
        for (const group of groups) {
          const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
          const fc = group.functionCode.toString().padStart(2, '0')
          const label = group.functionCode <= 2 ? '位' : '寄存器'
          try {
            const result = await window.modbusApi.client.readRegisters({
              protocol: state.protocol,
              slaveId: state.client.slaveId,
              functionCode: group.functionCode,
              startAddress: group.startAddress,
              quantity: group.quantity,
              timeout
            })
            commit('addLog', { time, direction: 'TX', protocol: state.protocol, raw: result.tx, parsed: `合并读取 FC${fc}，起始地址 ${group.startAddress}，数量 ${group.quantity}（${group.items.length} 个字典项）`, elapsedMs: 0, status: '发送' })
            commit('addLog', { time, direction: 'RX', protocol: state.protocol, raw: result.rx, parsed: `合并读取成功，收到 ${result.registers.length} 个${label}`, elapsedMs: result.elapsedMs, status: '成功' })
            for (const { item, offset } of group.items) {
              commit('setDictionaryRegisters', { key: String(item.address), values: result.registers.slice(offset, offset + item.length), elapsedMs: result.elapsedMs })
              commit('setDictionaryError', { key: String(item.address), error: '' })
            }
          } catch (error) {
            const message = (error as Error).message
            commit('addLog', { time, direction: 'RX', protocol: state.protocol, raw: '-', parsed: `合并读取失败：${message}`, elapsedMs: 0, status: '失败' })
            for (const { item } of group.items) commit('setDictionaryError', { key: String(item.address), error: message })
          }
        }
      } else {
        for (const item of readableItems) {
          const info = getAddressInfo(item.address)
          if (!info) continue
          const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
          try {
            const result = await window.modbusApi.client.readRegisters({
              protocol: state.protocol,
              slaveId: state.client.slaveId,
              functionCode: info.functionCode,
              startAddress: info.protocolAddress,
              quantity: item.length,
              timeout
            })
            commit('addLog', { time, direction: 'TX', protocol: state.protocol, raw: result.tx, parsed: `字典读取 ${item.name}，地址 ${item.address}，长度 ${item.length}`, elapsedMs: 0, status: '发送' })
            commit('addLog', { time, direction: 'RX', protocol: state.protocol, raw: result.rx, parsed: `${item.name} 读取成功`, elapsedMs: result.elapsedMs, status: '成功' })
            commit('setDictionaryRegisters', { key: String(item.address), values: result.registers, elapsedMs: result.elapsedMs })
            commit('setDictionaryError', { key: String(item.address), error: '' })
          } catch (error) {
            const message = (error as Error).message
            commit('addLog', { time, direction: 'RX', protocol: state.protocol, raw: '-', parsed: `${item.name} 读取失败：${message}`, elapsedMs: 0, status: '失败' })
            commit('setDictionaryError', { key: String(item.address), error: message })
          }
        }
      }
    },
    /**
     * @brief 写入一个或多个保持寄存器。
     *
     * 根据值数组长度选择 06 或 16 功能码，成功后记录发送和接收报文。
     * @param context Vuex 动作上下文。
     * @param payload 写入地址和值数组。
     */
    async writeRegisters({ commit, state }, payload: { address: number; values: number[]; isCoil?: boolean }) {
      const common = { protocol: state.protocol, slaveId: state.client.slaveId, timeout: state.protocol === 'TCP' ? state.tcp.timeout : state.connection.timeout }
      const isCoil = payload.isCoil ?? false
      const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
      const code = payload.values.length === 1 ? (isCoil ? '05' : '06') : (isCoil ? '0F' : '10')
      const target = isCoil ? '线圈' : '保持寄存器'
      try {
        const result = payload.values.length === 1
          ? await window.modbusApi.client.writeSingleRegister({ ...common, functionCode: isCoil ? 5 : 6, address: payload.address, value: payload.values[0] })
          : await window.modbusApi.client.writeMultipleRegisters({ ...common, functionCode: isCoil ? 15 : 16, startAddress: payload.address, values: payload.values })
        commit('addLog', { time, direction: 'TX', protocol: state.protocol, raw: result.tx, parsed: `FC${code} 写${target}，起始地址 ${payload.address}，数量 ${payload.values.length}`, elapsedMs: 0, status: '发送' })
        commit('addLog', { time, direction: 'RX', protocol: state.protocol, raw: result.rx, parsed: '写入成功', elapsedMs: result.elapsedMs, status: '成功' })
      } catch (error) {
        commit('addLog', { time, direction: 'TX', protocol: state.protocol, raw: '-', parsed: `FC${code} 写${target}失败：${(error as Error).message}`, elapsedMs: 0, status: '失败' })
        throw error
      }
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
        client: { slaveId: state.client.slaveId, functionCode: state.client.functionCode, startAddress: state.client.startAddress, quantity: state.client.quantity, timeout: state.connection.timeout, pollInterval: state.client.pollInterval, mergeRead: state.client.mergeRead },
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

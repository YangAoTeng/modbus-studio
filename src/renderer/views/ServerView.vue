<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useStore } from 'vuex'
import { ElMessage } from 'element-plus'
import type { RootState } from '../store'
import type { RegisterDefinition, ServerAreaName, ServerDataUpdate, ServerEvent } from '../../shared/types'
import { decodeRegisterValue, encodeRegisterValue, formatRegisterHex, resolveRegisterAddress } from '../utils/register-data'

type EditableField = 'hex' | 'parsed'

const store = useStore<RootState>()
const activeArea = ref<ServerAreaName>('holding')
const running = ref(false)
const editValues = reactive<Record<string, string>>({})
let removeServerListener: (() => void) | undefined

const activeRows = computed(() => store.state.dictionary.flatMap((item) => {
  const addressInfo = resolveRegisterAddress(item.address)
  if (!addressInfo || addressInfo.area !== activeArea.value) return []
  const values = getServerValues(item)
  return [{ item, addressInfo, values, hex: formatRegisterHex(values), parsed: decodeRegisterValue(item, values) }]
}))
const isBitArea = computed(() => activeArea.value === 'coil' || activeArea.value === 'discrete')
const serverPointCount = computed(() => store.state.dictionary.filter((item) => resolveRegisterAddress(item.address)).reduce((total, item) => total + Math.max(1, item.length), 0))

/**
 * @brief 获取 Server 字典项当前原始值。
 *
 * 优先返回工程中保存的值，首次使用时按照字典长度生成零值数组。
 * @param item 字典条目。
 * @returns 与字典长度一致的寄存器或位数组。
 */
function getServerValues(item: RegisterDefinition): number[] {
  const stored = store.state.server.dictionaryRegisters[String(item.address)]
  if (stored) return Array.from({ length: Math.max(1, item.length) }, (_, index) => stored[index] ?? 0)
  return Array.from({ length: Math.max(1, item.length) }, () => 0)
}

/**
 * @brief 启动或停止真实 Modbus Server。
 *
 * 启动时只提交寄存器字典中存在的地址和值，停止时关闭主进程监听服务。
 */
async function toggleServer(): Promise<void> {
  try {
    if (running.value) {
      await window.modbusApi.server.stop()
      running.value = false
      return
    }
    if (!window.modbusApi) throw new Error('请在 Electron 桌面程序中启动 Server')
    await window.modbusApi.server.start({
      protocol: store.state.server.protocol,
      slaveId: store.state.server.slaveId,
      serial: { ...store.state.connection },
      tcp: { host: store.state.server.tcpHost, port: store.state.server.tcpPort }
    }, collectServerData())
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

/**
 * @brief 收集字典定义的 Server 初始数据。
 *
 * 将每个字典项按长度展开为主进程可识别的数据区和零基地址更新数组。
 * @returns Server 初始数据更新数组。
 */
function collectServerData(): ServerDataUpdate[] {
  return store.state.dictionary.flatMap((item) => {
    const addressInfo = resolveRegisterAddress(item.address)
    if (!addressInfo) return []
    return getServerValues(item).map((value, index) => ({ area: addressInfo.area, address: addressInfo.protocolAddress + index, value }))
  })
}

/**
 * @brief 获取 Server 单元格当前显示文本。
 * @param row Server 表格行。
 * @param field 编辑字段。
 * @returns 编辑缓存或当前 Server 值。
 */
function getCellValue(row: typeof activeRows.value[number], field: EditableField): string {
  return editValues[`${row.item.address}:${field}`] ?? row[field]
}

/**
 * @brief 更新 Server 单元格编辑缓存。
 * @param item 字典条目。
 * @param field 编辑字段。
 * @param value 输入文本。
 */
function updateCellValue(item: RegisterDefinition, field: EditableField, value: string): void {
  editValues[`${item.address}:${field}`] = value
}

/**
 * @brief 将 Server 十六进制文本编码为原始值。
 * @param item 字典条目。
 * @param text 十六进制输入文本。
 * @returns 与字典长度一致的原始值数组。
 */
function encodeHex(item: RegisterDefinition, text: string): number[] {
  const compact = text.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '')
  if (!compact || compact.length % 4 !== 0) throw new Error('HEX 值应按每个寄存器四位十六进制输入')
  const values = compact.match(/.{4}/g)?.map((value) => Number.parseInt(value, 16)) ?? []
  if (values.length !== Math.max(1, item.length)) throw new Error(`需要输入 ${Math.max(1, item.length)} 个原始值`)
  return values
}

/**
 * @brief 提交 Server 字典项编辑值。
 *
 * 保存到 Vuex 工程状态，并在服务运行时逐地址同步到主进程数据区。
 * @param item 字典条目。
 * @param field 编辑字段。
 */
async function commitCell(item: RegisterDefinition, field: EditableField): Promise<void> {
  const key = `${item.address}:${field}`
  if (!(key in editValues)) return
  try {
    const addressInfo = resolveRegisterAddress(item.address)
    if (!addressInfo) throw new Error('字典地址不属于有效 Modbus 数据区')
    const values = field === 'hex' ? encodeHex(item, editValues[key]) : encodeRegisterValue(item, editValues[key])
    if (values.length !== Math.max(1, item.length)) throw new Error(`数据类型需要 ${values.length} 个值，但字典长度配置为 ${item.length}`)
    store.commit('setServerDictionaryRegisters', { key: String(item.address), values })
    if (running.value) {
      await Promise.all(values.map((value, index) => window.modbusApi.server.updateData({ area: addressInfo.area, address: addressInfo.protocolAddress + index, value })))
    }
    delete editValues[key]
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

/**
 * @brief 更新位数据区的开关值。
 * @param item 字典条目。
 * @param value 开关值。
 */
async function updateBitValue(item: RegisterDefinition, value: string | number | boolean): Promise<void> {
  const addressInfo = resolveRegisterAddress(item.address)
  if (!addressInfo) return
  const values = [value ? 1 : 0]
  store.commit('setServerDictionaryRegisters', { key: String(item.address), values })
  if (running.value) await window.modbusApi.server.updateData({ area: addressInfo.area, address: addressInfo.protocolAddress, value: values[0] })
}

/**
 * @brief 处理主进程 Server 事件。
 *
 * 将外部主站写入映射回覆盖该地址的字典项，同时记录日志和累计请求计数。
 * @param event Server 状态、数据或日志事件。
 */
function handleServerEvent(event: ServerEvent): void {
  if (event.type === 'status') running.value = Boolean(event.running)
  if (event.type === 'data' && event.update) {
    const update = event.update
    const item = store.state.dictionary.find((candidate) => {
      const info = resolveRegisterAddress(candidate.address)
      return info?.area === update.area && update.address >= info.protocolAddress && update.address < info.protocolAddress + Math.max(1, candidate.length)
    })
    if (item) {
      const info = resolveRegisterAddress(item.address)!
      const values = getServerValues(item)
      values[update.address - info.protocolAddress] = update.value
      store.commit('setServerDictionaryRegisters', { key: String(item.address), values })
    }
  }
  if (event.type === 'log' && event.log) {
    store.commit('addLog', event.log)
    if (event.log.direction === 'RX') store.commit('incrementServerRequestCount')
  }
}

onMounted(() => {
  if (window.modbusApi) removeServerListener = window.modbusApi.server.onEvent(handleServerEvent)
})
onBeforeUnmount(() => removeServerListener?.())
</script>

<template>
  <div class="workspace server-workspace">
    <aside class="side-column">
      <section class="panel connection-panel">
        <h3>Server 配置</h3>
        <label>从机地址</label><el-input-number v-model="store.state.server.slaveId" :min="1" :max="247" :disabled="running" />
        <label>协议类型</label><el-select v-model="store.state.server.protocol" :disabled="running"><el-option label="Modbus RTU" value="RTU" /><el-option label="Modbus TCP" value="TCP" /></el-select>
        <template v-if="store.state.server.protocol === 'RTU'">
          <label>端口</label><el-select v-model="store.state.connection.path" :disabled="running"><el-option v-for="port in store.state.ports" :key="port" :label="port" :value="port" /></el-select>
          <label>波特率</label><el-select v-model="store.state.connection.baudRate" :disabled="running"><el-option v-for="value in [9600, 19200, 38400, 57600, 115200]" :key="value" :label="value" :value="value" /></el-select>
        </template>
        <template v-else>
          <label>监听地址</label><el-input v-model="store.state.server.tcpHost" :disabled="running" />
          <label>监听端口</label><el-input-number v-model="store.state.server.tcpPort" :min="1" :max="65535" :disabled="running" controls-position="right" />
        </template>
        <el-button class="connect-button" :type="running ? 'danger' : 'success'" @click="toggleServer">{{ running ? '停止服务' : '启动服务' }}</el-button>
      </section>
      <section class="panel server-state">
        <h3>服务状态</h3><p><i :class="{ online: running }" />{{ running ? `${store.state.server.protocol} 服务运行中` : '未运行' }}</p>
        <div class="server-stat"><span>请求计数</span><strong>{{ store.state.server.requestCount }}</strong></div>
        <div class="server-stat"><span>字典数据点</span><strong>{{ serverPointCount }}</strong></div>
      </section>
    </aside>
    <section class="content-column">
      <section class="panel register-panel full-height">
        <el-tabs v-model="activeArea">
          <el-tab-pane label="线圈 (0xxxx)" name="coil" /><el-tab-pane label="离散输入 (1xxxx)" name="discrete" /><el-tab-pane label="输入寄存器 (3xxxx)" name="input" /><el-tab-pane label="保持寄存器 (4xxxx)" name="holding" />
        </el-tabs>
        <el-table :data="activeRows" height="calc(100% - 55px)" stripe empty-text="寄存器字典中没有该数据区的地址">
          <el-table-column label="地址" width="100"><template #default="scope">{{ scope.row.item.address }}</template></el-table-column>
          <el-table-column label="名称" min-width="150"><template #default="scope"><strong>{{ scope.row.item.name }}</strong><small class="cell-meta">{{ scope.row.item.dataType }} / 长度 {{ scope.row.item.length }}</small></template></el-table-column>
          <el-table-column v-if="isBitArea" label="当前状态" min-width="150"><template #default="scope"><el-switch :model-value="Boolean(scope.row.values[0])" @change="updateBitValue(scope.row.item, $event)" /></template></el-table-column>
          <el-table-column v-if="!isBitArea" label="原始值 HEX" min-width="190"><template #default="scope"><el-input :model-value="getCellValue(scope.row, 'hex')" size="small" @update:model-value="updateCellValue(scope.row.item, 'hex', $event)" @change="commitCell(scope.row.item, 'hex')" /></template></el-table-column>
          <el-table-column v-if="!isBitArea" label="解析值" min-width="170"><template #default="scope"><el-input :model-value="getCellValue(scope.row, 'parsed')" size="small" @update:model-value="updateCellValue(scope.row.item, 'parsed', $event)" @change="commitCell(scope.row.item, 'parsed')" /></template></el-table-column>
          <el-table-column label="倍率/单位" min-width="125"><template #default="scope">×{{ scope.row.item.factor }} {{ scope.row.item.unit }}</template></el-table-column>
          <el-table-column label="权限" width="80"><template #default="scope"><el-tag :type="scope.row.item.access === 'R' ? 'info' : 'success'">{{ scope.row.item.access }}</el-tag></template></el-table-column>
          <el-table-column label="备注" min-width="180"><template #default="scope">{{ scope.row.item.remark }}</template></el-table-column>
        </el-table>
      </section>
    </section>
  </div>
</template>

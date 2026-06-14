<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useStore } from 'vuex'
import { ElMessage } from 'element-plus'
import type { RootState } from '../store'
import type { RegisterDefinition } from '../../shared/types'
import { decodeRegisterValue, encodeRegisterValue, formatRegisterHex } from '../utils/register-data'
import ConnectionPanel from '../components/ConnectionPanel.vue'

type EditableField = 'hex' | 'parsed'

const store = useStore<RootState>()
const reading = ref(false)
const lastError = ref('')
const editValues = reactive<Record<string, string>>({})
let pollTimer: number | undefined

const readableCount = computed(() => store.state.dictionary.filter((item) => item.access !== 'W' && isRegisterAddress(item.address)).length)
const writableCount = computed(() => store.state.dictionary.filter((item) => item.access !== 'R' && isHoldingAddress(item.address)).length)
const rows = computed(() => store.state.dictionary.map((item) => {
  const values = store.state.client.dictionaryRegisters[String(item.address)] ?? []
  return { item, values, hex: formatRegisterHex(values), parsed: decodeRegisterValue(item, values) }
}))

/**
 * @brief 判断地址是否属于输入或保持寄存器区。
 *
 * Client 字典轮询当前使用 03、04 功能码，因此只读取 3xxxx 和 4xxxx 地址。
 * @param address 字典显示地址。
 * @returns 属于支持的数据区时返回 true。
 */
function isRegisterAddress(address: number): boolean {
  return (address >= 30001 && address <= 39999) || isHoldingAddress(address)
}

/**
 * @brief 判断地址是否属于保持寄存器区。
 * @param address 字典显示地址。
 * @returns 属于 4xxxx 区时返回 true。
 */
function isHoldingAddress(address: number): boolean {
  return address >= 40001 && address <= 49999
}

/**
 * @brief 执行一轮字典读取。
 *
 * 防止并发重入后调用 Vuex 字典读取动作，读取失败时保留循环并避免重复弹出相同错误。
 */
async function pollDictionary(): Promise<void> {
  if (!store.state.connected || reading.value) return
  reading.value = true
  try {
    await store.dispatch('readDictionary')
    lastError.value = ''
  } catch (error) {
    const message = (error as Error).message
    if (message !== lastError.value) ElMessage.error(`字典轮询失败：${message}`)
    lastError.value = message
  } finally {
    reading.value = false
  }
}

/**
 * @brief 启动默认字典循环读取。
 *
 * 连接成功后立即执行一轮读取，并按照配置周期持续读取字典中的可读条目。
 */
function startPolling(): void {
  stopPolling()
  store.commit('setPolling', true)
  void pollDictionary()
  pollTimer = window.setInterval(pollDictionary, store.state.client.pollInterval)
}

/**
 * @brief 停止字典循环读取。
 *
 * 断开连接或离开页面时清理定时器和轮询状态。
 */
function stopPolling(): void {
  if (pollTimer !== undefined) window.clearInterval(pollTimer)
  pollTimer = undefined
  store.commit('setPolling', false)
}

/**
 * @brief 获取单元格当前显示文本。
 * @param row 当前表格行。
 * @param field 编辑字段。
 * @returns 编辑缓存或最近一次读取值。
 */
function getCellValue(row: typeof rows.value[number], field: EditableField): string {
  return editValues[`${row.item.address}:${field}`] ?? row[field]
}

/**
 * @brief 更新单元格编辑缓存。
 * @param item 字典条目。
 * @param field 编辑字段。
 * @param value 输入文本。
 */
function updateCellValue(item: RegisterDefinition, field: EditableField, value: string): void {
  editValues[`${item.address}:${field}`] = value
}

/**
 * @brief 将十六进制文本编码为寄存器数组。
 *
 * 严格按照字典长度校验，每个 16 位寄存器要求四位十六进制字符。
 * @param item 字典条目。
 * @param text 十六进制输入文本。
 * @returns 待写入寄存器数组。
 */
function encodeHex(item: RegisterDefinition, text: string): number[] {
  const compact = text.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '')
  if (!compact || compact.length % 4 !== 0) throw new Error('HEX 值应按每个寄存器四位十六进制输入')
  const values = compact.match(/.{4}/g)?.map((value) => Number.parseInt(value, 16)) ?? []
  if (values.length !== item.length) throw new Error(`该字典项长度为 ${item.length}，需要输入 ${item.length} 个寄存器值`)
  return values
}

/**
 * @brief 提交可写字典项并立即写入设备。
 *
 * 原始值按 HEX 编码，解析值按数据类型和比例因子反向编码，成功后刷新本地快照。
 * @param item 字典条目。
 * @param field 编辑字段。
 */
async function commitCell(item: RegisterDefinition, field: EditableField): Promise<void> {
  const key = `${item.address}:${field}`
  if (!(key in editValues)) return
  if (!store.state.connected) { ElMessage.warning('请先连接设备'); return }
  if (!isEditable(item)) { ElMessage.warning('该字典项不可写'); delete editValues[key]; return }
  if (reading.value) { ElMessage.warning('当前轮询尚未结束，请稍后再修改'); return }
  try {
    const values = field === 'hex' ? encodeHex(item, editValues[key]) : encodeRegisterValue(item, editValues[key])
    if (values.length !== item.length) throw new Error(`数据类型需要 ${values.length} 个寄存器，但字典长度配置为 ${item.length}`)
    await store.dispatch('writeRegisters', { address: item.address - 40001, values })
    store.commit('setDictionaryRegisters', { key: String(item.address), values, elapsedMs: store.state.client.lastElapsedMs })
    delete editValues[key]
    ElMessage.success(`${item.name} 已写入`)
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

/**
 * @brief 判断字典条目是否允许 Client 写入。
 * @param item 字典条目。
 * @returns W/RW 保持寄存器返回 true。
 */
function isEditable(item: RegisterDefinition): boolean {
  return item.access !== 'R' && isHoldingAddress(item.address)
}

watch(() => store.state.connected, (connected) => connected ? startPolling() : stopPolling(), { immediate: true })
watch(() => store.state.client.pollInterval, () => { if (store.state.connected) startPolling() })
onBeforeUnmount(stopPolling)
</script>

<template>
  <div class="workspace client-workspace">
    <ConnectionPanel />
    <section class="content-column">
      <section class="panel dictionary-poll-toolbar">
        <div><label>从机地址</label><el-input-number v-model="store.state.client.slaveId" :min="1" :max="247" controls-position="right" /></div>
        <div><label>循环周期</label><el-input-number v-model="store.state.client.pollInterval" :min="100" :step="100" controls-position="right" /><span class="input-unit">ms</span></div>
        <div class="poll-summary"><span>字典条目<strong>{{ store.state.dictionary.length }}</strong></span><span>自动读取<strong>{{ readableCount }}</strong></span><span>可写条目<strong>{{ writableCount }}</strong></span></div>
        <div class="poll-status"><i :class="{ online: store.state.connected && store.state.client.polling }" /><span>{{ !store.state.connected ? '等待连接' : reading ? '正在读取字典' : '自动循环中' }}</span></div>
      </section>
      <section class="panel register-panel">
        <div class="panel-title"><h3>字典寄存器数据</h3><span>显示值严格按字典数据类型和比例因子解析，最近响应：{{ store.state.client.lastElapsedMs || '-' }} ms</span></div>
        <el-table :data="rows" height="100%" stripe empty-text="寄存器字典为空，请先添加字典条目">
          <el-table-column label="地址" width="90"><template #default="scope">{{ scope.row.item.address }}</template></el-table-column>
          <el-table-column label="名称" min-width="150"><template #default="scope"><strong>{{ scope.row.item.name }}</strong><small class="cell-meta">{{ scope.row.item.dataType }} / 长度 {{ scope.row.item.length }}</small></template></el-table-column>
          <el-table-column label="原始值 HEX" min-width="190"><template #default="scope"><el-input v-if="isEditable(scope.row.item)" :model-value="getCellValue(scope.row, 'hex')" size="small" @update:model-value="updateCellValue(scope.row.item, 'hex', $event)" @change="commitCell(scope.row.item, 'hex')" /><span v-else>{{ scope.row.hex }}</span></template></el-table-column>
          <el-table-column label="解析值" min-width="170"><template #default="scope"><el-input v-if="isEditable(scope.row.item)" :model-value="getCellValue(scope.row, 'parsed')" size="small" @update:model-value="updateCellValue(scope.row.item, 'parsed', $event)" @change="commitCell(scope.row.item, 'parsed')" /><strong v-else>{{ scope.row.parsed }}</strong></template></el-table-column>
          <el-table-column label="倍率/单位" min-width="130"><template #default="scope">×{{ scope.row.item.factor }} {{ scope.row.item.unit }}</template></el-table-column>
          <el-table-column label="权限" width="80"><template #default="scope"><el-tag size="small" :type="scope.row.item.access === 'R' ? 'info' : 'success'">{{ scope.row.item.access }}</el-tag></template></el-table-column>
          <el-table-column label="备注" min-width="180"><template #default="scope">{{ scope.row.item.remark }}</template></el-table-column>
        </el-table>
      </section>
      <section class="panel compact-log">
        <div class="panel-title"><h3>报文日志</h3><el-button link type="primary" @click="store.commit('clearLogs')">清空日志</el-button></div>
        <el-table :data="store.state.logs.slice(0, 5)" height="160" size="small" empty-text="暂无通信报文"><el-table-column prop="time" label="时间" width="100" /><el-table-column prop="direction" label="方向" width="70"><template #default="scope"><b :class="scope.row.direction.toLowerCase()">{{ scope.row.direction }}</b></template></el-table-column><el-table-column prop="raw" label="数据" min-width="280" show-overflow-tooltip /><el-table-column prop="parsed" label="解析结果" min-width="260" show-overflow-tooltip /><el-table-column prop="elapsedMs" label="耗时" width="75" /><el-table-column prop="status" label="状态" width="75" /></el-table>
      </section>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useStore } from 'vuex'
import { ElMessage } from 'element-plus'
import type { RootState } from '../store'
import type { ProtocolMode, ServerAreaName, ServerDataUpdate, ServerEvent } from '../../shared/types'

interface ServerRow {
  address: number
  protocolAddress: number
  value: number
  writable: boolean
  remark: string
}

const store = useStore<RootState>()
const activeArea = ref<ServerAreaName>('holding')
const running = ref(false)
const requestCount = ref(0)
let removeServerListener: (() => void) | undefined

/**
 * @brief 创建 Server 数据区的默认数据。
 *
 * 同时保存界面显示地址和 Modbus PDU 零基地址，便于协议服务与表格之间转换。
 * @param displayStart 界面显示起始地址。
 * @param writable 外部主站是否允许写入。
 * @returns Server 数据行数组。
 */
function createRows(displayStart: number, writable: boolean): ServerRow[] {
  return Array.from({ length: 100 }, (_, index) => ({ address: displayStart + index, protocolAddress: index, value: index, writable, remark: '' }))
}

const areas = ref<Record<ServerAreaName, ServerRow[]>>({
  coil: createRows(1, true),
  discrete: createRows(10001, false),
  input: createRows(30001, false),
  holding: createRows(40001, true)
})

const activeRows = computed(() => areas.value[activeArea.value])
const isBitArea = computed(() => activeArea.value === 'coil' || activeArea.value === 'discrete')

/**
 * @brief 启动或停止真实 Modbus Server。
 *
 * 启动时提交协议参数和四区初始数据，停止时关闭主进程中的监听服务。
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
 * @brief 收集四区初始数据。
 *
 * 将页面中的每行值转换为主进程 Server 使用的零基地址更新数组。
 * @returns 所有 Server 数据更新。
 */
function collectServerData(): ServerDataUpdate[] {
  return (Object.keys(areas.value) as ServerAreaName[]).flatMap((area) => areas.value[area].map((row) => ({ area, address: row.protocolAddress, value: row.value })))
}

/**
 * @brief 同步界面编辑值到主进程 Server。
 *
 * 服务运行期间立即更新对应数据区，使后续外部主站读取获得最新值。
 * @param area 数据区名称。
 * @param row 被编辑的数据行。
 */
async function syncRow(area: ServerAreaName, row: ServerRow): Promise<void> {
  if (running.value) await window.modbusApi.server.updateData({ area, address: row.protocolAddress, value: row.value })
}

/**
 * @brief 处理主进程 Server 事件。
 *
 * 同步运行状态、外部主站写入值和报文日志，并累计请求次数。
 * @param event Server 事件。
 */
function handleServerEvent(event: ServerEvent): void {
  if (event.type === 'status') running.value = Boolean(event.running)
  if (event.type === 'data' && event.update) {
    const row = areas.value[event.update.area].find((item) => item.protocolAddress === event.update?.address)
    if (row) row.value = event.update.value
  }
  if (event.type === 'log' && event.log) {
    store.commit('addLog', event.log)
    if (event.log.direction === 'RX') requestCount.value += 1
  }
}

/**
 * @brief 将寄存器值格式化为四位十六进制。
 *
 * 对数值截取低 16 位并补齐四位，便于寄存器表查看原始数据。
 * @param value 寄存器无符号值。
 * @returns 四位大写十六进制文本。
 */
function formatHex(value: number): string {
  return (value & 0xffff).toString(16).padStart(4, '0').toUpperCase()
}

/**
 * @brief 将无符号 16 位值转换为有符号值。
 *
 * 当最高位为 1 时减去 65536，得到 INT16 对应的负数表示。
 * @param value 无符号 16 位值。
 * @returns 有符号 16 位值。
 */
function toInt16(value: number): number {
  return value > 0x7fff ? value - 0x10000 : value
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
        <div class="server-stat"><span>请求计数</span><strong>{{ requestCount }}</strong></div>
        <div class="server-stat"><span>数据点数</span><strong>400</strong></div>
      </section>
    </aside>
    <section class="content-column">
      <section class="panel register-panel full-height">
        <el-tabs v-model="activeArea">
          <el-tab-pane label="线圈 (0xxxx)" name="coil" /><el-tab-pane label="离散输入 (1xxxx)" name="discrete" /><el-tab-pane label="输入寄存器 (3xxxx)" name="input" /><el-tab-pane label="保持寄存器 (4xxxx)" name="holding" />
        </el-tabs>
        <el-table :data="activeRows" height="calc(100% - 55px)" stripe>
          <el-table-column prop="address" label="地址" width="120" />
          <el-table-column v-if="isBitArea" label="当前状态" min-width="150"><template #default="scope"><el-switch v-model="scope.row.value" :active-value="1" :inactive-value="0" @change="syncRow(activeArea, scope.row)" /></template></el-table-column>
          <el-table-column v-if="isBitArea" label="布尔值" min-width="120"><template #default="scope">{{ scope.row.value ? 'ON / 1' : 'OFF / 0' }}</template></el-table-column>
          <el-table-column v-if="!isBitArea" label="当前值(HEX)" min-width="130"><template #default="scope">{{ formatHex(scope.row.value) }}</template></el-table-column>
          <el-table-column v-if="!isBitArea" label="UINT16" min-width="160"><template #default="scope"><el-input-number v-model="scope.row.value" :min="0" :max="65535" size="small" @change="syncRow(activeArea, scope.row)" /></template></el-table-column>
          <el-table-column v-if="!isBitArea" label="INT16" min-width="120"><template #default="scope">{{ toInt16(scope.row.value) }}</template></el-table-column>
          <el-table-column label="主站权限" width="110"><template #default="scope"><el-tag :type="scope.row.writable ? 'success' : 'info'">{{ scope.row.writable ? '可写' : '只读' }}</el-tag></template></el-table-column>
          <el-table-column label="备注" min-width="220"><template #default="scope"><el-input v-model="scope.row.remark" placeholder="输入备注" clearable /></template></el-table-column>
        </el-table>
      </section>
    </section>
  </div>
</template>

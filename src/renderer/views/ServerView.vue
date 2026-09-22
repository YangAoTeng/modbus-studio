<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useStore } from 'vuex'
import { ElMessage } from 'element-plus'
import type { RootState, ServerRuntimeInstance } from '../store'
import type { RegisterDefinition, ServerAreaName, ProtocolMode, Parity } from '../../shared/types'
import { decodeRegisterValue, encodeRegisterValue, formatAddressHex, formatRegisterHex, getDefaultLengthForType, parseHexAddress, resolveRegisterAddress } from '../utils/register-data'

type EditableField = 'hex' | 'parsed'

const store = useStore<RootState>()
const activeArea = ref<ServerAreaName>('holding')
const selectedId = ref<string | null>(null)
const editValues = reactive<Record<string, string>>({})
const draftVisible = ref(false)
/** @brief 编辑模式标记：非空表示正在编辑该 id 的从站，null 表示新增。 */
const editingInstanceId = ref<string | null>(null)
const draft = reactive({
  name: '',
  slaveId: 1,
  tcpHost: '0.0.0.0',
  tcpPort: 502,
  protocol: 'TCP' as ProtocolMode,
  serial: { path: 'COM3', baudRate: 9600, dataBits: 8 as 5 | 6 | 7 | 8, stopBits: 1 as 1 | 2, parity: 'none' as Parity, timeout: 1000 }
})
const baudRates = [1200, 2400, 4800, 9600, 14400, 19200, 38400, 56000, 57600, 115200, 128000, 230400, 256000, 460800, 921600]
const pointDialogVisible = ref(false)
const pointDraft = reactive<RegisterDefinition>(createEmptyPoint())
const pointEditIndex = ref(-1)
const pointAddressHex = computed({
  get: () => formatAddressHex(pointDraft.address),
  set: (val: string) => { const parsed = parseHexAddress(val); if (!Number.isNaN(parsed)) pointDraft.address = parsed }
})

function createEmptyPoint(): RegisterDefinition {
  return { group: '默认分组', address: 0x40000, name: '', dataType: 'UINT16', length: 1, access: 'RW', factor: 1, unit: '无', remark: '' }
}

const selected = computed<ServerRuntimeInstance | null>(() => {
  if (selectedId.value) return store.state.servers.find((item) => item.id === selectedId.value) ?? null
  return store.state.servers[0] ?? null
})

const activeRows = computed(() => {
  const instance = selected.value
  if (!instance) return []
  return instance.points.flatMap((item, index) => {
    const addressInfo = resolveRegisterAddress(item.address)
    if (!addressInfo || addressInfo.area !== activeArea.value) return []
    const values = getServerValues(instance, item)
    return [{ item, index, addressInfo, values, hex: formatRegisterHex(values), parsed: decodeRegisterValue(item, values) }]
  })
})
const isBitArea = computed(() => activeArea.value === 'coil' || activeArea.value === 'discrete')

/**
 * @brief 获取某从站点当前原始值。
 *
 * 优先返回已保存值，首次使用时按点长度生成零值数组。
 */
function getServerValues(instance: ServerRuntimeInstance, item: RegisterDefinition): number[] {
  const stored = instance.dictionaryRegisters[String(item.address)]
  if (stored) return Array.from({ length: Math.max(1, item.length) }, (_, index) => stored[index] ?? 0)
  return Array.from({ length: Math.max(1, item.length) }, () => 0)
}

function getCellValue(row: typeof activeRows.value[number], field: EditableField): string {
  return editValues[`${row.item.address}:${field}`] ?? row[field]
}

function updateCellValue(item: RegisterDefinition, field: EditableField, value: string): void {
  editValues[`${item.address}:${field}`] = value
}

function encodeHex(item: RegisterDefinition, text: string): number[] {
  const compact = text.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '')
  if (!compact || compact.length % 4 !== 0) throw new Error('HEX 值应按每个寄存器四位十六进制输入')
  const values = compact.match(/.{4}/g)?.map((value) => Number.parseInt(value, 16)) ?? []
  if (values.length !== Math.max(1, item.length)) throw new Error(`需要输入 ${Math.max(1, item.length)} 个原始值`)
  return values
}

/**
 * @brief 提交点编辑值。
 *
 * 保存到对应从站实例，并在服务运行时同步到主进程数据区。
 */
async function commitCell(item: RegisterDefinition, field: EditableField): Promise<void> {
  const instance = selected.value
  if (!instance) return
  const key = `${item.address}:${field}`
  if (!(key in editValues)) return
  try {
    const addressInfo = resolveRegisterAddress(item.address)
    if (!addressInfo) throw new Error('点地址不属于有效 Modbus 数据区')
    const values = field === 'hex' ? encodeHex(item, editValues[key]) : encodeRegisterValue(item, editValues[key])
    if (values.length !== Math.max(1, item.length)) throw new Error(`数据类型需要 ${values.length} 个值，但点长度配置为 ${item.length}`)
    store.commit('setServerInstanceDictionaryRegisters', { id: instance.id, key: String(item.address), values })
    if (instance.running) {
      await Promise.all(values.map((value, index) => window.modbusApi.server.updateInstanceData(instance.id, { area: addressInfo.area, address: addressInfo.protocolAddress + index, value })))
    }
    delete editValues[key]
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

async function updateBitValue(item: RegisterDefinition, value: string | number | boolean): Promise<void> {
  const instance = selected.value
  if (!instance) return
  const addressInfo = resolveRegisterAddress(item.address)
  if (!addressInfo) return
  const values = [value ? 1 : 0]
  store.commit('setServerInstanceDictionaryRegisters', { id: instance.id, key: String(item.address), values })
  if (instance.running) await window.modbusApi.server.updateInstanceData(instance.id, { area: addressInfo.area, address: addressInfo.protocolAddress, value: values[0] })
}

/* ---- 从站实例管理 ---- */
function openCreateDialog(): void {
  editingInstanceId.value = null
  Object.assign(draft, {
    name: `从站 ${store.state.servers.length + 1}`,
    slaveId: store.state.server.slaveId,
    tcpHost: store.state.server.tcpHost,
    tcpPort: store.state.server.tcpPort + store.state.servers.length,
    protocol: store.state.server.protocol,
    serial: { ...store.state.connection }
  })
  draftVisible.value = true
}

/**
 * @brief 打开编辑从站对话框。
 *
 * 运行中的从站禁止编辑，需先停止以避免配置与运行态不一致。
 * @param instance 待编辑的从站实例。
 */
function openEditDialog(instance: ServerRuntimeInstance): void {
  if (instance.running) { ElMessage.warning('请先停止该从站再编辑'); return }
  editingInstanceId.value = instance.id
  Object.assign(draft, {
    name: instance.name,
    slaveId: instance.slaveId,
    tcpHost: instance.tcpHost,
    tcpPort: instance.tcpPort,
    protocol: instance.protocol,
    serial: { ...instance.serial }
  })
  draftVisible.value = true
}

function saveInstance(): void {
  if (!draft.name.trim()) { ElMessage.warning('请输入从站名称'); return }
  if (draft.protocol === 'RTU' && !draft.serial.path.trim()) { ElMessage.warning('请选择串口'); return }
  const payload = {
    name: draft.name.trim(),
    slaveId: draft.slaveId,
    tcpHost: draft.tcpHost,
    tcpPort: draft.tcpPort,
    protocol: draft.protocol,
    serial: { ...draft.serial }
  }
  if (editingInstanceId.value) {
    store.commit('updateServerInstance', { id: editingInstanceId.value, patch: payload })
    ElMessage.success('从站已更新')
  } else {
    const id = 'srv-' + Date.now()
    store.commit('addServerInstance', {
      id,
      ...payload,
      running: false,
      requestCount: 0,
      dictionaryRegisters: {},
      points: []
    })
    selectedId.value = id
    ElMessage.success('从站已添加')
  }
  draftVisible.value = false
}

async function toggleInstance(id: string): Promise<void> {
  try { await store.dispatch('toggleServerInstance', id) }
  catch (error) { ElMessage.error((error as Error).message) }
}

async function removeInstance(id: string): Promise<void> {
  try {
    await store.dispatch('removeServerInstance', id)
    if (selectedId.value === id) selectedId.value = null
  } catch (error) { ElMessage.error((error as Error).message) }
}

/* ---- 点表管理 ---- */
function openCreatePointDialog(): void {
  if (!selected.value) return
  pointEditIndex.value = -1
  Object.assign(pointDraft, createEmptyPoint())
  pointDialogVisible.value = true
}

function openEditPointDialog(item: RegisterDefinition, index: number): void {
  pointEditIndex.value = index
  // 兼容老数据/导入点位：缺少 factor 时归一化为 1，避免 el-input-number 因 undefined 无法编辑
  Object.assign(pointDraft, { ...item, factor: Number.isFinite(item.factor) ? item.factor : 1 })
  pointDialogVisible.value = true
}

function onPointDataTypeChange(type: string): void {
  pointDraft.length = getDefaultLengthForType(type)
}

function savePoint(): void {
  const instance = selected.value
  if (!instance) return
  if (!pointDraft.name.trim()) { ElMessage.warning('请输入点名称'); return }
  const factor = Number.isFinite(pointDraft.factor) ? pointDraft.factor : 1
  const point = { ...pointDraft, name: pointDraft.name.trim(), group: pointDraft.group.trim() || '默认分组', unit: pointDraft.unit.trim() || '无', factor }
  if (pointEditIndex.value >= 0) store.commit('updateServerPoint', { id: instance.id, index: pointEditIndex.value, point })
  else store.commit('addServerPoint', { id: instance.id, point })
  pointDialogVisible.value = false
  ElMessage.success(pointEditIndex.value >= 0 ? '点已更新' : '点已添加')
}

function removePoint(index: number): void {
  const instance = selected.value
  if (!instance) return
  store.commit('removeServerPoint', { id: instance.id, index })
}

async function handleImportPoints(): Promise<void> {
  const instance = selected.value
  if (!instance) return
  if (!window.modbusApi) { ElMessage.warning('导入功能仅在桌面端可用'); return }
  try {
    const items = await window.modbusApi.dictionary.import()
    if (!items || items.length === 0) return
    store.commit('setServerPoints', { id: instance.id, points: items })
    ElMessage.success(`已导入 ${items.length} 个点`)
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

async function handleExportPoints(): Promise<void> {
  const instance = selected.value
  if (!instance) return
  if (!window.modbusApi) { ElMessage.warning('导出功能仅在桌面端可用'); return }
  if (instance.points.length === 0) { ElMessage.warning('点表为空，无数据可导出'); return }
  try {
    const path = await window.modbusApi.dictionary.export(instance.points.map((item) => ({ ...item })))
    if (path) ElMessage.success('从站点表已导出')
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

/**
 * @brief 进入从站页时扫描串口，供新建 RTU 从站下拉选择。
 */
onMounted(() => {
  store.dispatch('refreshPorts').catch((error) => ElMessage.error((error as Error).message))
})
</script>

<template>
  <div class="workspace server-workspace">
    <aside class="side-column">
      <section class="panel server-list-panel">
        <div class="panel-title">
          <h3>从站列表</h3>
          <button class="add-server-button" @click="openCreateDialog">+ 新增从站</button>
        </div>
        <div v-if="store.state.servers.length === 0" class="empty-tip">暂无从站，点击「新增从站」创建</div>
        <div
          v-for="instance in store.state.servers"
          :key="instance.id"
          class="server-item"
          :class="{ active: selected?.id === instance.id }"
          @click="selectedId = instance.id"
        >
          <div class="server-item-main">
            <strong>{{ instance.name }}</strong>
            <small v-if="instance.protocol === 'RTU'">从站 {{ instance.slaveId }} · RTU · {{ instance.serial.path }} @ {{ instance.serial.baudRate }}</small>
            <small v-else>从站 {{ instance.slaveId }} · {{ instance.protocol }} · {{ instance.tcpHost }}:{{ instance.tcpPort }}</small>
            <div class="server-item-stat">
              <i :class="{ online: instance.running }" />{{ instance.running ? '运行中' : '已停止' }}
              <span>请求 {{ instance.requestCount }}</span>
            </div>
          </div>
          <div class="server-item-actions" @click.stop>
            <el-button size="small" :type="instance.running ? 'danger' : 'success'" @click="toggleInstance(instance.id)">{{ instance.running ? '停止' : '启动' }}</el-button>
            <el-button size="small" link type="primary" @click="openEditDialog(instance)">编辑</el-button>
            <el-button size="small" link type="danger" @click="removeInstance(instance.id)">删除</el-button>
          </div>
        </div>
      </section>
    </aside>
    <section class="content-column">
      <section class="panel register-panel full-height">
        <div v-if="!selected" class="empty-tip full-empty">请选择或创建一个从站</div>
        <template v-else>
          <div class="panel-title">
            <h3>{{ selected.name }} - 数据区</h3>
            <span v-if="selected.protocol === 'RTU'">从站 {{ selected.slaveId }} · {{ selected.serial.path }} @ {{ selected.serial.baudRate }} · {{ selected.running ? '运行中' : '已停止' }}</span>
            <span v-else>从站 {{ selected.slaveId }} · {{ selected.protocol }} · {{ selected.running ? '运行中' : '已停止' }}</span>
          </div>
          <div class="server-point-toolbar">
            <el-button size="small" @click="openCreatePointDialog">新增点</el-button>
            <el-button size="small" @click="handleImportPoints">导入点表</el-button>
            <el-button size="small" @click="handleExportPoints">导出点表</el-button>
          </div>
          <el-tabs v-model="activeArea">
            <el-tab-pane label="线圈 (0xxxx)" name="coil" />
            <el-tab-pane label="离散输入 (1xxxx)" name="discrete" />
            <el-tab-pane label="输入寄存器 (3xxxx)" name="input" />
            <el-tab-pane label="保持寄存器 (4xxxx)" name="holding" />
          </el-tabs>
          <el-table :data="activeRows" height="calc(100% - 145px)" stripe empty-text="该数据区暂无点，请点击「新增点」">
            <el-table-column label="地址" width="110"><template #default="scope">{{ formatAddressHex(scope.row.item.address) }}</template></el-table-column>
            <el-table-column label="名称" min-width="150"><template #default="scope"><strong>{{ scope.row.item.name }}</strong><small class="cell-meta">{{ scope.row.item.dataType }} / 长度 {{ scope.row.item.length }}</small></template></el-table-column>
            <el-table-column v-if="isBitArea" label="当前状态" min-width="150"><template #default="scope"><el-switch :model-value="Boolean(scope.row.values[0])" @change="updateBitValue(scope.row.item, $event)" /></template></el-table-column>
            <el-table-column v-if="!isBitArea" label="原始值 HEX" min-width="190"><template #default="scope"><el-input :model-value="getCellValue(scope.row, 'hex')" size="small" @update:model-value="updateCellValue(scope.row.item, 'hex', $event)" @change="commitCell(scope.row.item, 'hex')" /></template></el-table-column>
            <el-table-column v-if="!isBitArea" label="解析值" min-width="170"><template #default="scope"><el-input :model-value="getCellValue(scope.row, 'parsed')" size="small" @update:model-value="updateCellValue(scope.row.item, 'parsed', $event)" @change="commitCell(scope.row.item, 'parsed')" /></template></el-table-column>
            <el-table-column label="倍率/单位" min-width="125"><template #default="scope">×{{ Number.isFinite(scope.row.item.factor) ? scope.row.item.factor : 1 }} {{ scope.row.item.unit }}</template></el-table-column>
            <el-table-column label="权限" width="80"><template #default="scope"><el-tag :type="scope.row.item.access === 'R' ? 'info' : 'success'">{{ scope.row.item.access }}</el-tag></template></el-table-column>
            <el-table-column label="备注" min-width="180"><template #default="scope">{{ scope.row.item.remark }}</template></el-table-column>
            <el-table-column label="操作" width="130" fixed="right">
              <template #default="scope">
                <el-button link type="primary" @click="openEditPointDialog(scope.row.item, scope.row.index)">编辑</el-button>
                <el-button link type="danger" @click="removePoint(scope.row.index)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </template>
      </section>
    </section>

    <el-dialog v-model="draftVisible" :title="editingInstanceId ? '编辑从站' : '新增从站'" width="480px">
      <el-form label-width="90px">
        <el-form-item label="名称"><el-input v-model="draft.name" /></el-form-item>
        <el-form-item label="协议"><el-select v-model="draft.protocol"><el-option label="Modbus TCP" value="TCP" /><el-option label="Modbus UDP" value="UDP" /><el-option label="Modbus RTU" value="RTU" /></el-select></el-form-item>
        <el-form-item label="从站地址"><el-input-number v-model="draft.slaveId" :min="1" :max="247" controls-position="right" /></el-form-item>
        <template v-if="draft.protocol === 'RTU'">
          <el-form-item label="串口"><el-select v-model="draft.serial.path"><el-option v-for="port in store.state.ports" :key="port" :label="port" :value="port" /></el-select></el-form-item>
          <el-form-item label="波特率"><el-select v-model="draft.serial.baudRate"><el-option v-for="value in baudRates" :key="value" :label="value" :value="value" /></el-select></el-form-item>
          <div class="form-row-grid">
            <el-form-item label="数据位"><el-select v-model="draft.serial.dataBits"><el-option :value="8" label="8" /></el-select></el-form-item>
            <el-form-item label="停止位"><el-select v-model="draft.serial.stopBits"><el-option :value="1" label="1" /><el-option :value="2" label="2" /></el-select></el-form-item>
          </div>
          <el-form-item label="校验位"><el-select v-model="draft.serial.parity"><el-option label="None" value="none" /><el-option label="Even" value="even" /><el-option label="Odd" value="odd" /></el-select></el-form-item>
        </template>
        <template v-else>
          <el-form-item label="监听地址"><el-input v-model="draft.tcpHost" /></el-form-item>
          <el-form-item label="监听端口"><el-input-number v-model="draft.tcpPort" :min="1" :max="65535" controls-position="right" /></el-form-item>
        </template>
      </el-form>
      <template #footer><el-button @click="draftVisible = false">取消</el-button><el-button type="primary" @click="saveInstance">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="pointDialogVisible" :title="pointEditIndex >= 0 ? '编辑点' : '新增点'" width="620px">
      <el-form label-width="90px" class="dictionary-form">
        <div class="dictionary-form-grid">
          <el-form-item label="分组"><el-input v-model="pointDraft.group" placeholder="例如：温度传感器" /></el-form-item>
          <el-form-item label="名称"><el-input v-model="pointDraft.name" placeholder="请输入点名称" /></el-form-item>
          <el-form-item label="地址"><el-input v-model="pointAddressHex" placeholder="例如 40010" /></el-form-item>
          <el-form-item label="数据类型"><el-select v-model="pointDraft.dataType" @change="onPointDataTypeChange"><el-option v-for="type in ['UINT16','INT16','UINT32','INT32','FLOAT_ABCD','FLOAT_CDAB','FLOAT_BADC','FLOAT_DCBA','BCD','BIT']" :key="type" :label="type" :value="type" /></el-select></el-form-item>
          <el-form-item label="长度"><el-input-number v-model="pointDraft.length" :min="1" :max="125" controls-position="right" /></el-form-item>
          <el-form-item label="读写权限"><el-select v-model="pointDraft.access"><el-option label="只读 R" value="R" /><el-option label="只写 W" value="W" /><el-option label="读写 RW" value="RW" /></el-select></el-form-item>
          <el-form-item label="比例因子"><el-input-number v-model="pointDraft.factor" :precision="4" :step="0.1" controls-position="right" /></el-form-item>
          <el-form-item label="单位"><el-input v-model="pointDraft.unit" placeholder="例如：°C、kPa、%" /></el-form-item>
        </div>
        <el-form-item label="备注"><el-input v-model="pointDraft.remark" type="textarea" :rows="3" placeholder="填写点位用途、取值范围或调试说明" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="pointDialogVisible = false">取消</el-button><el-button type="primary" @click="savePoint">保存</el-button></template>
    </el-dialog>
  </div>
</template>

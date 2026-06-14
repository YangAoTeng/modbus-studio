<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useStore } from 'vuex'
import { ElMessage } from 'element-plus'
import type { RootState } from '../store'
import ConnectionPanel from '../components/ConnectionPanel.vue'

const store = useStore<RootState>()
const reading = ref(false)
const writeDialogVisible = ref(false)
const writeAddress = ref(0)
const writeText = ref('100')
let pollTimer: number | undefined

const rows = computed(() => store.state.client.registers.map((value, index, values) => {
  const next = values[index + 1] ?? 0
  const unsigned32 = ((value << 16) | next) >>> 0
  const floatBuffer = new ArrayBuffer(4)
  const view = new DataView(floatBuffer)
  view.setUint16(0, value)
  view.setUint16(2, next)
  return {
    address: store.state.client.startAddress + index,
    hex: value.toString(16).padStart(4, '0').toUpperCase(),
    uint16: value,
    int16: value > 0x7fff ? value - 0x10000 : value,
    uint32: unsigned32,
    int32: unsigned32 > 0x7fffffff ? unsigned32 - 0x100000000 : unsigned32,
    float: Number.isFinite(view.getFloat32(0)) ? view.getFloat32(0).toExponential(5) : '-',
    binary: value.toString(2).padStart(16, '0').replace(/(.{4})/g, '$1 ').trim(),
    remark: store.state.dictionary.find(item => item.address === 40001 + store.state.client.startAddress + index)?.name ?? ''
  }
}))

/**
 * @brief 执行一次读取并处理界面状态。
 *
 * 校验串口连接后调用 Vuex 读取动作，防止轮询期间出现并发请求。
 */
async function readOnce(): Promise<void> {
  if (!store.state.connected) { ElMessage.warning('请先连接串口'); return }
  if (reading.value) return
  reading.value = true
  try { await store.dispatch('readOnce') } catch (error) { ElMessage.error((error as Error).message); stopPolling() } finally { reading.value = false }
}

/**
 * @brief 启动自动轮询。
 *
 * 立即读取一次，随后按照配置周期调度读取；轮询期间禁止重复启动。
 */
async function startPolling(): Promise<void> {
  if (!store.state.connected) { ElMessage.warning('请先连接串口'); return }
  store.commit('setPolling', true)
  await readOnce()
  pollTimer = window.setInterval(readOnce, store.state.client.pollInterval)
}

/**
 * @brief 停止自动轮询。
 *
 * 清理定时器并同步 Vuex 轮询状态，页面销毁或通信失败时均可安全调用。
 */
function stopPolling(): void {
  if (pollTimer !== undefined) window.clearInterval(pollTimer)
  pollTimer = undefined
  store.commit('setPolling', false)
}

/**
 * @brief 解析并写入寄存器数据。
 *
 * 接受逗号或空格分隔的十进制及 0x 十六进制数值，单值使用 06，多值使用 16 功能码。
 */
async function writeRegisters(): Promise<void> {
  if (!store.state.connected) { ElMessage.warning('请先连接串口'); return }
  const values = writeText.value.split(/[\s,，]+/).filter(Boolean).map(value => Number(value))
  if (values.length === 0 || values.some(value => !Number.isInteger(value) || value < 0 || value > 65535)) { ElMessage.error('请输入 0 到 65535 的整数，多个值使用逗号分隔'); return }
  try {
    await store.dispatch('writeRegisters', { address: writeAddress.value, values })
    writeDialogVisible.value = false
    ElMessage.success(`成功写入 ${values.length} 个寄存器`)
  } catch (error) { ElMessage.error((error as Error).message) }
}

onBeforeUnmount(stopPolling)
</script>

<template>
  <div class="workspace client-workspace">
    <ConnectionPanel />
    <section class="content-column">
      <section class="panel task-toolbar">
        <div><label>功能码</label><el-select v-model="store.state.client.functionCode"><el-option label="03 读取保持寄存器" :value="3" /><el-option label="04 读取输入寄存器" :value="4" /></el-select></div>
        <div><label>从机地址</label><el-input-number v-model="store.state.client.slaveId" :min="1" :max="247" controls-position="right" /></div>
        <div><label>起始地址</label><el-input-number v-model="store.state.client.startAddress" :min="0" :max="65535" controls-position="right" /></div>
        <div><label>数量</label><el-input-number v-model="store.state.client.quantity" :min="1" :max="125" controls-position="right" /></div>
        <div><label>轮询周期</label><el-input-number v-model="store.state.client.pollInterval" :min="100" :step="100" controls-position="right" /></div>
        <div class="toolbar-actions"><el-button type="primary" :loading="reading" @click="readOnce">读取</el-button><el-button type="warning" @click="writeDialogVisible = true">写入</el-button><el-button v-if="!store.state.client.polling" type="success" @click="startPolling">开始轮询</el-button><el-button v-else type="danger" @click="stopPolling">停止轮询</el-button></div>
      </section>
      <section class="panel register-panel">
        <div class="panel-title"><h3>寄存器数据</h3><span>响应时间：{{ store.state.client.lastElapsedMs || '-' }} ms</span></div>
        <el-table :data="rows" height="100%" stripe empty-text="连接设备并读取后显示数据">
          <el-table-column prop="address" label="地址" width="85" /><el-table-column prop="hex" label="原始值(HEX)" min-width="110" /><el-table-column prop="uint16" label="UINT16" min-width="90" /><el-table-column prop="int16" label="INT16" min-width="90" /><el-table-column prop="uint32" label="UINT32" min-width="110" /><el-table-column prop="int32" label="INT32" min-width="110" /><el-table-column prop="float" label="FLOAT(ABCD)" min-width="130" /><el-table-column prop="binary" label="二进制" min-width="180" /><el-table-column prop="remark" label="备注" min-width="110" />
        </el-table>
      </section>
      <section class="panel compact-log">
        <div class="panel-title"><h3>报文日志</h3><el-button link type="primary" @click="store.commit('clearLogs')">清空日志</el-button></div>
        <el-table :data="store.state.logs.slice(0, 5)" height="160" size="small" empty-text="暂无通信报文"><el-table-column prop="time" label="时间" width="100" /><el-table-column prop="direction" label="方向" width="70"><template #default="scope"><b :class="scope.row.direction.toLowerCase()">{{ scope.row.direction }}</b></template></el-table-column><el-table-column prop="raw" label="数据" min-width="280" show-overflow-tooltip /><el-table-column prop="parsed" label="解析结果" min-width="260" show-overflow-tooltip /><el-table-column prop="elapsedMs" label="耗时" width="75" /><el-table-column prop="status" label="状态" width="75" /></el-table>
      </section>
    </section>
    <el-dialog v-model="writeDialogVisible" title="写保持寄存器" width="460px"><el-form label-width="90px"><el-form-item label="从机地址"><el-input-number v-model="store.state.client.slaveId" :min="1" :max="247" /></el-form-item><el-form-item label="起始地址"><el-input-number v-model="writeAddress" :min="0" :max="65535" /></el-form-item><el-form-item label="写入值"><el-input v-model="writeText" type="textarea" :rows="4" placeholder="单值使用功能码 06；多个值用逗号分隔，使用功能码 16" /></el-form-item></el-form><template #footer><el-button @click="writeDialogVisible = false">取消</el-button><el-button type="primary" @click="writeRegisters">确认写入</el-button></template></el-dialog>
  </div>
</template>

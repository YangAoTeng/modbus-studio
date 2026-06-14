<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useStore } from 'vuex'
import { ElMessage } from 'element-plus'
import type { RootState } from '../store'
import type { ProtocolMode } from '../../shared/types'

const store = useStore<RootState>()
const connection = computed(() => store.state.connection)
const tcp = computed(() => store.state.tcp)

/**
 * @brief 刷新串口列表并显示错误。
 *
 * 页面加载和用户主动刷新时调用 Vuex 扫描动作，异常通过消息组件提示。
 */
async function refreshPorts(): Promise<void> {
  try { await store.dispatch('refreshPorts') } catch (error) { ElMessage.error((error as Error).message) }
}

/**
 * @brief 切换 RTU 或 TCP 连接状态。
 *
 * 根据当前协议调用相应连接服务，并在成功后显示连接结果。
 */
async function toggleConnection(): Promise<void> {
  try {
    await store.dispatch('toggleConnection')
    ElMessage.success(store.state.connected ? `${store.state.protocol} 连接成功` : '连接已断开')
  } catch (error) { ElMessage.error((error as Error).message) }
}

/**
 * @brief 修改 Client 通信协议。
 *
 * 未连接时允许在 RTU 与 TCP 之间切换，已连接时由控件禁用避免状态不一致。
 * @param value 新协议。
 */
function changeProtocol(value: ProtocolMode): void {
  store.commit('setProtocol', value)
}

onMounted(refreshPorts)
</script>

<template>
  <aside class="side-column">
    <section class="panel connection-panel">
      <h3>连接配置</h3>
      <label>协议类型</label><el-select :model-value="store.state.protocol" :disabled="store.state.connected" @change="changeProtocol"><el-option label="Modbus RTU" value="RTU" /><el-option label="Modbus TCP" value="TCP" /></el-select>
      <template v-if="store.state.protocol === 'RTU'">
        <div class="section-label">串口设置 <el-button link type="primary" @click="refreshPorts">刷新</el-button></div>
        <label>端口</label><el-select v-model="connection.path"><el-option v-for="port in store.state.ports" :key="port" :label="port" :value="port" /></el-select>
        <label>波特率</label><el-select v-model="connection.baudRate"><el-option v-for="value in [9600, 19200, 38400, 57600, 115200]" :key="value" :label="value" :value="value" /></el-select>
        <div class="field-grid"><div><label>数据位</label><el-select v-model="connection.dataBits"><el-option :value="8" label="8" /></el-select></div><div><label>停止位</label><el-select v-model="connection.stopBits"><el-option :value="1" label="1" /><el-option :value="2" label="2" /></el-select></div></div>
        <label>校验位</label><el-select v-model="connection.parity"><el-option label="None" value="none" /><el-option label="Even" value="even" /><el-option label="Odd" value="odd" /></el-select>
        <label>超时时间</label><el-input-number v-model="connection.timeout" :min="100" :max="10000" :step="100" controls-position="right" />
      </template>
      <template v-else>
        <div class="section-label">网络设置</div>
        <label>主机地址</label><el-input v-model="tcp.host" placeholder="127.0.0.1" />
        <label>端口</label><el-input-number v-model="tcp.port" :min="1" :max="65535" controls-position="right" />
        <label>超时时间</label><el-input-number v-model="tcp.timeout" :min="100" :max="10000" :step="100" controls-position="right" />
      </template>
      <el-button class="connect-button" :type="store.state.connected ? 'danger' : 'primary'" :loading="store.state.connecting" @click="toggleConnection">{{ store.state.connected ? '断开连接' : `连接 ${store.state.protocol}` }}</el-button>
      <div class="connection-state"><i :class="{ online: store.state.connected }" />{{ store.state.connected ? '已连接' : '未连接' }}<span>{{ store.state.protocol === 'RTU' ? connection.path : `${tcp.host}:${tcp.port}` }}</span></div>
    </section>
    <section class="panel stats-panel"><h3>通信统计</h3><div><span>发送计数</span><strong>{{ store.state.logs.filter(item => item.direction === 'TX').length }}</strong></div><div><span>接收计数</span><strong>{{ store.state.logs.filter(item => item.direction === 'RX').length }}</strong></div><div><span>错误计数</span><strong>{{ store.state.logs.filter(item => item.status === '失败').length }}</strong></div></section>
  </aside>
</template>

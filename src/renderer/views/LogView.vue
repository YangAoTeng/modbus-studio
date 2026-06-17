<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useStore } from 'vuex'
import { ElMessage } from 'element-plus'
import type { RootState } from '../store'
import type { PacketLogItem } from '../../shared/types'

const store = useStore<RootState>()
const filterDirection = ref<'全部' | 'TX' | 'RX'>('全部')
const filterProtocol = ref<'全部' | 'RTU' | 'TCP'>('全部')
const filterAddressRange = ref<'全部' | 'coil' | 'discrete' | 'input' | 'holding'>('全部')

const addressRangeLabels: Record<string, string> = {
  coil: '线圈 0xxxx (00001-09999)',
  discrete: '离散输入 1xxxx (10001-19999)',
  input: '输入寄存器 3xxxx (30001-39999)',
  holding: '保持寄存器 4xxxx (40001-49999)'
}

/** @brief 从日志解析文本中推断所属 Modbus 数据区。 */
function getAreaFromParsed(parsed: string): string | null {
  const dispAddr = parsed.match(/地址\s*(\d{5})/)
  if (dispAddr) {
    const addr = Number(dispAddr[1])
    if (addr >= 40001 && addr <= 49999) return 'holding'
    if (addr >= 30001 && addr <= 39999) return 'input'
    if (addr >= 10001 && addr <= 19999) return 'discrete'
    if (addr >= 1 && addr <= 9999) return 'coil'
  }
  const fcMatch = parsed.match(/FC\s*(\d+)/i) || parsed.match(/功能码\s*(\d+)/)
  if (fcMatch) {
    const fc = Number(fcMatch[1])
    if (fc === 1 || fc === 5 || fc === 15) return 'coil'
    if (fc === 2) return 'discrete'
    if (fc === 4) return 'input'
    if (fc === 3 || fc === 6 || fc === 16) return 'holding'
  }
  if (/线圈|Coil/i.test(parsed)) return 'coil'
  if (/离散/.test(parsed)) return 'discrete'
  if (/输入寄存器/.test(parsed)) return 'input'
  if (/保持寄存器|Holding/i.test(parsed)) return 'holding'
  return null
}

const filteredLogs = computed(() => {
  return store.state.logs.filter((item: PacketLogItem) => {
    if (filterDirection.value !== '全部' && item.direction !== filterDirection.value) return false
    if (filterProtocol.value !== '全部' && item.protocol !== filterProtocol.value) return false
    if (filterAddressRange.value !== '全部') {
      if (getAreaFromParsed(item.parsed) !== filterAddressRange.value) return false
    }
    return true
  })
})

watch(() => store.state.logs.length, () => {
  nextTick(() => {
    const tableBody = document.querySelector('.log-table .el-table__body-wrapper')
    if (tableBody) tableBody.scrollTop = 0
  })
})

async function handleExport(): Promise<void> {
  if (!window.modbusApi) { ElMessage.warning('导出功能仅在桌面端可用'); return }
  if (store.state.logs.length === 0) { ElMessage.warning('日志为空，无数据可导出'); return }
  try {
    const path = await window.modbusApi.log.export(store.state.logs)
    if (path) ElMessage.success('报文日志已导出')
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}
</script>

<template>
  <div class="page-stack">
    <section class="panel page-toolbar">
      <el-select v-model="filterDirection" style="width: 120px">
        <el-option label="全部方向" value="全部" />
        <el-option label="发送 TX" value="TX" />
        <el-option label="接收 RX" value="RX" />
      </el-select>
      <el-select v-model="filterProtocol" style="width: 130px; margin-left: 12px">
        <el-option label="全部协议" value="全部" />
        <el-option label="RTU" value="RTU" />
        <el-option label="TCP" value="TCP" />
      </el-select>
      <el-select v-model="filterAddressRange" style="width: 220px; margin-left: 12px">
        <el-option label="全部地址区" value="全部" />
        <el-option :label="addressRangeLabels.coil" value="coil" />
        <el-option :label="addressRangeLabels.discrete" value="discrete" />
        <el-option :label="addressRangeLabels.input" value="input" />
        <el-option :label="addressRangeLabels.holding" value="holding" />
      </el-select>
      <span class="toolbar-spacer" />
      <span class="toolbar-tip" style="margin-right: 16px">保留最近 1000 条，新报文自动刷新</span>
      <el-button @click="handleExport">导出日志</el-button>
      <el-button @click="store.commit('clearLogs')">清空日志</el-button>
    </section>
    <section class="panel page-table">
      <div class="panel-title">
        <h3>报文日志</h3>
        <span>显示 {{ filteredLogs.length }} / {{ store.state.logs.length }} 条</span>
      </div>
      <el-table :data="filteredLogs" height="100%" stripe class="log-table" empty-text="暂无通信报文">
        <el-table-column prop="id" label="#" width="60" />
        <el-table-column prop="time" label="时间" width="110" />
        <el-table-column prop="direction" label="方向" width="80">
          <template #default="scope">
            <b :class="scope.row.direction.toLowerCase()">{{ scope.row.direction }}</b>
          </template>
        </el-table-column>
        <el-table-column prop="protocol" label="协议" width="80" />
        <el-table-column prop="raw" label="数据" min-width="300" show-overflow-tooltip />
        <el-table-column prop="parsed" label="解析结果" min-width="320" show-overflow-tooltip />
        <el-table-column prop="elapsedMs" label="耗时(ms)" width="90" />
        <el-table-column prop="status" label="状态" width="80" />
      </el-table>
    </section>
  </div>
</template>

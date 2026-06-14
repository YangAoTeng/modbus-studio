<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useStore } from 'vuex'
import type { RootState } from '../store'
import type { PacketLogItem } from '../../shared/types'

const store = useStore<RootState>()
const filterDirection = ref<'全部' | 'TX' | 'RX'>('全部')
const filterProtocol = ref<'全部' | 'RTU' | 'TCP'>('全部')

/**
 * @brief 按方向和协议过滤报文日志。
 *
 * 选择"全部"时不限制对应维度，保持所有条目。
 */
const filteredLogs = computed(() => {
  return store.state.logs.filter((item: PacketLogItem) => {
    if (filterDirection.value !== '全部' && item.direction !== filterDirection.value) return false
    if (filterProtocol.value !== '全部' && item.protocol !== filterProtocol.value) return false
    return true
  })
})

/**
 * @brief 新报文到达时自动滚回表格顶部。
 *
 * 因为日志以 prepend 方式写入 store.state.logs，最新报文始终在数组首位。
 */
watch(() => store.state.logs.length, () => {
  nextTick(() => {
    const tableBody = document.querySelector('.log-table .el-table__body-wrapper')
    if (tableBody) tableBody.scrollTop = 0
  })
})
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
      <span class="toolbar-spacer" />
      <span class="toolbar-tip" style="margin-right: 16px">保留最近 1000 条，新报文自动刷新</span>
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

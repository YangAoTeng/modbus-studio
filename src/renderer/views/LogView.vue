<script setup lang="ts">
import { useStore } from 'vuex'
import type { RootState } from '../store'
const store = useStore<RootState>()
</script>

<template><div class="page-stack"><section class="panel page-toolbar"><el-select model-value="全部"><el-option label="全部" value="全部" /></el-select><el-button>TX</el-button><el-button>RX</el-button><el-button>RTU</el-button><span class="toolbar-spacer" /><el-button @click="store.commit('clearLogs')">清空日志</el-button></section><section class="panel page-table"><div class="panel-title"><h3>报文日志</h3><span>保留最近 1000 条</span></div><el-table :data="store.state.logs" height="100%" stripe><el-table-column prop="time" label="时间" width="110" /><el-table-column prop="direction" label="方向" width="80"><template #default="scope"><b :class="scope.row.direction.toLowerCase()">{{ scope.row.direction }}</b></template></el-table-column><el-table-column prop="protocol" label="协议" width="80" /><el-table-column prop="raw" label="数据" min-width="300" /><el-table-column prop="parsed" label="解析结果" min-width="320" /><el-table-column prop="elapsedMs" label="耗时" width="80" /><el-table-column prop="status" label="状态" width="80" /></el-table></section></div></template>

<script setup lang="ts">
import { reactive } from 'vue'
import { useStore } from 'vuex'
import type { RootState } from '../store'

const store = useStore<RootState>()
const draft = reactive({ group: '新建分组', address: 40001, name: '新寄存器', dataType: 'UINT16', length: 1, access: 'R' as const, factor: 1, unit: '无', remark: '' })

/**
 * @brief 添加寄存器字典项。
 *
 * 将表单草稿复制到 Vuex 字典，避免后续编辑草稿时影响已添加数据。
 */
function addItem(): void {
  store.commit('addDictionaryItem', { ...draft })
}
</script>

<template>
  <div class="page-stack">
    <section class="panel page-toolbar dictionary-toolbar">
      <el-button type="primary" @click="addItem">添加</el-button>
      <el-input v-model="draft.name" class="dictionary-name" placeholder="新寄存器名称" />
      <el-input-number v-model="draft.address" class="dictionary-address" :min="0" :max="49999" controls-position="right" />
      <el-select v-model="draft.dataType" class="dictionary-type"><el-option v-for="type in ['UINT16','INT16','UINT32','INT32','FLOAT_ABCD','FLOAT_CDAB']" :key="type" :label="type" :value="type" /></el-select>
      <span class="toolbar-spacer" />
      <el-input class="dictionary-search" placeholder="搜索寄存器..." clearable />
    </section>
    <section class="panel page-table">
      <div class="panel-title"><h3>寄存器字典</h3><span>共 {{ store.state.dictionary.length }} 个点位</span></div>
      <el-table :data="store.state.dictionary" height="100%" stripe>
        <el-table-column prop="group" label="分组" min-width="120" /><el-table-column prop="address" label="地址" width="100" /><el-table-column prop="name" label="名称" min-width="130" /><el-table-column prop="dataType" label="数据类型" min-width="120" /><el-table-column prop="length" label="长度" width="70" /><el-table-column prop="access" label="读写" width="70" /><el-table-column prop="factor" label="比例因子" width="90" /><el-table-column prop="unit" label="单位" width="80" /><el-table-column prop="remark" label="备注" min-width="150" /><el-table-column label="操作" width="80"><template #default="scope"><el-button link type="danger" @click="store.commit('removeDictionaryItem', scope.$index)">删除</el-button></template></el-table-column>
      </el-table>
    </section>
  </div>
</template>

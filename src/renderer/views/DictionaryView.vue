<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useStore } from 'vuex'
import { ElMessage } from 'element-plus'
import type { RootState } from '../store'
import type { RegisterDefinition } from '../../shared/types'
import { getDefaultLengthForType } from '../utils/register-data'

const store = useStore<RootState>()
const dialogVisible = ref(false)
const editingIndex = ref(-1)
const searchText = ref('')
const draft = reactive<RegisterDefinition>(createEmptyItem())

const filteredDictionary = computed(() => {
  const keyword = searchText.value.trim().toLowerCase()
  if (!keyword) return store.state.dictionary.map((item, index) => ({ item, index }))
  return store.state.dictionary.map((item, index) => ({ item, index })).filter(({ item }) => [item.group, item.name, String(item.address), item.dataType, item.unit, item.remark].some((value) => String(value).toLowerCase().includes(keyword)))
})

function createEmptyItem(): RegisterDefinition {
  return { group: '默认分组', address: 40001, name: '', dataType: 'UINT16', length: 1, access: 'R', factor: 1, unit: '无', remark: '' }
}

function openCreateDialog(): void {
  editingIndex.value = -1
  Object.assign(draft, createEmptyItem())
  dialogVisible.value = true
}

function openEditDialog(item: RegisterDefinition, index: number): void {
  editingIndex.value = index
  Object.assign(draft, item)
  dialogVisible.value = true
}

function onDataTypeChange(newType: string): void {
  draft.length = getDefaultLengthForType(newType)
}

function saveItem(): void {
  if (!draft.name.trim()) { ElMessage.warning('请输入寄存器名称'); return }
  if (draft.length < 1) { ElMessage.warning('寄存器长度不能小于 1'); return }
  if (!Number.isFinite(draft.factor)) { ElMessage.warning('比例因子必须是有效数字'); return }
  const item = { ...draft, name: draft.name.trim(), group: draft.group.trim() || '默认分组', unit: draft.unit.trim() || '无' }
  if (editingIndex.value >= 0) store.commit('updateDictionaryItem', { index: editingIndex.value, item })
  else store.commit('addDictionaryItem', item)
  dialogVisible.value = false
  ElMessage.success(editingIndex.value >= 0 ? '寄存器已更新' : '寄存器已添加')
}

async function handleImport(): Promise<void> {
  if (!window.modbusApi) { ElMessage.warning('导入功能仅在桌面端可用'); return }
  try {
    const items = await window.modbusApi.dictionary.import()
    if (!items || items.length === 0) return
    store.commit('setDictionary', items)
    ElMessage.success(`已导入 ${items.length} 个字典项`)
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

async function handleExport(): Promise<void> {
  if (!window.modbusApi) { ElMessage.warning('导出功能仅在桌面端可用'); return }
  if (store.state.dictionary.length === 0) { ElMessage.warning('字典为空，无数据可导出'); return }
  try {
    const path = await window.modbusApi.dictionary.export(store.state.dictionary)
    if (path) ElMessage.success('寄存器字典已导出')
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

function handleMoveUp(index: number): void {
  store.commit('moveDictionaryItemUp', index)
}

function handleMoveDown(index: number): void {
  store.commit('moveDictionaryItemDown', index)
}
</script>

<template>
  <div class="page-stack">
    <section class="panel page-toolbar dictionary-toolbar">
      <el-button type="primary" @click="openCreateDialog">新增寄存器</el-button>
      <el-button @click="handleImport">导入字典</el-button>
      <el-button @click="handleExport">导出字典</el-button>
      <span class="toolbar-tip">可配置数据类型、长度、读写权限、比例因子、单位和备注</span>
      <span class="toolbar-spacer" />
      <el-input v-model="searchText" class="dictionary-search" placeholder="搜索名称、地址、单位或备注..." clearable />
    </section>

    <section class="panel" style="margin-bottom: 0;">
      <el-alert type="info" :closable="false" show-icon style="margin: 0;">
        <template #title>
          <span style="font-size: 13px; line-height: 1.8;">
            <b>地址区段说明：</b>
            00001 ~ 09999 = <b>线圈 Coils</b>&nbsp;&nbsp;|&nbsp;&nbsp;
            10001 ~ 19999 = <b>离散输入 Discrete Inputs</b>&nbsp;&nbsp;|&nbsp;&nbsp;
            30001 ~ 39999 = <b>输入寄存器 Input Registers</b>&nbsp;&nbsp;|&nbsp;&nbsp;
            40001 ~ 49999 = <b>保持寄存器 Holding Registers</b>
          </span>
        </template>
      </el-alert>
    </section>

    <section class="panel page-table">
      <div class="panel-title"><h3>寄存器字典</h3><span>显示 {{ filteredDictionary.length }} / {{ store.state.dictionary.length }} 个点位</span></div>
      <el-table :data="filteredDictionary" height="100%" stripe>
        <el-table-column label="分组" min-width="120"><template #default="scope">{{ scope.row.item.group }}</template></el-table-column>
        <el-table-column label="地址" width="100"><template #default="scope">{{ scope.row.item.address }}</template></el-table-column>
        <el-table-column label="名称" min-width="130"><template #default="scope">{{ scope.row.item.name }}</template></el-table-column>
        <el-table-column label="数据类型" min-width="120"><template #default="scope">{{ scope.row.item.dataType }}</template></el-table-column>
        <el-table-column label="长度" width="70"><template #default="scope">{{ scope.row.item.length }}</template></el-table-column>
        <el-table-column label="读写" width="80"><template #default="scope"><el-tag size="small">{{ scope.row.item.access }}</el-tag></template></el-table-column>
        <el-table-column label="比例因子" width="100"><template #default="scope">{{ scope.row.item.factor }}</template></el-table-column>
        <el-table-column label="单位" width="90"><template #default="scope">{{ scope.row.item.unit }}</template></el-table-column>
        <el-table-column label="备注" min-width="170" show-overflow-tooltip><template #default="scope">{{ scope.row.item.remark }}</template></el-table-column>
        <el-table-column label="操作" width="190" fixed="right">
          <template #default="scope">
            <el-button link type="primary" @click="handleMoveUp(scope.row.index)" :disabled="scope.row.index === 0">上移</el-button>
            <el-button link type="primary" @click="handleMoveDown(scope.row.index)" :disabled="scope.row.index === store.state.dictionary.length - 1">下移</el-button>
            <el-button link type="primary" @click="openEditDialog(scope.row.item, scope.row.index)">编辑</el-button>
            <el-button link type="danger" @click="store.commit('removeDictionaryItem', scope.row.index)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <el-dialog v-model="dialogVisible" :title="editingIndex >= 0 ? '编辑寄存器' : '新增寄存器'" width="620px">
      <el-form label-width="90px" class="dictionary-form">
        <div class="dictionary-form-grid">
          <el-form-item label="分组"><el-input v-model="draft.group" placeholder="例如：温度传感器" /></el-form-item>
          <el-form-item label="名称"><el-input v-model="draft.name" placeholder="请输入寄存器名称" /></el-form-item>
          <el-form-item label="地址"><el-input-number v-model="draft.address" :min="0" :max="65535" controls-position="right" /></el-form-item>
          <el-form-item label="数据类型"><el-select v-model="draft.dataType" @change="onDataTypeChange"><el-option v-for="type in ['UINT16','INT16','UINT32','INT32','FLOAT_ABCD','FLOAT_CDAB','FLOAT_BADC','FLOAT_DCBA','BCD','BIT']" :key="type" :label="type" :value="type" /></el-select></el-form-item>
          <el-form-item label="长度"><el-input-number v-model="draft.length" :min="1" :max="125" controls-position="right" /></el-form-item>
          <el-form-item label="读写权限"><el-select v-model="draft.access"><el-option label="只读 R" value="R" /><el-option label="只写 W" value="W" /><el-option label="读写 RW" value="RW" /></el-select></el-form-item>
          <el-form-item label="比例因子"><el-input-number v-model="draft.factor" :precision="4" :step="0.1" controls-position="right" /></el-form-item>
          <el-form-item label="单位"><el-input v-model="draft.unit" placeholder="例如：°C、kPa、%" /></el-form-item>
        </div>
        <el-form-item label="备注"><el-input v-model="draft.remark" type="textarea" :rows="3" placeholder="填写点位用途、取值范围或调试说明" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" @click="saveItem">保存</el-button></template>
    </el-dialog>
  </div>
</template>

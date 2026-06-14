<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useStore } from 'vuex'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, DocumentAdd, FolderOpened, MoreFilled } from '@element-plus/icons-vue'
import type { RootState } from '../store'
import type { RecentProject } from '../../shared/types'

const store = useStore<RootState>()
const projectStatus = computed(() => store.state.project.dirty ? '有未保存修改' : store.state.project.path ? '已保存' : '新建工程')

/**
 * @brief 确认是否允许替换当前工程。
 *
 * 当前工程存在未保存修改时弹出确认框，避免新建或打开操作直接丢失配置。
 * @returns 允许继续时返回 true。
 */
async function confirmReplaceCurrent(): Promise<boolean> {
  if (!store.state.project.dirty) return true
  try {
    await ElMessageBox.confirm('当前工程存在未保存修改，继续操作将丢失这些修改。', '确认操作', { confirmButtonText: '继续', cancelButtonText: '取消', type: 'warning' })
    return true
  } catch {
    return false
  }
}

/**
 * @brief 新建空白工程。
 *
 * 确认未保存修改后重置连接、Client、Server、日志和寄存器字典状态。
 */
async function createProject(): Promise<void> {
  if (!await confirmReplaceCurrent()) return
  store.commit('resetProject')
  ElMessage.success('已创建空白工程')
}

/**
 * @brief 通过文件选择框打开工程。
 *
 * 打开成功后载入所有配置；用户取消选择时不显示成功提示。
 */
async function openProject(): Promise<void> {
  if (!await confirmReplaceCurrent()) return
  try {
    const opened = await store.dispatch('openProject')
    if (opened) ElMessage.success('工程已打开')
  } catch (error) { ElMessage.error(`打开失败：${(error as Error).message}`) }
}

/**
 * @brief 保存当前工程。
 *
 * 已有路径时直接覆盖，未保存过的工程会弹出保存路径选择框。
 */
async function saveProject(): Promise<void> {
  try {
    const saved = await store.dispatch('saveProject', false)
    if (saved) ElMessage.success('工程已保存')
  } catch (error) { ElMessage.error(`保存失败：${(error as Error).message}`) }
}

/**
 * @brief 将工程另存为新文件。
 *
 * 强制弹出保存路径选择框，成功后当前工程路径切换到新文件。
 */
async function saveProjectAs(): Promise<void> {
  try {
    const saved = await store.dispatch('saveProject', true)
    if (saved) ElMessage.success('工程已另存为新文件')
  } catch (error) { ElMessage.error(`另存失败：${(error as Error).message}`) }
}

/**
 * @brief 打开最近工程。
 *
 * 确认当前修改后直接按记录路径载入，文件不存在时给出错误提示。
 * @param project 最近工程记录。
 */
async function openRecentProject(project: RecentProject): Promise<void> {
  if (!await confirmReplaceCurrent()) return
  try {
    await store.dispatch('openRecentProject', project.path)
    ElMessage.success(`已打开：${project.name}`)
  } catch (error) { ElMessage.error(`无法打开最近工程：${(error as Error).message}`) }
}

/**
 * @brief 移除最近工程记录。
 *
 * 仅从最近列表删除记录，不会删除磁盘上的工程文件。
 * @param project 最近工程记录。
 */
async function removeRecentProject(project: RecentProject): Promise<void> {
  await store.dispatch('removeRecentProject', project.path)
  ElMessage.success('已从最近工程中移除')
}

/**
 * @brief 标记工程信息已修改。
 *
 * 用户编辑工程名称、描述或版本时更新未保存状态。
 */
function markDirty(): void {
  store.commit('setProjectDirty', true)
}

/**
 * @brief 格式化最近打开时间。
 *
 * 将 ISO 时间转换为本地日期和分钟显示。
 * @param value ISO 时间字符串。
 * @returns 本地时间文本。
 */
function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

onMounted(() => store.dispatch('refreshRecentProjects'))
</script>

<template>
  <div class="project-layout">
    <aside class="panel project-actions">
      <div class="project-actions-title"><h3>工程管理</h3><el-tag :type="store.state.project.dirty ? 'warning' : 'success'" size="small">{{ projectStatus }}</el-tag></div>
      <el-button type="primary" :icon="DocumentAdd" @click="createProject">新建工程</el-button>
      <el-button :icon="FolderOpened" @click="openProject">打开工程</el-button>
      <el-button type="success" @click="saveProject">保存工程</el-button>
      <el-button @click="saveProjectAs">另存为</el-button>
      <el-divider />
      <div class="recent-title"><h4>最近工程</h4><span>{{ store.state.recentProjects.length }} 个</span></div>
      <div v-if="store.state.recentProjects.length" class="recent-list">
        <article v-for="project in store.state.recentProjects" :key="project.path" class="recent-project" @dblclick="openRecentProject(project)">
          <button class="recent-main" @click="openRecentProject(project)"><strong>{{ project.name }}</strong><span>{{ project.path }}</span><small>{{ formatTime(project.openedAt) }}</small></button>
          <el-button class="recent-delete" link :icon="Delete" title="移除记录" @click.stop="removeRecentProject(project)" />
        </article>
      </div>
      <el-empty v-else description="暂无最近工程" :image-size="48" />
    </aside>

    <section class="project-content">
      <section class="panel project-info">
        <div class="project-section-title"><div><h3>工程信息</h3><p>工程配置将保存为 .mbs 文件</p></div><el-icon><MoreFilled /></el-icon></div>
        <div class="form-row"><label>工程名称</label><el-input v-model="store.state.project.name" @input="markDirty" /></div>
        <div class="form-row"><label>工程描述</label><el-input v-model="store.state.project.description" type="textarea" :rows="3" @input="markDirty" /></div>
        <div class="form-row"><label>工程路径</label><el-input :model-value="store.state.project.path || '尚未保存，请点击保存工程'" disabled /></div>
        <div class="form-row"><label>工程版本</label><el-input v-model="store.state.project.version" @input="markDirty" /></div>
      </section>
      <section class="panel configuration-cards">
        <h3>工程配置概览</h3>
        <div class="card-grid">
          <article><strong>Client 连接</strong><span>{{ store.state.protocol }}</span><small>{{ store.state.protocol === 'RTU' ? `${store.state.connection.path} / ${store.state.connection.baudRate}` : `${store.state.tcp.host}:${store.state.tcp.port}` }}</small></article>
          <article><strong>轮询任务</strong><span>{{ store.state.client.functionCode === 3 ? '保持寄存器' : '输入寄存器' }}</span><small>地址 {{ store.state.client.startAddress }}，数量 {{ store.state.client.quantity }}</small></article>
          <article><strong>寄存器字典</strong><span>{{ store.state.dictionary.length }} 个点位</span><small>{{ store.state.dictionary.reduce((sum, item) => sum + item.length, 0) }} 个寄存器长度</small></article>
          <article><strong>Server 配置</strong><span>{{ store.state.server.protocol }}</span><small>从机 {{ store.state.server.slaveId }} / 端口 {{ store.state.server.tcpPort }}</small></article>
          <article><strong>报文日志</strong><span>{{ store.state.logs.length }} 条</span><small>最多保留 1000 条</small></article>
        </div>
      </section>
    </section>
  </div>
</template>

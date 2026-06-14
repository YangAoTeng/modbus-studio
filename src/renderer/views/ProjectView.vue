<script setup lang="ts">
import { useStore } from 'vuex'
import { ElMessage } from 'element-plus'
import type { RootState } from '../store'
const store = useStore<RootState>()

/**
 * @brief 打开工程文件并反馈结果。
 *
 * 调用 Vuex 工程动作，在成功读取后显示确认消息，异常时显示错误原因。
 */
async function openProject(): Promise<void> { try { await store.dispatch('openProject'); ElMessage.success('工程已打开') } catch (error) { ElMessage.error((error as Error).message) } }

/**
 * @brief 保存当前工程并反馈结果。
 *
 * 调用 Vuex 序列化当前状态，保存成功后提示用户。
 */
async function saveProject(): Promise<void> { try { await store.dispatch('saveProject'); ElMessage.success('工程已保存') } catch (error) { ElMessage.error((error as Error).message) } }
</script>

<template><div class="project-layout"><aside class="panel project-actions"><h3>工程管理</h3><el-button type="primary">新建工程</el-button><el-button @click="openProject">打开工程</el-button><el-button @click="saveProject">保存工程</el-button><el-button>另存为</el-button><el-divider /><h4>最近工程</h4><p>温度监控系统.mbs</p><p>电机调试项目.mbs</p><p>传感器测试.mbs</p></aside><section class="project-content"><section class="panel project-info"><h3>工程信息</h3><div class="form-row"><label>工程名称</label><el-input v-model="store.state.project.name" /></div><div class="form-row"><label>工程描述</label><el-input v-model="store.state.project.description" /></div><div class="form-row"><label>工程路径</label><el-input :model-value="store.state.project.path || '尚未保存'" disabled /></div><div class="form-row"><label>版本</label><el-input v-model="store.state.project.version" /></div></section><section class="panel configuration-cards"><h3>工程配置</h3><div class="card-grid"><article><strong>连接配置</strong><span>{{ store.state.connection.path }} / {{ store.state.connection.baudRate }}</span></article><article><strong>轮询任务</strong><span>1 个</span></article><article><strong>寄存器字典</strong><span>{{ store.state.dictionary.length }} 个</span></article><article><strong>显示配置</strong><span>Client 默认视图</span></article><article><strong>日志配置</strong><span>最多 1000 条</span></article></div></section></section></div></template>

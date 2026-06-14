<script setup lang="ts">
import { ref } from 'vue'
import { Close, Connection, DataAnalysis, Document, Files, FullScreen, Minus, Monitor, Setting } from '@element-plus/icons-vue'

const maximized = ref(false)
const navigation = [
  { path: '/client', label: 'Client', icon: Connection },
  { path: '/server', label: 'Server', icon: Monitor },
  { path: '/dictionary', label: '寄存器字典', icon: DataAnalysis },
  { path: '/logs', label: '报文日志', icon: Document },
  { path: '/project', label: '工程管理', icon: Files }
]

/**
 * @brief 最小化当前桌面窗口。
 *
 * 通过 Preload 暴露的安全接口请求主进程执行最小化，浏览器预览环境下不执行操作。
 */
async function minimizeWindow(): Promise<void> {
  await window.modbusApi?.window.minimize()
}

/**
 * @brief 切换窗口最大化和还原状态。
 *
 * 调用主进程切换窗口状态，并保存返回状态用于更新按钮提示。
 */
async function toggleMaximizeWindow(): Promise<void> {
  if (window.modbusApi) maximized.value = await window.modbusApi.window.toggleMaximize()
}

/**
 * @brief 关闭当前桌面窗口。
 *
 * 通过主进程关闭窗口，确保 Electron 按正常生命周期退出。
 */
async function closeWindow(): Promise<void> {
  await window.modbusApi?.window.close()
}
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand"><span class="brand-mark">M</span><strong>Modbus Studio</strong></div>
      <nav class="main-nav">
        <RouterLink v-for="item in navigation" :key="item.path" :to="item.path">
          <el-icon><component :is="item.icon" /></el-icon>{{ item.label }}
        </RouterLink>
      </nav>
      <div class="top-actions">
        <button class="title-button setting-button" title="设置"><el-icon><Setting /></el-icon></button>
        <button class="title-button" title="最小化" @click="minimizeWindow"><el-icon><Minus /></el-icon></button>
        <button class="title-button" :title="maximized ? '还原' : '最大化'" @click="toggleMaximizeWindow"><el-icon><FullScreen /></el-icon></button>
        <button class="title-button close-button" title="关闭" @click="closeWindow"><el-icon><Close /></el-icon></button>
      </div>
    </header>
    <main class="main-stage"><RouterView /></main>
    <footer class="statusbar">Modbus Studio v1.1.0 <span>Electron + Vue 3</span></footer>
  </div>
</template>

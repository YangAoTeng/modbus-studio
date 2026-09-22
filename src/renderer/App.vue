<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useStore } from 'vuex'
import { Close, Connection, DataAnalysis, Document, Files, FullScreen, Minus, Monitor, Setting } from '@element-plus/icons-vue'

const store = useStore()
const maximized = ref(false)
const aboutVisible = ref(false)
const navigation = [
  { path: '/client', label: '客户端（主站）', icon: Connection },
  { path: '/server', label: '服务器（从站）', icon: Monitor },
  { path: '/dictionary', label: '寄存器字典', icon: DataAnalysis },
  { path: '/logs', label: '报文日志', icon: Document },
  { path: '/project', label: '工程管理', icon: Files }
]

async function minimizeWindow(): Promise<void> { await window.modbusApi?.window.minimize() }
async function toggleMaximizeWindow(): Promise<void> { if (window.modbusApi) maximized.value = await window.modbusApi.window.toggleMaximize() }
async function closeWindow(): Promise<void> { await window.modbusApi?.window.close() }

/**
 * @brief 在应用根节点全局注册从站事件监听。
 *
 * 监听挂在 App 生命周期内，切走从站页面后从站仍继续运行且事件继续被处理。
 */
onMounted(() => {
  window.modbusApi?.server.onEvent((event) => store.dispatch('handleServerEvent', event))
})
</script>

<template>
  <div class="app-shell">
    <header class="topbar" data-tauri-drag-region>
      <div class="brand"><span class="brand-mark">M</span><strong>Modbus Studio</strong></div>
      <nav class="main-nav">
        <RouterLink v-for="item in navigation" :key="item.path" :to="item.path">
          <el-icon><component :is="item.icon" /></el-icon>{{ item.label }}
        </RouterLink>
      </nav>
      <div class="top-actions">
        <button class="title-button setting-button" title="关于作者" @click="aboutVisible = true"><el-icon><Setting /></el-icon></button>
        <button class="title-button" title="最小化" @click="minimizeWindow"><el-icon><Minus /></el-icon></button>
        <button class="title-button" :title="maximized ? '还原' : '最大化'" @click="toggleMaximizeWindow"><el-icon><FullScreen /></el-icon></button>
        <button class="title-button close-button" title="关闭" @click="closeWindow"><el-icon><Close /></el-icon></button>
      </div>
    </header>
    <main class="main-stage"><RouterView /></main>
    <footer class="statusbar">Modbus Studio v1.6.0</footer>

    <el-dialog v-model="aboutVisible" title="关于作者" width="480px" align-center>
      <div class="about-content">
        <div class="about-info">
          <div class="about-row"><label>作者</label><span>万物联动</span></div>
          <div class="about-row"><label>微信</label><span>wanliofficial</span></div>
          <div class="about-row"><label>邮件</label><span>wanliofficial@aliyun.com</span></div>
          <div class="about-row"><label>公众号</label><span>万物联动WWLD</span></div>
        </div>
        <div class="about-qrcode">
          <img src="/qrcode-mp.jpg" alt="微信公众号二维码" />
          <small>扫码关注公众号</small>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

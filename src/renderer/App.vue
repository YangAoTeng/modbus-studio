<script setup lang="ts">
import { ref } from 'vue'
import { Close, Connection, DataAnalysis, Document, Files, FullScreen, Minus, Monitor, Setting } from '@element-plus/icons-vue'

const maximized = ref(false)
const aboutVisible = ref(false)
const navigation = [
  { path: '/client', label: 'Client', icon: Connection },
  { path: '/server', label: 'Server', icon: Monitor },
  { path: '/dictionary', label: '寄存器字典', icon: DataAnalysis },
  { path: '/logs', label: '报文日志', icon: Document },
  { path: '/project', label: '工程管理', icon: Files }
]

async function minimizeWindow(): Promise<void> { await window.modbusApi?.window.minimize() }
async function toggleMaximizeWindow(): Promise<void> { if (window.modbusApi) maximized.value = await window.modbusApi.window.toggleMaximize() }
async function closeWindow(): Promise<void> { await window.modbusApi?.window.close() }
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
        <button class="title-button setting-button" title="关于作者" @click="aboutVisible = true"><el-icon><Setting /></el-icon></button>
        <button class="title-button" title="最小化" @click="minimizeWindow"><el-icon><Minus /></el-icon></button>
        <button class="title-button" :title="maximized ? '还原' : '最大化'" @click="toggleMaximizeWindow"><el-icon><FullScreen /></el-icon></button>
        <button class="title-button close-button" title="关闭" @click="closeWindow"><el-icon><Close /></el-icon></button>
      </div>
    </header>
    <main class="main-stage"><RouterView /></main>
    <footer class="statusbar">Modbus Studio v1.1.3</footer>

    <el-dialog v-model="aboutVisible" title="关于作者" width="480px" align-center>
      <div class="about-content">
        <div class="about-info">
          <div class="about-row"><label>作者</label><span>PlayerPencil</span></div>
          <div class="about-row"><label>微信</label><span>PlayerPencil</span></div>
          <div class="about-row"><label>邮件</label><span>yangaoteng1996@gmail.com</span></div>
          <div class="about-row"><label>公众号</label><span>杨工的碎碎念</span></div>
        </div>
        <div class="about-qrcode">
          <img src="/qrcode-mp.jpg" alt="微信公众号二维码" />
          <small>扫码关注公众号</small>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

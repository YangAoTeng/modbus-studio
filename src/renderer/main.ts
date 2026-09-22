import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import App from './App.vue'
import router from './router'
import store from './store'
import './styles/index.css'

// 在 Tauri 运行时挂载桌面端 API（window.modbusApi）。
// 纯 Web / Vite 预览下不挂载，保留原"仅桌面端可用"的降级提示。
import { modbusApi } from './bridge'
import type { ModbusApi } from '../shared/types'
if ('__TAURI_INTERNALS__' in window) {
  ;(window as unknown as { modbusApi: ModbusApi }).modbusApi = modbusApi
}

createApp(App).use(store).use(router).use(ElementPlus).mount('#app')

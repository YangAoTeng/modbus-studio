import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import App from './App.vue'
import router from './router'
import store from './store'
import './styles/index.css'

createApp(App).use(store).use(router).use(ElementPlus).mount('#app')

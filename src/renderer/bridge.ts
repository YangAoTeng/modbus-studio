/**
 * Tauri 桥接层：用 @tauri-apps/api 实现 ModbusApi 接口。
 *
 * 这一层替代原 Electron preload（contextBridge.exposeInMainWorld）。渲染层
 * 依旧通过 `window.modbusApi` 调用，因此 store / App.vue / 各视图均无需改动。
 * 仅窗口控制走前端 getCurrentWindow()，其余命令走 invoke；从站事件走 listen。
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type {
  ModbusApi,
  ProjectData,
  RecentProject,
  RegisterDefinition,
  ServerEvent,
  TransactionResult
} from '../shared/types'

const win = getCurrentWindow()

/** 将 Vue 响应式对象转为可结构化克隆的普通对象（等价于原 toSerializable）。 */
function toSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export const modbusApi: ModbusApi = {
  window: {
    minimize: () => win.minimize(),
    // Tauri v2 的 toggleMaximize() 返回 void；这里 await 后回读真实最大化状态，
    // 以匹配原 Electron 契约（App.vue 用返回值切换还原/最大化图标）。
    toggleMaximize: async () => {
      await win.toggleMaximize()
      return win.isMaximized()
    },
    close: () => win.close()
  },
  serial: {
    listPorts: () => invoke<string[]>('serial_list'),
    open: (config) => invoke('serial_open', { config: toSerializable(config) }),
    close: () => invoke('serial_close')
  },
  tcp: {
    connect: (config) => invoke('tcp_connect', { config: toSerializable(config) }),
    disconnect: () => invoke('tcp_disconnect')
  },
  udp: {
    connect: (config) => invoke('udp_connect', { config: toSerializable(config) }),
    disconnect: () => invoke('udp_disconnect')
  },
  client: {
    readRegisters: (params) =>
      invoke<TransactionResult>('client_read_registers', { params: toSerializable(params) }),
    writeSingleRegister: (params) =>
      invoke<TransactionResult>('client_write_single', { params: toSerializable(params) }),
    writeMultipleRegisters: (params) =>
      invoke<TransactionResult>('client_write_multiple', { params: toSerializable(params) })
  },
  server: {
    startInstance: (instance, data) =>
      invoke('server_start_instance', {
        instance: toSerializable(instance),
        data: toSerializable(data)
      }),
    stopInstance: (id) => invoke('server_stop_instance', { id }),
    updateInstanceData: (id, update) =>
      invoke('server_update_instance_data', { id, update: toSerializable(update) }),
    onEvent: (callback) => {
      const unlistenPromise = listen<ServerEvent>('server_event', (event) => callback(event.payload))
      return () => {
        void unlistenPromise.then((fn: UnlistenFn) => fn())
      }
    }
  },
  project: {
    open: () =>
      invoke<{ path: string; data: ProjectData } | null>('project_open'),
    openPath: (path) => invoke<{ path: string; data: ProjectData }>('project_open_path', { path }),
    save: (data, path, saveAs) =>
      invoke<string | null>('project_save', {
        data: toSerializable(data),
        path,
        saveAs
      }),
    listRecent: () => invoke<RecentProject[]>('project_list_recent'),
    removeRecent: (path) => invoke<RecentProject[]>('project_remove_recent', { path })
  },
  dictionary: {
    export: (items) => invoke<string | null>('dictionary_export', { items: toSerializable(items) }),
    import: () => invoke<RegisterDefinition[] | null>('dictionary_import')
  },
  log: {
    export: (items) => invoke<string | null>('log_export', { items: toSerializable(items) })
  }
}

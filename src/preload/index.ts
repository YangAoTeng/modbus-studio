import { contextBridge, ipcRenderer } from 'electron'
import type { ModbusApi } from '../shared/types'

/**
 * @brief 将 IPC 参数转换为可结构化克隆的普通对象。
 *
 * Vue 响应式 Proxy 无法直接通过 Electron IPC，本函数使用 JSON 序列化移除代理和不可克隆引用。
 * @param value 待转换的数据。
 * @returns 可安全传递给主进程的普通数据。
 */
function toSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const api: ModbusApi = {
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close')
  },
  serial: {
    listPorts: () => ipcRenderer.invoke('serial:list'),
    open: (config) => ipcRenderer.invoke('serial:open', toSerializable(config)),
    close: () => ipcRenderer.invoke('serial:close')
  },
  tcp: {
    connect: (config) => ipcRenderer.invoke('tcp:connect', toSerializable(config)),
    disconnect: () => ipcRenderer.invoke('tcp:disconnect')
  },
  client: {
    readRegisters: (params) => ipcRenderer.invoke('client:read-registers', toSerializable(params)),
    writeSingleRegister: (params) => ipcRenderer.invoke('client:write-single', toSerializable(params)),
    writeMultipleRegisters: (params) => ipcRenderer.invoke('client:write-multiple', toSerializable(params))
  },
  server: {
    start: (config, data) => ipcRenderer.invoke('server:start', toSerializable(config), toSerializable(data)),
    stop: () => ipcRenderer.invoke('server:stop'),
    updateData: (update) => ipcRenderer.invoke('server:update-data', toSerializable(update)),
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]): void => callback(payload)
      ipcRenderer.on('server:event', listener)
      return () => ipcRenderer.removeListener('server:event', listener)
    }
  },
  project: {
    open: () => ipcRenderer.invoke('project:open'),
    openPath: (path) => ipcRenderer.invoke('project:open-path', path),
    save: (data, path, saveAs) => ipcRenderer.invoke('project:save', toSerializable(data), path, saveAs),
    listRecent: () => ipcRenderer.invoke('project:list-recent'),
    removeRecent: (path) => ipcRenderer.invoke('project:remove-recent', path)
  }
}

contextBridge.exposeInMainWorld('modbusApi', api)

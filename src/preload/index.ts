import { contextBridge, ipcRenderer } from 'electron'
import type { ModbusApi } from '../shared/types'

const api: ModbusApi = {
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close')
  },
  serial: {
    listPorts: () => ipcRenderer.invoke('serial:list'),
    open: (config) => ipcRenderer.invoke('serial:open', config),
    close: () => ipcRenderer.invoke('serial:close')
  },
  tcp: {
    connect: (config) => ipcRenderer.invoke('tcp:connect', config),
    disconnect: () => ipcRenderer.invoke('tcp:disconnect')
  },
  client: {
    readRegisters: (params) => ipcRenderer.invoke('client:read-registers', params),
    writeSingleRegister: (params) => ipcRenderer.invoke('client:write-single', params),
    writeMultipleRegisters: (params) => ipcRenderer.invoke('client:write-multiple', params)
  },
  server: {
    start: (config, data) => ipcRenderer.invoke('server:start', config, data),
    stop: () => ipcRenderer.invoke('server:stop'),
    updateData: (update) => ipcRenderer.invoke('server:update-data', update),
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]): void => callback(payload)
      ipcRenderer.on('server:event', listener)
      return () => ipcRenderer.removeListener('server:event', listener)
    }
  },
  project: {
    open: () => ipcRenderer.invoke('project:open'),
    save: (data, path) => ipcRenderer.invoke('project:save', data, path)
  }
}

contextBridge.exposeInMainWorld('modbusApi', api)

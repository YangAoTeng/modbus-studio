import { app, BrowserWindow, Menu, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import type { ProjectData, ReadRegistersParams, SerialConfig, ServerConfig, ServerDataUpdate, ServerEvent, TcpConfig, WriteMultipleRegistersParams, WriteRegisterParams } from '../shared/types'
import { SerialService } from './services/SerialService'
import { ModbusClientService } from './services/ModbusClientService'
import { TcpClientService } from './services/TcpClientService'
import { ModbusServerService } from './services/ModbusServerService'

const serialService = new SerialService()
const clientService = new ModbusClientService(serialService)
const tcpClientService = new TcpClientService()
const serverService = new ModbusServerService()

/**
 * @brief 创建 Modbus Studio 主窗口。
 *
 * 开发环境加载 Vite 服务，生产环境加载打包后的静态页面，并启用上下文隔离。
 */
function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#f3f6fb',
    title: 'Modbus Studio',
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  window.setMenuBarVisibility(false)
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) void window.loadURL(devUrl)
  else void window.loadFile(join(__dirname, '../../dist/index.html'))
}

/**
 * @brief 注册渲染进程可调用的 IPC 接口。
 *
 * 集中注册串口、Modbus Client 和工程文件接口，避免渲染进程直接获得 Node.js 权限。
 */
function registerIpcHandlers(): void {
  ipcMain.handle('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
  ipcMain.handle('window:toggle-maximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return false
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return window.isMaximized()
  })
  ipcMain.handle('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())
  ipcMain.handle('serial:list', () => serialService.listPorts())
  ipcMain.handle('serial:open', (_event, config: SerialConfig) => serialService.open(config))
  ipcMain.handle('serial:close', () => serialService.close())
  ipcMain.handle('tcp:connect', (_event, config: TcpConfig) => tcpClientService.connect(config))
  ipcMain.handle('tcp:disconnect', () => tcpClientService.disconnect())
  ipcMain.handle('client:read-registers', (_event, params: ReadRegistersParams) => params.protocol === 'TCP' ? tcpClientService.readRegisters(params) : clientService.readRegisters(params))
  ipcMain.handle('client:write-single', (_event, params: WriteRegisterParams) => params.protocol === 'TCP' ? tcpClientService.writeSingleRegister(params) : clientService.writeSingleRegister(params))
  ipcMain.handle('client:write-multiple', (_event, params: WriteMultipleRegistersParams) => params.protocol === 'TCP' ? tcpClientService.writeMultipleRegisters(params) : clientService.writeMultipleRegisters(params))
  ipcMain.handle('server:start', (_event, config: ServerConfig, data: ServerDataUpdate[]) => serverService.start(config, data))
  ipcMain.handle('server:stop', () => serverService.stop())
  ipcMain.handle('server:update-data', (_event, update: ServerDataUpdate) => serverService.updateData(update))
  ipcMain.handle('project:open', async () => {
    const selected = await dialog.showOpenDialog({
      title: '打开 Modbus Studio 工程',
      filters: [{ name: 'Modbus Studio 工程', extensions: ['mbs', 'json'] }],
      properties: ['openFile']
    })
    if (selected.canceled || selected.filePaths.length === 0) return null
    const path = selected.filePaths[0]
    return { path, data: JSON.parse(await readFile(path, 'utf8')) as ProjectData }
  })
  ipcMain.handle('project:save', async (_event, data: ProjectData, currentPath?: string) => {
    let path = currentPath
    if (!path) {
      const selected = await dialog.showSaveDialog({
        title: '保存 Modbus Studio 工程',
        defaultPath: `${data.name || '未命名工程'}.mbs`,
        filters: [{ name: 'Modbus Studio 工程', extensions: ['mbs'] }]
      })
      if (selected.canceled || !selected.filePath) return null
      path = selected.filePath
    }
    await writeFile(path, JSON.stringify(data, null, 2), 'utf8')
    return path
  })
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  registerIpcHandlers()
  createWindow()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})

serverService.on('server-event', (event: ServerEvent) => {
  BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('server:event', event))
})

app.on('window-all-closed', () => {
  void serialService.close()
  void tcpClientService.disconnect()
  void serverService.stop()
  if (process.platform !== 'darwin') app.quit()
})

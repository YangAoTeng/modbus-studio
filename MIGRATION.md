# 从 Electron 迁移到 Tauri v2

> 目标：用 Tauri v2（Rust 后端 + 系统 WebView）替换 Electron，大幅降低打包与发布体积。

## 1. 架构变化

| 维度 | 原 Electron 方案 | 新 Tauri v2 方案 |
| --- | --- | --- |
| 后端运行时 | Node.js（内嵌 Chromium + Node，约 80~150 MB 随包） | Rust 二进制（复用系统 WebView，约 3~15 MB 随包） |
| 主进程 | `src/main/**`（TypeScript，依赖 `serialport` 原生模块） | `src-tauri/src/**`（Rust，依赖 `serialport` crate） |
| 前端桥接 | `src/preload/index.ts`（`contextBridge.exposeInMainWorld`） | `src/renderer/bridge.ts`（`@tauri-apps/api` 的 `invoke` / `listen` / `getCurrentWindow`） |
| 打包 | `electron-builder` → NSIS | `tauri` CLI + NSIS（`bundle.targets: ["nsis"]`） |
| IPC | `ipcMain.handle` / `ipcRenderer.invoke` | Tauri commands（`#[tauri::command]` + `invoke`），事件用 `emit` / `listen` |
| 窗口控制 | Electron `BrowserWindow` | `@tauri-apps/api/window`（`getCurrentWindow()`） |
| 文件对话框 | Electron `dialog` | `tauri-plugin-dialog`（Rust 侧 `app.dialog()`） |

**体积对比（估算，单文件安装包）**：Electron 方案通常 80~150 MB；Tauri 方案 Windows NSIS 通常
3~15 MB（仅内嵌 Rust 二进制 + 资源，WebView2 在 Win10/11 已系统内置，不计入安装包）。

## 2. 文件变更清单

### 删除
- `src/main/**` —— Electron 主进程（已被 Rust 后端替代）
- `src/preload/index.ts` —— Electron preload
- `tsconfig.electron.json` —— 仅用于编译 `src/main`
- `package-lock.json` —— 已失效，需 `npm install` 重新生成

### 新增（`src-tauri/`）
- `Cargo.toml` / `build.rs` / `src/main.rs` / `src/lib.rs`
- `tauri.conf.json` —— Tauri 配置（窗口、打包、图标）
- `capabilities/default.json` —— 权限能力
- `permissions/modbus-studio.toml` —— 自定义命令权限集
- `icons/icon.ico` —— 由 `public/icon.ico` 复制而来（其余平台图标请用 `npm run tauri icon` 生成）
- `src/protocol/` —— CRC16 / RTU 帧 / TCP 帧 / Server PDU（逻辑等价于原 TS）
- `src/services/` —— 串口 / TCP / UDP 客户端、RTU 主站事务、从站服务
- `src/state.rs` / `src/types.rs` / `src/commands.rs`

### 修改
- `src/renderer/bridge.ts` —— 新增，用 `@tauri-apps/api` 实现 `ModbusApi` 接口
- `src/renderer/main.ts` —— 仅在 Tauri 运行时挂载 `window.modbusApi`
- `src/renderer/App.vue` —— 标题栏加 `data-tauri-drag-region`（可拖拽）
- `package.json` —— 移除 `electron` / `electron-builder` / `serialport` / `concurrently` / `wait-on` / `cross-env`，
  加入 `@tauri-apps/api` / `@tauri-apps/cli`；脚本改为 `dev` / `build` / `tauri`
- `vite.config.ts` —— 无需改动（`base: './'`、`outDir: 'dist'` 已满足 Tauri）
- `src/shared/types.ts` —— 保留，前后端数据契约

> 渲染层其余代码（`store` / 各视图 / `env.d.ts`）**零改动**，因为仍通过 `window.modbusApi` 调用。

## 3. 构建前置条件

Tauri v2 需要本机具备：

1. **Rust 工具链**：`rustup` ≥ 1.77.2（`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`）。
2. **系统 WebView 依赖**：
   - Windows：WebView2（Win10/11 已内置；Win7/8 需手动安装）。
   - Linux：`webkit2gtk-4.1` + `libsoup-3` + `libjavascriptcoregtk` 等（见 Tauri 官方文档的 Linux 依赖列表）。
   - macOS：系统自带 WKWebView，需 Xcode Command Line Tools。
3. **Node 依赖**：`npm install`（会重新生成 `package-lock.json` 并安装 `@tauri-apps/api` / `@tauri-apps/cli`）。

## 4. 构建与运行

```bash
npm install                 # 安装前端依赖（含 @tauri-apps/api、@tauri-apps/cli）
npm run tauri dev           # 开发模式：自动起 vite + 打开 Rust 桌面窗口
npm run tauri build         # 生产构建：输出 release/ 下的 NSIS 安装包
```

Windows 安装包默认输出到 `src-tauri/target/release/bundle/nsis/`。

## 5. 权限（ACL）说明

自定义命令在 `permissions/modbus-studio.toml` 中定义为权限集 `allow-app-commands`，
并在 `capabilities/default.json` 引用。窗口控制相关权限（`allow-minimize` / `allow-close` /
`allow-toggle-maximize` / `allow-start-dragging`）与 `dialog:default`、`core:event:default` 一并授予。

> 若你使用的 Tauri 小版本对某个权限标识符命名不同，`tauri build` 会在编译期明确报错并指出未知权限，
> 直接删除对应行即可（不影响其余功能）。

## 6. 未验证项 / 风险点

本迁移在 **无 Rust 工具链的沙箱** 中完成，Rust 后端尚未经过 `cargo build` 编译验证。已知需要上机后确认的点：

1. **编译**：首次 `cargo build` 可能因个别 crate API 版本差异（如 `serialport`、`tauri-plugin-dialog` 的
   `FilePath` / `blocking_*_file` 形态、`tauri::State` 生命周期写法）产生少量适配性报错，按编译器提示修正即可。
2. **图标**：当前仅提供 `icons/icon.ico`。若需打 macOS / Linux 包，请先执行 `npm run tauri icon public/icon.ico`
   生成完整图标集，否则 `tauri build` 会报缺图。
3. **GBK 解码**：CSV 导入的文本解码用 `encoding_rs` 的 GBK 兜底（比原 TS 的 latin1 兜底更能正确还原中文），
   已在注释中说明。
4. **拖拽区**：`data-tauri-drag-region` 依赖 `core:window:allow-start-dragging`，若该权限在所用 Tauri 版本不存在，
   标题栏拖拽失效（窗口按钮仍可用），移除该权限行并改用 `getCurrentWindow().startDragging()` 亦可。

## 7. 验证清单（上机后建议逐项确认）

- [ ] `npm run tauri dev` 能启动窗口，界面与原 Electron 版本一致
- [ ] 串口列表 / 打开 / RTU 主站读写正常
- [ ] TCP / UDP 主站读写正常
- [ ] 从站（TCP / UDP / RTU）启动、数据写入、报文日志事件推送正常
- [ ] 工程管理：打开 / 保存 / 最近工程
- [ ] 字典导入（CSV / JSON）/ 导出，日志导出
- [ ] 窗口最小化 / 最大化 / 关闭 / 拖拽正常
- [ ] `npm run tauri build` 产出 NSIS 安装包，体积较原 Electron 包显著下降

## 8. 回退方案

Rust 后端与原 Electron 主进程逻辑等价；若需回退到 Electron，可从 Git 历史恢复 `src/main/**`、
`src/preload/index.ts`、`tsconfig.electron.json` 及 `package.json` 的旧配置（本次未提交，可 `git diff` 对照）。

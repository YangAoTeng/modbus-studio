# Modbus Studio

基于 Electron、Vue 3、Vuex、TypeScript 和 Element Plus 开发的 Modbus 调试工具。

## 当前功能

- Modbus RTU 串口扫描、连接和断开
- Modbus TCP Client 连接和断开
- 03 读取保持寄存器
- 04 读取输入寄存器
- 06 写单个保持寄存器
- 16 写多个保持寄存器
- 自动轮询和响应时间统计
- CRC16 生成及响应校验
- UINT16、INT16、UINT32、INT32、FLOAT 和二进制显示
- TX/RX 报文日志，最多保留 1000 条
- 寄存器字典管理
- MBS 工程文件打开和保存
- Client、Server、寄存器字典、报文日志、工程管理五个视图
- Modbus TCP Server，支持 01/02/03/04/05/06/15/16 功能码
- Modbus RTU Server，支持 01/02/03/04/05/06/15/16 功能码
- Server 四区数据编辑、外部写入同步、请求计数和报文日志
- TCP Client 和 Server 配置随工程文件保存

## V1.1 状态

V1.1 已实现 Modbus TCP Client、Modbus TCP Server 和 Modbus RTU Server。TCP 功能已通过本机回环测试；RTU Server 需要连接实际串口设备进行硬件联调。

后续版本计划包含 CSV 导入导出、Server 数据文件导入、日志导出、异常响应模拟、延迟和丢包模拟、趋势曲线以及自动化测试脚本。

## 开发环境

```powershell
npm install
npm run dev
```

## 类型检查

```powershell
npx vue-tsc --noEmit
npx tsc -p tsconfig.electron.json --noEmit
```

## 生产构建

```powershell
npm run build
```

## Windows 打包

```powershell
npm run dist
```

## 工程结构

```text
src/main       Electron 主进程、串口服务和 Modbus 协议
src/preload    安全 API 桥接
src/renderer   Vue 页面、组件、Vuex 和样式
src/shared     主进程与渲染进程共用类型
```

## 使用说明

1. 在 Client 页面选择串口参数并连接。
2. 设置从机地址、功能码、起始地址和数量。
3. 点击“读取”执行单次读取，或点击“开始轮询”进行周期读取。
4. 点击“写入”，输入一个值时使用 06 功能码，输入多个逗号分隔值时使用 16 功能码。
5. 在报文日志页面查看原始报文、解析结果、CRC 状态和耗时。
6. 在工程管理页面保存连接参数、轮询配置和寄存器字典。

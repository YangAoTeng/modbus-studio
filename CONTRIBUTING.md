# 贡献指南

感谢你愿意参与 Modbus Studio 的改进。

## 开发环境

```powershell
npm install
npm run dev
```

## 提交前检查

提交 Pull Request 前请至少执行：

```powershell
npm run build
```

如果修改了类型、主进程或协议代码，建议额外执行：

```powershell
npx vue-tsc --noEmit
npx tsc -p tsconfig.electron.json --noEmit
```

## Issue 建议

提交问题时建议包含：

- 软件版本。
- 操作系统版本。
- 使用的是 Modbus RTU 还是 Modbus TCP。
- 复现步骤。
- 期望结果和实际结果。
- 相关报文日志或截图。

## Pull Request 建议

- 保持改动聚焦，一次 PR 解决一个主要问题。
- 涉及界面行为时，请附上截图或简短说明。
- 涉及 Modbus 协议行为时，请说明功能码、地址范围和测试方式。
- 不要提交 `dist/`、`dist-electron/`、`release/`、安装包和本地工程文件。

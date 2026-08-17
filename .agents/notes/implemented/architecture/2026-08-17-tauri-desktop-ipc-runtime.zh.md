# Agent Note: Tauri 桌面端运行时与 IPC 传输

Status: implemented

[English](2026-08-17-tauri-desktop-ipc-runtime.md) | 中文

## 问题

桌面端需要复用现有 React 界面和 TypeScript Harness runtime，同时不能暴露本地 HTTP 监听器，也不能在 Rust 中重复实现 Agent 与 Session 逻辑。

## 决策

Tauri 负责原生窗口和进程生命周期，Node sidecar 负责组装后的 Harness runtime。sidecar 通过 stdio 提供换行分隔的 JSON-RPC bridge；Tauri 转发 runtime 初始化、API 调用、取消、流、client boot manifest 和 client bundle。桌面 profile 保留现有插件需要的 Web 路由注册服务，但关闭 TCP 监听。平台 sidecar 使用现有 pkg/SEA 流程从 CLI 部署闭包构建，并通过 Tauri `externalBin` 注入。

## 曾考虑的替代方案

**在 Rust 中重写 runtime 服务。** 否决，因为这会重复 Agent、Session、工具、持久化和 provider 行为，形成第二套产品 runtime。

**在桌面进程中暴露现有 Web HTTP server。** 否决，因为桌面端正式通道要求使用 IPC，本地端口还会增加生命周期、信任和资源路径复杂度。

**维护独立的桌面 React 应用。** 否决，因为这会拆分 UI 行为并产生并行功能开发；现有 `AppWebEntry` 和 client module graph 已经提供可复用的界面。

## 后果

桌面端和 Web 端共享同一套 client modules 与 API contract。Rust 保持传输和生命周期层，不解释业务 endpoint。sidecar 可执行文件和安装包必须在原生 macOS、Windows runner 上构建，因为它们具有平台相关性。生成的 sidecar 属于构建产物，不提交到仓库。

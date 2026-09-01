# DeepSeek Harness Desktop

基于 Tauri 2、React、TypeScript、Tailwind CSS v4 和 shadcn/ui 的 DeepSeek Harness 桌面端。

## 开发

要求 Node 24。开发环境下可以使用系统 Node 24，Tauri 会优先寻找打包后的运行时，找不到时回退到 `PATH` 中的 `node`。

```bash
pnpm install
pnpm dev
pnpm tauri:dev
```

## 桌面运行时

`pnpm stage:runtime` 会将固定版本的 `@deepseek-ai/dsh` 生产依赖、pnpm 和当前 Node 24 复制到 `src-tauri/runtime`。该目录是构建产物，不提交到仓库。

正式构建使用 `pnpm tauri:build`，会依次执行 runtime staging、布局校验、真实 `dsh web` 启动冒烟，再生成安装包。缺少 Node 二进制或 Harness 无法监听 loopback 时会直接失败。跨平台构建可以通过 `DSH_NODE_BINARY` 指向目标平台的 Node 24 二进制后执行 staging。

CI 在 macOS Intel、macOS ARM64 和 Windows x64 上执行同一套检查，并上传 DMG、NSIS/MSI 安装包。内置 runtime 不提交到仓库，只在目标平台构建时生成。

插件中心只允许安装项目内置清单中的固定版本，并通过 `dsh plugin --profile web` 执行安装、卸载和更新。插件是可执行代码，安装前请审阅来源、权限和许可证。

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

`pnpm stage:runtime` 会使用 `runtime/pnpm-lock.yaml` 的锁定结果，通过独立 runtime 包的 `pnpm deploy --prod --legacy` 生成固定版本的 `@deepseek-ai/dsh` 生产依赖，再复制 pnpm 和当前 Node 24 到 `src-tauri/runtime`。`runtime/package.json` 与桌面端 `package.json` 中的 dsh 版本必须保持一致；`src-tauri/runtime` 是构建产物，不提交到仓库。

正式构建使用 `pnpm tauri:build`，会依次执行 runtime staging、布局校验、真实 `dsh web` 启动冒烟，再生成安装包。缺少 Node 二进制或 Harness 无法监听 loopback 时会直接失败。跨平台构建可以通过 `DSH_NODE_BINARY` 指向目标平台的 Node 24 二进制后执行 staging。

CI 在 macOS Intel、macOS ARM64 和 Windows x64 上执行同一套检查，并上传 DMG、NSIS/MSI 安装包。内置 runtime 不提交到仓库，只在目标平台构建时生成。推送 `v*` 标签或手动运行 `Release desktop packages` 时，会复用同一套三平台构建并发布 GitHub Release。

当前发布包按无代码签名配置构建：Tauri 使用 `--no-sign`，macOS 的 `signingIdentity` 和 Windows 的 `certificateThumbprint` 均为空。用户首次打开 macOS 应用时可能需要在“系统设置 → 隐私与安全性”中手动允许；Windows 可能显示未知发布者提示。后续接入证书、公证或可信发布者时，再移除无签名配置并补充对应的 CI Secrets。

Node 24 不需要在本项目中从源码编译。GitHub Actions 使用对应平台的 Node 24.20.0 runner，并将该平台的官方 Node 二进制复制进安装包；因此 macOS Intel、macOS ARM64 和 Windows x64 必须分别在匹配平台上构建。

## Core 构建工作流

.github/workflows/core-release.yml 从 runtime 目录构建独立的 DeepSeek Harness Core 包，并为 Windows x64、macOS ARM64、macOS x64 和 Linux x64 分别生成压缩包。工作流会按输入版本固定 @deepseek-ai/dsh，使用 Node 24 和 pnpm 11.7.0 安装依赖，应用 Web 启动安全补丁后发布 GitHub Release。

该工作流与桌面端安装包工作流相互独立。发布新的 Core 版本后，需要将 Release 资产地址和版本信息加入 src-tauri/resources/core-catalog.json，桌面端的版本选择、升级和回滚功能才会展示该版本。

## Harness 核心版本

桌面端默认使用安装包内置的 dsh 核心，也可以在“核心版本”页面下载清单中的固定版本。每个下载包都会校验清单中的 SHA-256，并安装到应用数据目录的独立版本槽位，不会覆盖内置 runtime：

- 选择“下载”只准备版本，不改变当前服务。
- 选择“切换”会停止当前 Harness，并使用选定核心重新启动；如果重启失败，会尝试恢复原核心。
- “升级到最新”会安装并切换到清单中的最新版本；已安装的旧版本可以作为回滚目标。
- 非当前版本可以删除，内置核心不能删除。

版本状态保存在应用数据目录的 active-core.json，核心文件保存在 dependencies/dsh-<version>。插件仍共享 dsh/profiles/web，所以回滚核心不会自动回滚插件；切换旧核心前需要确认插件兼容性。当前版本清单随应用发布，离线可以浏览已发布清单，但下载和升级需要网络。

插件中心只允许安装项目内置清单中的固定版本，并通过 `dsh plugin --profile web` 执行安装、卸载和更新。插件是可执行代码，安装前请审阅来源、权限和许可证。

# 审核报告：Synapse 阶段性 Review

**审核时间**: 2026-03-24  
**审核范围**: `src/`、`electron/`、`package.json`、`eslint.config.js`  
**整体评价**: 当前项目仍处于明显的原型阶段，UI 骨架已成型，但存在 3 个会直接阻断构建/打包/平台能力接入的高优先级问题，另有若干质量门禁和类型一致性问题需要尽快收敛。

## 🔴 严重问题（必须修复）

### 问题 1：主题模式枚举不一致，导致前端构建直接失败
- **位置**：`src/components/settings/SettingsPanel.tsx:47`，`src/store/slices/theme.ts:3`
- **描述**：
  `SettingsPanel` 将下拉框值强转为 `'dark' | 'light' | 'system'`，但 `theme` slice 中 `ThemeMode` 实际定义为 `'dark' | 'light' | 'custom'`。当前 `npm run build` 已可稳定复现 `TS2345`，因此所有依赖前端构建的流程都会被阻断。
- **复现依据**：
  `npx tsc -p tsconfig.app.json --noEmit --pretty false`
- **修复建议**：
  统一主题模式枚举。若产品设计是“跟随系统”，应把 `ThemeMode` 改为 `'dark' | 'light' | 'system'`，并补齐系统主题解析逻辑；若产品设计是“自定义”，则应把设置面板选项改为 `custom`，同时提供对应 UI 和样式分支。

### 问题 2：Electron 生产环境加载路径错误，打包后主窗口无法加载前端页面
- **位置**：`electron/main.ts:29`，`package.json:7`，`package.json:24-26`
- **描述**：
  Electron 主进程入口位于 `dist-electron/electron/main.js`，此时 `__dirname` 会落在 `dist-electron/electron`。代码却使用 `../dist/index.html`，最终会解析到 `dist-electron/dist/index.html`，而构建产物实际输出到根目录的 `dist/index.html`。这意味着即使前端构建成功，打包后的桌面端也会因为找不到页面而白屏/启动失败。
- **复现依据**：
  `../dist/index.html` 解析结果为 `dist-electron/dist/index.html`；正确路径应为 `../../dist/index.html`。
- **修复建议**：
  将生产环境加载路径改为 `path.join(__dirname, '../../dist/index.html')`，并补一条最小化的打包验收用例，至少验证 `BrowserWindow.loadFile` 指向的文件真实存在。

### 问题 3：Preload 暴露了大量 IPC API，但主进程没有对应 handler，Electron 能力层实际不可用
- **位置**：`electron/preload.ts:17-49`，`electron/main.ts:53-72`
- **描述**：
  预加载脚本向渲染层暴露了 `file`、`mcp`、`terminal`、`config` 等 API，但主进程当前只实现了窗口控制和 `platform:info`。一旦 Electron 模式下调用 `window.synapse.file.read/list`、`window.synapse.mcp.*` 或 `window.synapse.config.*`，都会触发 `ipcRenderer.invoke(...)` 对不存在 channel 的调用，运行时直接报错。
- **修复建议**：
  两种方案二选一：
  1. 立即补齐 `ipcMain.handle(...)` 实现，至少让 `preload` 中已经公开的 API 具备最小可用能力。
  2. 在功能尚未实现前，收缩 `preload` 暴露面，只保留已经有主进程 handler 的接口，避免前端误判这些能力可用。

## 🟡 建议改进

### 问题 4：Agent 工具循环缺失“assistant tool_calls”落盘，工具调用协议不完整
- **位置**：`src/services/agentLoop.ts:106-127`，`src/services/agentLoop.ts:129-158`
- **描述**：
  当前只有 `fullContent` 非空时才会把 assistant 消息写回 `messages`。但主流 OpenAI 兼容接口在触发工具调用时，常见返回是“仅有 `tool_calls`，无自然语言内容”。这种情况下，当前实现会直接追加 `role: 'tool'` 消息，缺失前置的 assistant/tool_calls 消息，下一轮请求会变成非法消息序列，导致工具链路在真实模型下不稳定甚至直接失败。
- **修复建议**：
  只要存在 `pendingToolCalls`，就必须先写入一条 `role: 'assistant'` 的消息，并带上 `tool_calls`；`content` 可以为空字符串。随后再按 `tool_call_id` 追加 tool 响应。

### 问题 5：Lint 脚本当前不可作为质量门禁使用
- **位置**：`package.json:11`，`eslint.config.js:9`
- **描述**：
  `npm run lint` 在当前仓库会直接 OOM 退出，无法作为稳定的提交前检查；改为 `npx eslint src electron --ext .ts,.tsx` 后虽然能执行，但仍一次性暴露出 43 个错误，说明当前 lint 入口和规则收敛都没有完成。
- **复现依据**：
  `npm run lint` 触发 `Fatal process out of memory`；`npx eslint src electron --ext .ts,.tsx` 返回 43 个 error。
- **修复建议**：
  将脚本改为显式限定源码目录，例如 `eslint src electron --ext .ts,.tsx`，同时把 `dist-electron/`、测试素材目录等无关路径加入 ignore；之后再分批修复 `no-explicit-any`、`react-hooks/*`、`react-refresh/*` 等错误，让 lint 真正成为可执行门禁。

### 问题 6：Windows 打包配置引用了不存在的图标文件
- **位置**：`package.json:30`
- **描述**：
  `electron-builder` 配置的图标为 `public/icon.png`，但仓库内 `public/` 当前只有 `favicon.svg` 和 `icons.svg`。即便前端构建问题修复，后续 Windows 打包仍有较大概率在资源阶段失败，或者退回默认图标。
- **修复建议**：
  补充真实存在的 `public/icon.png`，或把 `build.win.icon` 改为现有资源并验证 `electron-builder` 是否接受该格式。

## 🟢 微调建议

### 问题 7：类型定义与 UI 分支存在漂移，后续会放大维护成本
- **位置**：`src/store/slices/editorTabs.ts:9`，`src/components/layout/EditorArea.tsx:37`，`src/components/layout/TabBar.tsx:15-17`
- **描述**：
  `EditorTab['type']` 未声明 `showcase` / `settings`，但 UI 分支和图标映射已经在处理这些值，只是靠字符串比较绕过了类型系统。这会让后续新增 tab 类型时，编译器无法真正发挥约束作用。
- **修复建议**：
  统一 `EditorTab['type']` 联合类型和消费端分支，避免继续用字符串字面量“偷跑”。

## ✅ 做得好的地方

- `src/platform/index.ts` 把 Web Mock 和 Electron 桥接抽成了统一适配层，方向是对的，后续可以在这里收口平台能力。
- `src/services/aiClient.ts` 的流式解析已经考虑了重试、Abort 和 tool call 累积，说明核心交互模型有明确演进方向。
- 布局层已经做了 `ActivityBar + Sidebar + Editor + Agent + BottomPanel` 的分区，后续功能填充的结构成本较低。

## 附：本次检查执行过的命令

```powershell
npx tsc -p tsconfig.app.json --noEmit --pretty false
npx tsc -p tsconfig.electron.json --noEmit --pretty false
npx eslint src electron --ext .ts,.tsx
npm run build
npm run lint
```

# 审核报告：Synapse 前端架构第二轮独立 Review

**审核时间**: 2026-03-24 00:20:37 +08:00
**审核范围**: `src/**`、`electron/**`、构建与 lint 配置
**整体评价**: IDE 外壳和模块分层雏形已经具备，但当前仍存在构建阻断、Electron IPC 契约失配、敏感信息边界错误等根问题，尚不适合继续在现有前端架构上直接叠加真实 AI 与工作区能力。

## 🔴 严重问题（必须修复）

### 问题 1：主题状态模型不一致，当前代码无法通过生产构建
- **位置**：`src/components/settings/SettingsPanel.tsx:47`、`src/components/settings/SettingsPanel.tsx:50`、`src/store/slices/theme.ts:3`、`src/store/slices/theme.ts:33`
- **描述**：
  `SettingsPanel` 允许用户选择 `system`，但 `ThemeMode` 只接受 `dark | light | custom`。这不是潜在风险，而是已被验证的构建阻断问题：`npm run build` 直接在这里失败。
- **修复建议**：
  统一主题模型，只保留一套枚举定义。
  如果产品确实支持“跟随系统”，则把 `ThemeMode` 改为 `dark | light | system`，并补一个解析系统主题的适配层。
  如果暂不支持，就删除 UI 中的 `system` 选项，避免前端状态与领域模型继续漂移。

### 问题 2：Electron 预加载层暴露了完整能力面，但主进程几乎没有对应实现，运行期会直接断裂
- **位置**：`electron/preload.ts:18`、`electron/preload.ts:27`、`electron/preload.ts:36`、`electron/preload.ts:44`、`electron/main.ts:56`、`electron/main.ts:67`、`src/services/fileSystem.ts:67`、`src/services/fileSystem.ts:76`
- **描述**：
  `preload.ts` 已向渲染层暴露 `file` / `mcp` / `terminal` / `config` 四类 IPC 能力，但 `main.ts` 目前只有窗口控制和 `platform:info`。渲染层一旦进入 Electron 分支，就会调用 `window.synapse.file.list/read`，这些通道在主进程并不存在，文件树、真实工作区、配置读取等核心路径都会在运行时失败。
- **修复建议**：
  建立共享的 IPC 协议定义文件，统一声明 channel、请求参数、返回类型和可用性。
  在主进程补齐真实 handler 之前，不要在 preload 中暴露“已实现”接口；改为 capability discovery 或显式返回 `not implemented`。
  `fileSystem` 服务不要直接假设 Electron 能力完整可用，应先检查 capability，再决定走真实实现还是降级逻辑。

### 问题 3：API Key 与模型调用都留在渲染进程，安全边界设计错误
- **位置**：`src/components/settings/SettingsPanel.tsx:67`、`src/components/settings/SettingsPanel.tsx:73`、`src/store/slices/settings.ts:39`、`src/store/slices/settings.ts:42`、`src/platform/index.ts:106`、`src/platform/index.ts:112`、`src/platform/index.ts:113`、`src/services/aiClient.ts:60`、`electron/main.ts:21`
- **描述**：
  当前 API Key 通过 Redux 直接进入渲染层状态；Web fallback 还会把配置和 API Key 明文写入 `localStorage`。与此同时，`AIClient` 在渲染进程直接发起模型请求，等于把密钥、请求上下文和供应商协议全部暴露给前端。更糟的是 Electron 主窗口显式关闭了 `sandbox`。这套组合对桌面端 AI IDE 来说是不合格的安全边界。
- **修复建议**：
  API Key 只保留在主进程或独立后端，渲染层只拿到“是否已配置”和“触发请求”的最小接口。
  模型请求、工具调用和提供商适配统一下沉到主进程服务层，preload 只暴露白名单命令。
  Web 模式如果必须落地配置，也至少将普通配置与敏感凭证分开存储；凭证不要继续走 `localStorage`。
  优先恢复 Electron `sandbox`，只有在明确被原生依赖阻塞时才例外处理。

## 🟡 建议改进

### 问题 4：对话域已经出现“双轨实现”，UI 与真实服务层完全脱节
- **位置**：`src/components/layout/AgentPanel.tsx:31`、`src/components/layout/AgentPanel.tsx:40`、`src/services/agentLoop.ts:32`、`src/services/agentLoop.ts:52`、`src/services/aiClient.ts:43`、`src/services/aiClient.ts:60`
- **描述**：
  `AgentPanel` 仍然靠 `setTimeout` 注入 demo 回复，而仓库里已经存在 `AgentLoop`、`AIClient`、流式状态更新逻辑。按全仓搜索，当前渲染层没有接入这套真实服务。这会导致消息状态、工具调用、标题生成、历史记录和后续 streaming UI 分别在两套模型里演进，后面接真能力时返工成本会很高。
- **修复建议**：
  收敛为单一“会话控制器”入口，可以是 thunk、service facade 或专用 hook。
  `AgentPanel` 只负责输入与展示，不再直接决定消息写入策略。
  `conversation`、`conversationHistory`、`agentLoop`、`toolRegistry` 之间补齐明确的数据流。

### 问题 5：工作区、布局和主题设置里存在大量“写了但不生效”的死状态
- **位置**：`src/components/layout/Sidebar.tsx:21`、`src/components/layout/Sidebar.tsx:23`、`src/components/layout/Sidebar.tsx:31`、`src/services/fileSystem.ts:23`、`src/services/fileSystem.ts:81`、`src/store/slices/layout.ts:5`、`src/store/slices/layout.ts:12`、`src/components/layout/AppLayout.tsx:105`、`src/components/layout/AppLayout.tsx:111`、`src/index.css:7`、`src/index.css:9`、`src/index.css:12`、`src/store/slices/settings.ts:33`、`src/store/slices/theme.ts:40`
- **描述**：
  侧边栏始终加载 `DEMO_FILE_TREE` 并自动打开“示例工作区”；`layoutSlice` 里有 `bottomPanelVisible` / `agentPanelVisible` / `isFullscreenAgent`，但 `AppLayout` 始终固定渲染对应面板；`fontSize`、`accentColor` 虽然能改 Redux，但没有任何地方把它们同步到 CSS 变量或 DOM。表面上看有很多可配置能力，实际上大部分都是死状态。
- **修复建议**：
  把“产品占位状态”和“真实运行状态”拆开，不要在同一 store 里混用。
  为主题和编辑器设置增加 side-effect 层，把 store 变化映射到 CSS 变量、`documentElement` 或组件 props。
  工作区树应从 `workspace.currentPath` 派生，不要让 `Sidebar` 自行写入 demo 工作区。

### 问题 6：质量闸门尚未形成，当前 lint 结果已经暴露出 React 生命周期误用
- **位置**：`src/components/ui/CommandPalette.tsx:31`、`src/hooks/useShortcuts.ts:18`
- **描述**：
  `npm run lint` 当前返回 43 个错误，其中不仅有大量 `any`，还包括 `CommandPalette` 在 effect 中同步 `setState`、`useShortcuts` 在 render 阶段写 ref。说明代码库虽然开了严格 TS，但质量约束并没有真正成为交付门槛。
- **修复建议**：
  把 `build` 与 `lint` 接入提交前或 CI 检查，至少保证主分支随时可构建。
  先修复 React hooks 误用，再逐步收敛跨层 `any`，否则后续加功能只会放大噪音。

## 🟢 微调建议

### 问题 7：项目文档仍停留在 Vite 模板，架构意图没有被记录
- **位置**：`README.md`
- **描述**：
  当前 README 还是模板内容，和真实项目边界、模块职责、Electron 安全模型完全不一致。对多人协作或后续 AI Agent 接入都不友好。
- **修复建议**：
  至少补三部分：前端模块图、IPC 协议边界、渲染层/主进程职责说明。

## ✅ 做得好的地方

- `Redux Toolkit` slice 已经按领域拆分，后续收敛数据流时有基础可用。
- Electron 至少保留了 `contextIsolation: true` 与 `nodeIntegration: false`，说明安全方向没有完全跑偏。
- `AppLayout`、`ErrorBoundary`、编辑器/侧栏/Agent 三栏结构已经把外壳搭起来，适合作为后续真实能力接入的宿主。

## 验证记录

- `npm run build`：失败，错误点位于 `src/components/settings/SettingsPanel.tsx(47,79)`，原因为 `system` 不属于 `ThemeMode`。
- `npm run lint`：失败，共 43 个错误；其中包含 `CommandPalette` 与 `useShortcuts` 的 React hooks 误用，以及大量跨层 `any`。

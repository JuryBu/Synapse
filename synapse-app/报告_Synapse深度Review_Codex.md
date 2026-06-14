# 审核报告：Synapse 深度 Review

**审核时间**: 2026-03-24  
**审核范围**: `src/**`、`electron/**`、`package.json`、构建与运行链路  
**整体评价**: 当前仓库已经有可见的 UI 外壳，但核心“学习工作区 + AI Agent + Electron 能力”三条主链路都还没有真正闭环；继续叠加功能前，建议先把桌面端交付、工作区真实读写、会话持久化和工具调用协议这四个底座修稳。

## 🔴 严重问题（必须修复）

### 问题 1：工作区到编辑器的主路径没有打通，用户实际上无法打开任何真实文件
- **位置**：`src/components/layout/Sidebar.tsx:21-41`、`src/components/ui/QuickOpen.tsx:20-27`、`src/components/layout/AppLayout.tsx:121`、`src/services/fileSystem.ts:125-126`、`src/store/slices/editorTabs.ts:33-40`
- **描述**：
  文件树初始化和 Quick Open 都依赖 `fileSystem.getWorkspaceTree()`，但该方法始终返回 `DEMO_FILE_TREE`，完全忽略当前工作区和 Electron 真文件系统。更严重的是，点击文件和 Quick Open 选择文件都只是 `console.log`，而 `openTab` action 在全仓没有任何调用，因此编辑区永远不会打开真实文件。
- **影响**：
  这会直接破坏项目最核心的“打开课件/笔记并围绕它学习”的主流程。即使后端和 AI 能力继续完善，用户依然只能停留在 Demo 壳层。
- **修复建议**：
  统一以 `workspace.currentPath` 为真实数据源。
  `getWorkspaceTree()` 在 Electron 模式下改为递归调用真实文件 API，Web 模式再走 demo。
  `Sidebar` 与 `QuickOpen` 统一 dispatch `openTab(...)`，并补上按扩展名推导 tab 类型的入口层。

### 问题 2：Electron 桌面端交付链路仍未验通，打包后高概率白屏或资源缺失
- **位置**：`electron/main.ts:17-29`、`package.json:10-15`、`package.json:28-31`
- **描述**：
  生产环境窗口加载使用 `path.join(__dirname, '../dist/index.html')`。在编译后主进程位于 `dist-electron/electron/main.js`，该路径会解析到 `dist-electron/dist/index.html`，而实际前端产物在根目录 `dist/index.html`。另外，Windows 打包配置声明了 `public/icon.png`，仓库里该文件并不存在。
- **复现依据**：
  `node -e "const path=require('path'); console.log(path.join('dist-electron/electron','../dist/index.html')); console.log(path.join('dist-electron/electron','../../dist/index.html'))"`  
  实际输出分别为 `dist-electron\\dist\\index.html` 与 `dist\\index.html`。
- **影响**：
  桌面端构建即使通过，最终安装包仍可能在启动时白屏，或在打包阶段因缺失图标资源失败。
- **修复建议**：
  把生产路径改为 `path.join(__dirname, '../../dist/index.html')`。
  给 `electron:pack` 增加最小验收，至少校验目标 HTML 和图标文件存在。
  补齐 `public/icon.png` 或改为仓库内真实存在且被 `electron-builder` 支持的资源。

### 问题 3：桥接协议已经自相矛盾，MCP/IPC 能力层既编译不过，也无法运行
- **位置**：`src/services/mcpManager.ts:53-99`、`src/platform/index.ts:31-36`、`electron/preload.ts:27-32`、`electron/main.ts:55-72`
- **描述**：
  `mcpManager` 调用了 `window.synapse.mcp.start(name)` 和 `window.synapse.mcp.stop(name)`，但 `SynapseAPI` 和 `preload` 里根本没有这两个方法，`npx tsc -p tsconfig.app.json --noEmit --pretty false` 已经直接报错。与此同时，`preload` 又暴露了 `file`、`mcp`、`terminal`、`config` 大量 invoke API，但主进程只注册了窗口控制和 `platform:info`，其余通道全部没有 handler。
- **影响**：
  这不是“功能尚未实现”的程度，而是协议定义已经互相打架。结果是：应用级 TypeScript 检查失败，Electron 环境下一旦触发这些能力还会直接在运行时断裂。
- **修复建议**：
  建立单一的 IPC 协议定义源，统一声明 channel、入参、返回值和 capability。
  在主进程补齐 handler 之前，收缩 preload 暴露面，不要对渲染层假装这些能力已经可用。
  `mcpManager` 先改为只调用已存在的方法，或显式走 `restart/callTool/getStatus` 的能力模型。

### 问题 4：API Key、安全边界和模型调用位置设计错误，桌面端无法满足最基本的密钥隔离要求
- **位置**：`src/components/settings/SettingsPanel.tsx:158-168`、`src/store/slices/settings.ts:9-10`、`src/store/slices/settings.ts:39-43`、`src/platform/index.ts:104-113`、`src/services/aiClient.ts:80-85`、`electron/main.ts:17-22`
- **描述**：
  API Key 直接进入 Redux 状态；Web fallback 还会落到 `localStorage`；模型请求由渲染进程直接携带密钥发出；Electron 主窗口同时把 `sandbox` 关掉。这意味着任何渲染层 XSS、第三方脚本注入或调试台访问都能直接读取密钥和完整请求上下文。
- **影响**：
  对桌面端 AI 应用来说，这属于安全边界画错了。后续一旦接入真实工作区、执行命令或同步笔记，泄漏面会继续扩大。
- **修复建议**：
  API Key 只存主进程或独立本地服务，渲染层只拿到“是否已配置”和“发起请求”的最小接口。
  模型请求、工具调用和提供商适配统一下沉到主进程。
  恢复 `sandbox: true`，只有遇到明确的原生依赖阻塞时再做白名单例外。

### 问题 5：会话历史存在数据丢失和重复归档，当前实现无法稳定保存一段持续对话
- **位置**：`src/components/chat/ConversationList.tsx:19-55`、`src/components/chat/ConversationList.tsx:59-87`、`src/components/layout/AgentPanel.tsx:117-122`、`src/store/slices/conversation.ts:44-50`
- **描述**：
  当前会话只有在切换历史对话时才会通过 `setConversation` 获得稳定 `id`。普通新对话发送消息后，`saveCurrentToHistory()` 会用 `conv-${Date.now()}` 临时生成一个新 id，但不会把这个 id 回写到当前会话，因此同一段对话每保存一次都可能生成一条新的历史记录。与此同时，Agent 面板顶部的“新建对话”按钮直接 `clearConversation()`，绕过了历史保存逻辑，当前对话会被无提示清空。
- **影响**：
  用户很容易在“新建对话”时丢失上下文；同一会话也会在历史列表中出现多个副本，后续做标题生成、导出、同步都不可靠。
- **修复建议**：
  在第一条用户消息落盘时就生成稳定会话 id，并写回 `conversation.id`。
  把“新建对话”统一收口到历史模块，确保先保存当前会话再清空。
  增加历史去重策略，至少避免基于时间戳无限生成新记录。

## 🟡 建议改进

### 问题 6：工具调用协议和展示链路都不完整，真实模型接入后会出现消息序列错误且用户看不到工具状态
- **位置**：`src/services/agentLoop.ts:129-149`、`src/services/agentLoop.ts:176-205`、`src/components/layout/AgentPanel.tsx:185-191`
- **描述**：
  `AgentLoop` 只有在拿到自然语言 `fullContent` 时才写入 assistant 消息；如果模型返回的是“仅 tool_calls，无文本”，当前实现会直接追加 `role: 'tool'` 消息，缺失前置 assistant/tool_calls 消息，消息序列不符合主流 OpenAI 兼容接口要求。即使有 toolCalls 被写进消息，`AgentPanel` 渲染 `MessageBubble` 时也没有把 `msg.toolCalls` 传进去，工具卡片不会显示。
- **影响**：
  这会让真实工具链路不稳定，同时 UI 层无法解释模型到底调用了什么工具、执行到了哪一步。
- **修复建议**：
  只要存在 `pendingToolCalls`，就必须先写入一条 `assistant` + `tool_calls` 消息，哪怕 `content` 为空。
  `AgentPanel` 传递 `toolCalls` 给 `MessageBubble`，并在工具执行后回填状态和结果。

### 问题 7：多处“功能完成感”来自占位逻辑，容易误导后续迭代判断
- **位置**：`src/components/terminal/TerminalPanel.tsx:45-82`、`src/components/ui/QuickOpen.tsx:20-31`、`src/components/layout/StatusBar.tsx:17-22`、`README.md:1-48`
- **描述**：
  终端在 Electron 分支里只追加一行“执行中...”，没有真正调用 bridge；Quick Open 每次打开都只拉 demo 树；状态栏里的 Token 和连接状态是硬编码；README 仍是 Vite 模板。这些内容会在演示时显得“像是有功能”，但对开发判断很不友好。
- **修复建议**：
  明确区分“占位 UI”和“真实能力”，未接通的功能直接显示 `Not implemented` 或 capability 缺失。
  README 至少补齐架构边界、运行方式和当前未完成模块。

## ✅ 做得好的地方

- `Redux Toolkit` 的 slice 已按业务域拆开，后续整顿数据流时有基础可用。
- `AIClient` 已经把 SSE、重试和工具调用增量拼装的基础形态搭出来了，方向是对的。
- `AppLayout`、`Sidebar`、`Editor`、`Agent`、`BottomPanel` 的宿主结构已经比较清晰，适合在底座修稳后继续扩展。

## 验证记录

```powershell
npx tsc -p tsconfig.app.json --noEmit --pretty false
npx tsc -p tsconfig.electron.json --noEmit --pretty false
npx eslint src electron --ext .ts,.tsx
npm run build
node -e "const path=require('path'); console.log(path.join('dist-electron/electron','../dist/index.html')); console.log(path.join('dist-electron/electron','../../dist/index.html'));"
```

### 关键结果
- `npm run build` 失败：`src/components/chat/MessageBubble.tsx(28,9): error TS6133: 'ref' is declared but its value is never read.`
- `npx tsc -p tsconfig.app.json --noEmit --pretty false` 失败：`src/services/mcpManager.ts` 对不存在的 `window.synapse.mcp.start/stop` 调用直接报错。
- `npx eslint src electron --ext .ts,.tsx` 返回 67 个问题，除大量 `any` 外，还包含 React 生命周期误用与 memoization 依赖错误。

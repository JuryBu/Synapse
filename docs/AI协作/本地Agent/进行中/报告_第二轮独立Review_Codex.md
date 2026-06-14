# 审核报告：Synapse 第二轮独立 Review

**审核时间**: 2026-03-23
**审核范围**: `src/`, `electron/`
**审核方式**: 静态代码审查 + 命令验证（`npm run lint`、`npm run build`、`npm run electron:build`）
**整体评价**: 当前代码更接近“高保真原型 + 模块占位”，视觉骨架和分层命名较清晰，但 Stage 5-7 尚未形成闭环集成，且存在构建失败、未净化 Markdown、错误边界缺失和可扩展性不足等问题。

## 结论概览

| 级别 | 数量 | 重点方向 |
| --- | --- | --- |
| Critical | 2 | 构建稳定性、渲染安全 |
| Major | 6 | 架构闭环、Electron 桥接、性能、错误处理、a11y |
| Minor | 4 | 冗余状态、重复加载、交互细节、重复逻辑 |
| Suggestion | 3 | 公共抽象、状态收敛、质量防线 |

## 🔴 Critical

### 1. Web 构建当前直接失败，项目无法产出正式包
- **位置**：`src/platform/index.ts:70`、`src/platform/index.ts:89`
- **证据**：`npm run build` 失败，报错 `TS6133: 'mockStore' is declared but its value is never read` 与 `TS6133: 'c' is declared but its value is never read`
- **描述**：前端构建链路已经断开，说明当前分支不满足最基本的发布/验收条件。Electron 编译虽能通过，但主打包命令失败意味着正式构建不可用。
- **影响**：阻塞 CI、阻塞 release、降低后续 review 结论可信度。
- **修复建议**：
  ```ts
  // src/platform/index.ts
  // 删除未使用变量
  // const mockStore: Record<string, any> = {};

  write: async (p, _content) => { console.log('[Web Mock] file:write', p); },
  ```
  然后将 `npm run build` 纳入提交前检查。

### 2. 聊天消息允许未净化的原始 HTML，存在 XSS / DOM 注入风险
- **位置**：`src/components/chat/MessageBubble.tsx:1-3`、`src/components/chat/MessageBubble.tsx:63-65`
- **描述**：AI/工具输出属于不可信输入，但当前渲染链路启用了 `rehypeRaw`，却没有任何 `sanitize` 白名单。模型或工具一旦返回带事件处理器、内联 HTML、恶意 iframe/img 的内容，就可能造成 DOM 注入、钓鱼 UI、资源探测或脚本执行风险。
- **影响**：这是聊天产品的核心输入面，风险级别高于普通 Markdown 渲染。
- **修复建议**：
  - 默认移除 `rehypeRaw`，仅保留 Markdown + GFM。
  - 如果确实需要 HTML，补上 `rehype-sanitize` 并维护白名单。
  - 对工具输出与模型输出分级渲染，不要统一视为可信富文本。

## 🟠 Major

### 3. Stage 5-7 没有形成垂直闭环，AgentPanel 仍是 Demo 回显
- **位置**：`src/components/layout/AgentPanel.tsx:27-47`、`src/services/agentLoop.ts:32-178`、`src/services/toolRegistry.ts:56-112`
- **描述**：聊天面板发送消息后仍然通过 `setTimeout` 返回 `getDemoResponse()`，并未接入 `AIClient`、`AgentLoop`、`ToolRegistry`、`SystemPromptBuilder`。从代码依赖上看，这些服务层模块目前基本处于“已写但未接线”状态。
- **影响**：架构上形成了“UI 层一套、服务层一套”的双轨系统，后续一旦接入真流式链路，现有 `AgentPanel` 逻辑大概率需要整体替换。
- **修复建议**：
  - 让 `AgentPanel` 只负责输入与展示。
  - 将发送逻辑统一下沉到 `conversationService` / `agentController`。
  - 使用真实 `AgentLoop.run()` 驱动状态更新，避免保留 Demo 分支进入主线。

### 4. Electron bridge 契约已经漂移，preload 暴露的 API 绝大部分在 main 中没有实现
- **位置**：`electron/preload.ts:17-48`、`electron/main.ts:53-72`、`src/services/fileSystem.ts:65-77`
- **描述**：preload 暴露了 `file`、`mcp`、`terminal`、`config` 等接口，并在注释中标记为已实现；但 main 进程当前只注册了窗口控制和 `platform:info`。渲染层一旦在 Electron 环境调用 `window.synapse.file.read/list`，会直接命中未注册 IPC handler。
- **影响**：这不是简单的 TODO，而是“类型看起来存在、运行时一定失败”的伪契约，会制造最难排查的联调错误。
- **修复建议**：
  - 将桥接契约集中到共享类型文件，禁止在 `preload` 和 `platform` 双份手写。
  - 对未实现接口显式抛出 `"Not implemented yet"`，不要伪装成已可用。
  - 在 main 进程补齐 handler 前，渲染层不要切换到 Electron 真调用路径。

### 5. 流式渲染路径会在长对话中放大重渲染成本
- **位置**：`src/components/layout/AgentPanel.tsx:16-25`、`src/components/layout/AgentPanel.tsx:105-119`、`src/components/chat/MessageBubble.tsx:63-93`
- **描述**：
  - `AgentPanel` 对 `messages` 和 `streamingContent` 的每次变化都会整面板重渲染。
  - 渲染阶段每次都 `messages.map(...)`，并为每条 assistant 消息重新走一遍 `ReactMarkdown` + code block 解析。
  - `scrollIntoView({ behavior: 'smooth' })` 在每个流式 chunk 到来时都会执行一次，长回答下容易产生连续动画和滚动抖动。
- **影响**：消息越多，SSE 越频繁，卡顿越明显；这会首先体现在低配机器和长上下文对话中。
- **修复建议**：
  - 提取 `MessageList`，对单条消息使用 `React.memo`。
  - 流式中仅更新最后一条 assistant 占位消息，而不是整列表重渲染。
  - 自动滚动改为“仅在底部附近时触发”，并将 `smooth` 改为节流后的 `auto`/单次动画。
  - 对消息列表预留虚拟化方案。

### 6. FileTree 的实现无法支撑真实 IDE 级工作区规模
- **位置**：`src/components/sidebar/FileTree.tsx:13-76`、`src/components/sidebar/FileTree.tsx:98-136`
- **描述**：文件树采用递归全量渲染，每个节点各自维护 `expanded` 状态，也没有懒加载、虚拟列表、节点 memo 或目录级分页策略。当前 Demo 树很小看不出问题，但真实课程仓库、代码仓库或多层目录下会迅速退化。
- **影响**：首屏渲染、展开目录、批量更新都会放大 DOM 数量和协调成本。
- **修复建议**：
  - 目录 children 改为按需加载。
  - 展开状态上收为 `expandedPaths: Set<string>`，便于批量控制和持久化。
  - 节点渲染改为扁平化 + 虚拟滚动，而不是深层递归 DOM。

### 7. 错误边界缺失，任意渲染异常都会直接打挂整个根树
- **位置**：`src/main.tsx:8-13`
- **描述**：根节点只包了 `StrictMode` 和 `Provider`，没有任何 `ErrorBoundary`。一旦消息渲染、面板布局、未来的编辑器/文件预览组件抛异常，整个应用会直接白屏。
- **影响**：学习工具/IDE 类产品是长会话场景，没有错误边界意味着单点渲染错误会丢失整个工作上下文。
- **修复建议**：
  - 在根部增加 `AppErrorBoundary`。
  - 对高风险区域单独包边界，如 AgentPanel、EditorArea、Sidebar。
  - 边界内接入通知系统，至少保留“可恢复 UI + 错误摘要”。

### 8. AgentLoop 的错误不会正确反馈到 UI，工具失败会“静默”
- **位置**：`src/services/agentLoop.ts:133-155`、`src/services/agentLoop.ts:169-176`
- **描述**：
  - 工具执行成功时会 `store.dispatch(addMessage(...))`。
  - 工具执行失败时只把错误 push 到本地 `messages` 数组，没有写回 Redux，所以 UI 不会看到失败详情。
  - 流式错误只 `console.error`，用户侧没有任何可见反馈，也没有统一通知。
- **影响**：用户看到的对话历史与模型真实上下文不一致，后续排障会非常困难。
- **修复建议**：
  - 失败分支也 dispatch 一个 `tool`/`system` 消息。
  - 把 `chunk.type === 'error'` 统一映射到通知或错误消息。
  - 区分“可恢复错误”和“终止对话错误”，避免继续循环时丢语义。

### 9. FileTree 主体是 `div + onClick`，键盘与屏幕阅读器几乎不可用
- **位置**：`src/components/sidebar/FileTree.tsx:30-60`、`src/components/sidebar/FileTree.tsx:112-134`
- **描述**：树节点不是按钮/树项语义，没有 `role="tree"`、`role="treeitem"`、`aria-expanded`、`tabIndex`、方向键导航，也没有键盘打开上下文菜单的能力。右键菜单同样缺少 `menu/menuitem` 语义和焦点管理。
- **影响**：键盘用户无法操作文件树；屏幕阅读器无法感知层级和展开态。
- **修复建议**：
  - 用语义化 tree pattern 重写交互层。
  - 至少先补 `button`/`aria-expanded`/`tabIndex`/Enter+Space 支持。
  - 上下文菜单增加焦点陷阱、Esc 关闭、箭头键导航。

## 🟡 Minor

### 10. Sidebar 初始加载路径会重复请求同一份 workspace tree
- **位置**：`src/components/layout/Sidebar.tsx:18-31`
- **描述**：首次进入 `explorer` 时，第一段 `useEffect` 先 `getWorkspaceTree()` 并 `dispatch(openWorkspace)`；随后 `workspace.currentPath` 变化触发第二段 `useEffect`，再次 `getWorkspaceTree()`。
- **影响**：当前只是多一次 Demo 读取；接入真实文件系统后会变成重复 I/O。
- **修复建议**：合并为单一加载流程，或在第二段 effect 中判断是否已有 `fileTree`。

### 11. a11y 细节还不完整，多个交互控件只做了视觉态
- **位置**：`src/components/layout/ActivityBar.tsx:41-49`、`src/components/layout/AgentPanel.tsx:64-81`、`src/components/layout/BottomPanel.tsx:10-24`、`src/styles/chat.css:78-95`
- **描述**：
  - ActivityBar、Agent tabs、Bottom tabs 都没有 `aria-label`、`aria-selected`、`aria-pressed` 等状态语义。
  - `.message-copy-btn` 默认 `opacity: 0`，仅在 hover 时显示，键盘 focus 和触屏场景都不友好。
- **影响**：可访问性和跨设备可用性均偏弱。
- **修复建议**：
  - tabs 使用 `role="tablist"` / `role="tab"` / `aria-selected`。
  - 图标按钮补 `aria-label`。
  - 对 copy 按钮增加 `:focus-visible` 样式，不要只依赖 hover。

### 12. 全局 Store 预置过多未接线 slice，当前收益低于维护成本
- **位置**：`src/store/index.ts:13-27`
- **描述**：Store 里注册了 10 个 slice，但当前 UI 真正读写的主要只有 `layout`、`sidebar`、`conversation`、`workspace`、`agentSettings`。其余 slice 暂时没有进入真实交互链路。
- **影响**：增加心智负担，也容易制造“状态看起来已设计、实际并未落地”的假象。
- **修复建议**：
  - 只保留已进入主线的 slice。
  - 未接线状态改为 feature-local state 或按阶段延后接入。

### 13. 重复逻辑已经出现，可以开始提取公共模块
- **位置**：`src/components/layout/AgentPanel.tsx:8-10`、`src/services/agentLoop.ts:28-30`、`src/platform/index.ts:14-49`、`electron/preload.ts:3-50`、`src/components/layout/Sidebar.tsx:56-79`
- **描述**：
  - `generateId()` 重复出现。
  - IPC/SynapseAPI 类型在 renderer 与 preload 双份维护。
  - Sidebar placeholder 分支重复。
- **影响**：现在量不大，但这些重复正好都落在“未来频繁变动”的区域，后续会快速失配。
- **修复建议**：
  - 提取 `utils/id.ts`。
  - 提取 `shared/ipc.ts` 统一桥接契约。
  - 提取 `SidebarPlaceholder` 配置驱动渲染。

## 💡 Suggestion

### 14. 先补“集成骨架”，再继续堆 slice 和占位 UI
- **建议**：优先完成一条真正可跑通的垂直链路：
  `AgentPanel -> AgentLoop -> AIClient(SSE) -> ToolRegistry -> conversation state -> MessageBubble`
- **原因**：现在最大的风险不是“功能少”，而是“模块很多但不接起来”。

### 15. 把桥接契约和服务层输入输出做成共享类型
- **建议**：新增 `src/shared/` 或 `shared/`，统一放 `ipc.ts`、`tool.ts`、`conversation.ts` 类型。
- **原因**：当前 `preload`、`platform`、service、store 都在各写一份近似结构，漂移已经出现。

### 16. 建立基础质量防线
- **建议**：
  - `npm run lint && npm run build && npm run electron:build` 作为最小提交门槛
  - 对 `AgentLoop`、`AIClient`、`FileTree` 增加最小单元测试
  - ESLint 增加 a11y 规则和 React/TypeScript 更严格约束

## ✅ 做得好的地方

- 目录划分清晰：`components/`、`services/`、`store/`、`platform/` 的职责边界是明确的。
- `AIClient`、`AgentLoop`、`ToolRegistry` 的命名和拆分方向是对的，说明目标架构并不混乱，问题主要在集成层。
- Electron 主进程目前保持得很薄，这对后续把系统能力逐步下沉到 IPC 是好事。
- UI 骨架完成度高，三栏布局、玻璃态视觉和分区命名已经具备继续迭代的基础。

## 优先级建议

1. 先修复构建失败与 `rehypeRaw` 安全问题。
2. 然后打通 Agent 主链路，移除 Demo `setTimeout`。
3. 接着补 Electron IPC 契约、Error Boundary、用户可见错误反馈。
4. 最后处理 FileTree/MessageList 的性能与 a11y 重构。

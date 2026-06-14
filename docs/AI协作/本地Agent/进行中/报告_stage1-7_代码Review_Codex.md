# Review 报告：Synapse Stage 1-7

**审核时间**: 2026-03-23
**审核范围**: `src/`、`electron/`、`vite.config.ts`、`tsconfig*.json`
**整体评价**: 代码骨架已经成型，但当前存在 2 个 Critical 安全问题、6 个 Major 级设计/实现问题。尤其是 Markdown 渲染链路与密钥存储策略组合后，已经形成可利用的攻击面。

## 分级汇总

| 级别 | 数量 |
| --- | ---: |
| Critical | 2 |
| Major | 6 |
| Minor | 4 |
| Suggestion | 2 |

## Critical

### 1. AI 消息启用原始 HTML 解析，形成直接 XSS 面
- **位置**: `src/components/chat/MessageBubble.tsx:63-65`
- **描述**: `ReactMarkdown` 同时启用了 `remark-gfm` 和 `rehypeRaw`。这里渲染的 `content` 来自 AI/tool 输出，不受信任；一旦返回 `<img onerror=...>`、`<a onclick=...>` 等原始 HTML，事件属性会落入真实 DOM，攻击者可以在渲染进程执行任意脚本。
- **影响**: 不只是聊天气泡被污染。当前渲染进程还能读取 `localStorage`，并可调用 `window.synapse` 暴露的桥接 API，这会把 XSS 直接升级为本地能力滥用或密钥泄露。
- **修复建议**:
  ```tsx
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    // 删除 rehypeRaw
    skipHtml
  >
    {content}
  </ReactMarkdown>
  ```
  如果必须支持有限 HTML，至少在服务端或渲染前用白名单 sanitizer 过滤，禁止事件属性、`javascript:` URL、内联样式和危险标签。

### 2. API Key 明文落在 `localStorage`，被 XSS 和同源脚本直接读取
- **位置**: `src/platform/index.ts:106-115`
- **描述**: Web Mock 的 `config.get/set/getAPIKey/setAPIKey` 直接把配置和 API Key 写入 `localStorage`。这属于长期明文持久化，任何同源脚本、浏览器扩展或上面的 XSS 都能直接读取。
- **影响**: 一旦用户在 Web/开发模式下配置真实密钥，泄露成本极低；而且 key 没有生命周期控制、没有作用域隔离、也没有显式“不安全模式”提示。
- **修复建议**:
  - Electron 模式下把密钥存到主进程受控存储，避免渲染层直接读写。
  - Web Mock 不要持久化真实密钥；如果仅为 Demo，改成内存态并提示“刷新即丢失”。
  - 若确实要持久化，至少加密并把密钥读取收敛到主进程/后端代理，而不是暴露给渲染层。

## Major

### 3. Electron 关闭 sandbox，且 preload 暴露面过大
- **位置**: `electron/main.ts:17-21`, `electron/preload.ts:17-48`
- **描述**: `BrowserWindow` 显式设置了 `sandbox: false`，同时 preload 一次性把 `file.*`、`mcp.*`、`terminal.*`、`config.*` 全量暴露给渲染层。即使当前主进程尚未实现全部 handler，这个能力模型本身也不是 least privilege。
- **影响**: 一旦渲染层被注入，攻击面会直接扩展到文件系统、MCP、终端、配置读写。后续 Stage 继续补齐 handler 时，这会变成高风险默认状态。
- **修复建议**:
  - 打开 `sandbox: true`，仅保留最小必要桥接。
  - 按业务域拆分 preload API，不要暴露“任意参数透传”接口。
  - 在主进程对每个 channel 做参数校验、路径约束和权限审计。

### 4. preload 与 main 的 IPC 契约已经失配，类型声明和运行时行为不一致
- **位置**: `electron/preload.ts:17-48`, `electron/main.ts:55-72`
- **描述**: preload 宣称支持 `file:*`、`mcp:*`、`terminal:*`、`config:*`，但 main 只注册了 `window:*` 和 `platform:info`。这意味着渲染层按照类型调用这些 API 时，会在运行时收到 “No handler registered” 类错误。
- **影响**: 这是跨进程 API 的假实现，后续组件一旦接入 Electron 真路径，会出现“类型看起来可用、运行时全失败”的隐性故障。
- **修复建议**:
  - 建立共享的 channel 常量和请求/响应 DTO，preload 与 main 共用一份定义。
  - 未实现的 API 不要先暴露到 `window.synapse`。
  - 在 CI 中加入 “preload 导出 API vs ipcMain 注册表” 一致性检查。

### 5. AgentLoop 把错误吞进控制台，Redux/UI 看不到真实失败状态
- **位置**: `src/services/agentLoop.ts:91-176`
- **描述**:
  - `handleChunk()` 在收到 `error` chunk 时只 `console.error`，没有更新对话状态或通知系统。
  - 工具调用失败分支只把错误写进局部 `messages` 数组（`148-154`），没有 `store.dispatch(addMessage(...))`。
- **影响**: 用户界面会表现为“无响应”或“工具调用突然结束”，但 Redux 里没有失败消息、tool status 也不会从 `pending` 变成 `error`，排障困难。
- **修复建议**:
  - 为 `StreamChunk.type === 'error'` 单独 dispatch 错误消息/通知。
  - 为 `toolCalls` 增加 `running/success/error` 生命周期更新 action。
  - 工具异常时同步写入 Redux，确保 UI、历史记录、日志三者一致。

### 6. 项目宣称 `strict`，但关键边界层仍大量使用 `any`，lint 已经失守
- **位置**:
  - `electron/preload.ts:23,28,37,46`
  - `src/platform/index.ts:27-29,32-45,58,70`
  - `src/services/aiClient.ts:62,65,187`
  - `src/services/agentLoop.ts:18,23,56,148`
  - `src/services/toolRegistry.ts:18,41,46`
  - `src/components/layout/ActivityBar.tsx:24`
  - `src/components/layout/AppLayout.tsx:32`
  - `src/components/layout/Sidebar.tsx:39`
- **描述**: 项目在 `tsconfig.app.json` / `tsconfig.node.json` 里打开了 `strict`，但真正最需要类型约束的地方恰好都用 `any` 打穿了，导致跨进程、工具调用、AI 返回、视图切换这些边界失去编译期保护。
- **影响**: 当前 `npm run lint` 已报 35 个错误，说明类型安全承诺和代码现实已经脱节；继续堆功能只会让后续重构成本更高。
- **修复建议**:
  - 为 IPC、MCP、ToolRegistry、AI chunk 定义明确 DTO。
  - 所有外部输入先进 `unknown`，再做 schema 校验后收窄。
  - 去掉 `view as any` / `role as any` 这类兜底写法，让非法值在编译期暴露。

### 7. 文件系统服务与工作区状态脱节，Redux 中的 workspace 不是实际数据源
- **位置**: `src/services/fileSystem.ts:65-83`, `src/components/layout/Sidebar.tsx:18-32`
- **描述**: `openWorkspace()` 会把 `workspace.currentPath` 写进 store，但 `getWorkspaceTree()` 永远返回固定 `DEMO_FILE_TREE`，完全不读取 `currentPath`，也不区分 Electron / Web。Sidebar 两个 effect 都在消费这个“伪树”。
- **影响**: store 显示已经打开工作区，UI 也会展示对应名称，但内容始终是 demo 数据。这会把“状态正确、数据错误”的问题埋得很深，尤其在接入真实文件系统后难排查。
- **修复建议**:
  - 把 `getWorkspaceTree(path: string)` 设计成显式依赖路径。
  - Electron 模式走 `window.synapse.file.list/read` 递归构树，Web Mock 只在没有工作区时回退 demo。
  - Sidebar 只保留一个 effect，并做请求取消/版本检查，避免旧请求覆盖新状态。

### 8. Redux 存在重复来源的模型状态，slice 边界不清晰
- **位置**: `src/store/slices/conversation.ts:20-38,65-70`, `src/store/slices/agentSettings.ts:5-20`, `src/components/layout/AgentPanel.tsx:14-18`
- **描述**: `conversation` slice 保存了 `model` 和 `pendingMessage`，`agentSettings` slice 又保存了 `currentModel`；但组件实际读取的是 `agentSettings.currentModel`。`conversation.model` 已经变成半废弃字段，未来极易与真实设置漂移。
- **影响**: 这是典型的多 source of truth。历史会话、发送参数、顶部显示模型名三者一旦分叉，就会出现“显示 A，实际请求 B”的隐性错误。
- **修复建议**:
  - 明确模型属于“会话级”还是“全局设置级”，只保留一个主来源。
  - 若会话需要快照模型名，应该在创建消息/会话时固化，而不是在多个 slice 中长期并存。
  - 删除未使用字段和 action，避免误导调用方。

## Minor

### 9. 流式输出期间每个 chunk 都触发平滑滚动，容易造成抖动和性能浪费
- **位置**: `src/components/layout/AgentPanel.tsx:22-25`
- **描述**: `useEffect` 依赖 `streamingContent`，意味着每个 token/chunk 到达都会触发一次 `scrollIntoView({ behavior: 'smooth' })`。流式长回答时会不断启动动画。
- **影响**: 在连续流输出下会产生明显的滚动抢占和 layout 抖动，尤其是低性能设备或长会话。
- **修复建议**:
  - 仅在用户当前接近底部时自动滚动。
  - 流式阶段使用 `behavior: 'auto'` 或 `requestAnimationFrame` 节流。

### 10. 样式存在重复定义，最终效果依赖导入顺序而不是组件归属
- **位置**: `src/styles/layout.css:330-334`, `src/styles/chat.css:6-10`, `src/styles/layout.css:510-512`, `src/styles/chat.css:220-223`, `src/App.tsx:1-3`
- **描述**:
  - `.agent-messages` 在 `layout.css` 和 `chat.css` 各定义一次。
  - `@keyframes blink` 也在两个文件重复声明。
  - `App.tsx` 当前按 `layout.css -> fileTree.css -> chat.css` 顺序导入，因此 `chat.css` 会悄悄覆盖前面的定义。
- **影响**: 维护者看到某个样式修改“没生效”时，需要再去猜导入顺序，CSS 可预测性较差。
- **修复建议**:
  - 把聊天容器样式收敛到一个文件。
  - 为动画名加前缀，如 `syn-chat-blink` / `syn-terminal-blink`。
  - 优先按功能域拆样式，避免跨文件共享同名全局 selector。

### 11. FileTree 依赖 `display: contents` 和点击 `div`，可访问性与跨浏览器稳定性一般
- **位置**: `src/styles/fileTree.css:59-62`, `src/components/sidebar/FileTree.tsx:32-37`
- **描述**: `display: contents` 在可访问性树和部分布局场景里仍有兼容性坑；同时文件树节点是可点击 `div`，没有键盘语义、没有 `role="treeitem"`。
- **影响**: 键盘无法正常操作文件树，屏幕阅读器也很难识别层级结构。
- **修复建议**:
  - 改为语义化按钮或带 `role` 的树节点结构。
  - 去掉 `display: contents`，使用普通容器处理缩进。

### 12. layout slice 已经出现未消费状态，说明 UI 状态边界开始膨胀
- **位置**: `src/store/slices/layout.ts:3-40`
- **描述**: `bottomPanelVisible`、`agentPanelVisible`、`isFullscreenAgent` 已定义了 reducer，但当前代码检索不到任何消费者。
- **影响**: 未接线状态会误导后续开发者，以为这些开关已经生效；时间久了会演化成“store 很大，但没人确定哪些字段是真实来源”。
- **修复建议**:
  - 立刻接入 UI，或删除未使用字段。
  - 对 slice 维持“只存当前真正被消费的状态”原则。

## Suggestion

### 13. 字体变量声明了 `Inter` / `Cascadia Code`，但并未实际加载
- **位置**: `src/index.css:40-42`
- **描述**: 设计系统声明了专用字体，但项目没有引入字体资源，也没有 `@font-face` 或外部加载逻辑。
- **建议**: 如果这些字体是设计要求，应显式加载；如果不是，直接改成可预测的本地字体栈，避免不同机器渲染差异太大。

### 14. 局部组件仍有内联样式，削弱了设计 token 的统一性
- **位置**: `src/components/layout/EditorArea.tsx`, `src/components/layout/BottomPanel.tsx`, `src/components/layout/Sidebar.tsx`
- **描述**: 颜色、字体、透明度等展示样式还散落在 JSX 内联对象里，和 `index.css` 的 token 体系分离。
- **建议**: 收敛到 CSS class 或 CSS 变量，避免未来主题切换时到处搜 JSX 内联样式。

## 验证结果

### `npm run lint`
- **结果**: 失败
- **关键信息**:
  - 共 35 个错误，全部集中在 `no-explicit-any` 和少量未使用变量。
  - 说明严格类型边界尚未建立。

### `npx tsc -b --pretty false`
- **结果**: 失败
- **关键信息**:
  - `src/platform/index.ts(70,9)`: `mockStore` 未使用
  - `src/platform/index.ts(89,24)`: 参数 `c` 未使用

## 做得好的地方

- `tsconfig.app.json`、`tsconfig.node.json` 已经启用了 `strict`、`noUnusedLocals`、`noUnusedParameters`，方向是对的。
- Redux slice 切分基本符合业务域，后续只要收紧 source of truth，就有机会保持结构清晰。
- `Message` / `ToolCall` / `PlatformInfo` 等核心接口已经开始显式建模，不是完全无类型起步。

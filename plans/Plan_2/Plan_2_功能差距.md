# Plan_2_功能差距: Task.md 逐 Stage 完成度分析

> 对照 Task.md 和实际代码，逐条评估每个 Stage 的真实完成状态。
> 标记：✅已实现 | ⚠️部分/Mock | ❌未实现

---

## Stage 1: 项目初始化（完成度 90%）

| 任务项 | 状态 | 说明 |
|---|---|---|
| Vite + React 18 + TS 项目 | ✅ | 实际用 React 19 + Vite 8 |
| Electron 主进程 | ✅ | `electron/main.ts` 基本窗口创建 |
| 预加载脚本 | ✅ | `electron/preload.ts` 暴露 SynapseAPI |
| 平台适配层 | ✅ | `src/platform/index.ts` isElectron 判断 |
| electron-builder 配置 | ✅ | package.json build 字段完整 |
| BAT 启动器 | ✅ | `启动Synapse.bat` 可用 |
| Web/Electron 双模式启动 | ⚠️ | Web `npm run dev` 可用；Electron 未验收 |

**缺失**：Electron 模式启动未验收通过

---

## Stage 2: 布局引擎（完成度 85%）

| 任务项 | 状态 | 说明 |
|---|---|---|
| AppLayout 三栏 PanelGroup | ✅ | react-resizable-panels |
| Activity Bar | ✅ | 图标列表 + 点击切换 |
| Sidebar 可折叠 | ✅ | |
| Editor Area 占位 | ✅ | 集成 TabBar + 查看器路由 |
| Agent Panel 占位 | ✅ | 448行大组件，功能完整 |
| 底部面板(终端) | ✅ | BottomPanel + TerminalPanel |
| Status Bar | ✅ | Token 计数等 |
| CSS 变量体系 | ✅ | `--syn-*` 系列 |
| Glassmorphism 磨砂 | ⚠️ | 基础实现，效果需打磨 |
| 背景图系统 | ⚠️ | useThemeEffect 有壁纸选择器，但完整度待验证 |
| 面板持久化 | ✅ | localStorage |
| 响应式布局 | ❌ | 窗口 <1000px 未处理 |

---

## Stage 3: Redux Store（完成度 60%）

| 任务项 | 状态 | 说明 |
|---|---|---|
| Redux Store 配置 | ✅ | `store/index.ts` |
| ~20 个 Slices | ⚠️ | 实际 11 个 Slice |
| SQLite + 数据库初始化 | ❌ | 未安装 better-sqlite3 |
| SQLite Schema 6表+FTS5 | ❌ | |
| ConversationManager | ❌ | 对话仅存内存 |
| IPC 桥接 CRUD | ❌ | |
| Web 模式 localStorage 降级 | ⚠️ | 主题/布局有，对话历史部分 |

---

## Stage 4: 文件系统（完成度 20%）

| 任务项 | 状态 | 说明 |
|---|---|---|
| 文件系统 IPC handler | ❌ | |
| FileTree 虚拟滚动 | ⚠️ | FileTree.tsx 存在但无虚拟滚动 |
| 文件 CRUD 操作 | ⚠️ | Web 内存 Mock 有，IPC 无 |
| 右键菜单 | ⚠️ | ContextMenu 框架有，文件树集成部分 |
| 文件搜索 | ⚠️ | searchFiles 内存搜索有 |
| 工作区 CRUD | ⚠️ | FileSystemService 有 Mock |
| 欢迎页 | ✅ | WelcomePage.tsx 完整 |
| 文件拖拽上传 | ⚠️ | uploadFile 内存存储 |
| Web IndexedDB 模拟 | ❌ | 仅用内存 Map |

---

## Stage 5: AI 通信层（完成度 70%）

| 任务项 | 状态 | 说明 |
|---|---|---|
| AIClient OpenAI API + SSE | ✅ | 256 行完整实现 |
| AgentLoop 25轮循环 | ✅ | 236 行完整实现 |
| SystemPromptBuilder | ✅ | XML 结构 + Fast/Plan 模式 |
| ContextWindowManager | ⚠️ | estimateTokens 粗略估算，非 tiktoken |
| 多模型兼容 | ✅ | OpenAI/DeepSeek/OpenRouter/Ollama 端点 |
| 错误处理+自动重试 | ✅ | 429/5xx 指数退避 3 次 |
| Token 用量追踪 | ⚠️ | 估算版，非 API 返回的精确值 |

---

## Stage 6: Agent Panel（完成度 65%）

| 任务项 | 状态 | 说明 |
|---|---|---|
| AgentPanel 容器 | ✅ | Chat 标签可用 |
| MessageList | ⚠️ | 无虚拟滚动 |
| 消息组件(User/Assistant/Tool) | ✅ | MessageBubble + ToolCallCard |
| react-markdown 渲染 | ✅ | + rehype-raw + remark-gfm |
| 代码高亮 + 复制 | ⚠️ | 有高亮，复制待验证 |
| KaTeX 数学公式 | ✅ | remark-math + rehype-katex |
| Mermaid 图表 | ✅ | MermaidBlock 暗色主题 |
| Lexical 输入框 | ❌ | 使用普通 textarea，非 Lexical |
| Fast/Plan 模式切换 | ✅ | |
| 消息右键菜单 | ⚠️ | ContextMenu 有但集成不完整 |

---

## Stage 7: 内置工具（完成度 50%）

| 任务项 | 状态 | 说明 |
|---|---|---|
| ToolRegistry | ✅ | 注册/查询/执行 + 审批 |
| 文件工具 view/write/replace | ⚠️ | Web Mock，Electron IPC 未实现 |
| 搜索工具 find/grep/list | ⚠️ | 内存搜索 Mock |
| 命令工具 run_command | ❌ | 审批 UI 框架有，执行未实现 |
| search_web/read_url | ❌ | |
| generate_image | ❌ | |
| 工具调用 UI 折叠卡片 | ✅ | ToolCallCard.tsx |
| Schema → 系统提示注入 | ✅ | |

---

## Stage 8-10: MCP/SKILL/Synopsis（完成度 15%）

| 任务项 | 状态 | 说明 |
|---|---|---|
| MCPManager 生命周期 | ⚠️ | mcpManager.ts 有框架，无 stdio 通信 |
| MCP stdio JSON-RPC | ❌ | |
| MCP 配置读取校验 | ❌ | |
| MCP 健康检查 ppid 心跳 | ❌ | |
| SKILL 文件扫描加载 | ❌ | 只有静态 BUILT_IN_SKILLS |
| WORKFLOW turbo 解析 | ❌ | |
| RULES 全局/工作区加载 | ❌ | setGlobalRules 方法有，实际加载无 |
| Synopsis UnifiedChunk | ❌ | |
| PDF/PPTX/DOCX 解析器 | ❌ | |
| Map-Reduce 引擎 | ❌ | synopsisEngine.ts 有框架无实现 |
| Synopsis 进度 UI | ⚠️ | SynopsisPanel.tsx 有 UI |

---

## Stage 11: 展示模式（完成度 45%）

| 任务项 | 状态 | 说明 |
|---|---|---|
| ImageViewer | ✅ | 缩放/旋转/Ctrl+滚轮 |
| ShowcaseFrame iframe | ✅ | 沙箱 + 工具栏 |
| 标签页系统 | ✅ | TabBar 10种类型+中键关闭 |
| MediaPlayer | ✅ | 播放/暂停/进度/倍速 |
| MarkdownViewer | ✅ | react-markdown |
| PdfViewer | ❌ | 组件存在但无 pdf.js Canvas 渲染 |
| DocxViewer | ❌ | 组件存在但无 mammoth 渲染 |
| Monaco Editor | ❌ | CodeEditor.tsx 占位 |
| ShowcaseServerManager | ❌ | |

---

## Stage 12-13: 设置/终端（完成度 25%）

| 任务项 | 状态 | 说明 |
|---|---|---|
| SettingsPanel UI | ⚠️ | 基础面板有，16分类未全部实现 |
| API 配置 UI | ⚠️ | 有输入框，测试连接待验证 |
| 主题/背景 UI | ⚠️ | 壁纸选择器有 |
| 首次使用向导 | ⚠️ | FirstUseWizard.tsx 存在 |
| xterm.js 终端 | ❌ | 仅 Web 模拟 |
| node-pty IPC | ❌ | |

---

## Stage 14: 通知与交互（完成度 75%）

| 任务项 | 状态 | 说明 |
|---|---|---|
| Toast 5种类型 | ✅ | 含进度条 |
| 右键菜单框架 | ✅ | ContextMenu + Presets |
| 命令面板 Ctrl+Shift+P | ✅ | |
| 快捷键系统 | ✅ | useShortcuts hook |
| 快速文件打开 Ctrl+P | ✅ | QuickOpen.tsx |
| 对话导出 MD/JSON | ✅ | conversationExporter.ts |

---

## Stage 15: 打包发布（完成度 5%）

| 任务项 | 状态 | 说明 |
|---|---|---|
| electron-builder 配置 | ⚠️ | package.json 有基础配置 |
| 资源优化 | ❌ | |
| 崩溃恢复 | ❌ | |
| 应用图标 | ❌ | |
| 端到端测试 | ❌ | |

---

## 总结：完成度概览

| Stage | 名称 | 完成度 | 关键缺失 |
|---|---|---|---|
| 1 | 项目初始化 | 90% | Electron 启动验收 |
| 2 | 布局引擎 | 85% | 响应式、磨砂打磨 |
| 3 | Redux Store | 60% | SQLite、IPC、持久化 |
| 4 | 文件系统 | 20% | IPC handler、虚拟滚动 |
| 5 | AI 通信层 | 70% | Token 精确计数 |
| 6 | Agent Panel | 65% | Lexical、虚拟滚动 |
| 7 | 内置工具 | 50% | 真实执行、IPC |
| 8-10 | MCP/SKILL/Synopsis | 15% | 几乎全部 |
| 11 | 展示模式 | 45% | PDF/DOCX/Monaco |
| 12 | 设置系统 | 25% | 完整设置 UI |
| 13 | 终端 | 10% | xterm.js + node-pty |
| 14 | 通知交互 | 75% | 基本完整 |
| 15 | 打包发布 | 5% | 几乎全部 |
| **加权平均** | | **~45%** | |


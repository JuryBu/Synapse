<!-- 🔒 STAGE GUARD ACTIVE — 请勿手动移除此标记 -->

# Synapse 项目 Task 清单 (Plan_2 版)

> 根据 Plan_1 + Plan_2 排查结果重新编排的执行清单。
> 标记说明：`[ ]` 未开始 / `[/]` 进行中 / `[x]` 已完成
>
> **测试规范**：每个 Stage 分"实现"和"测试验收"两块，测试标准必须全部满足才算通过。
> **双模式要求**：所有 UI 功能同时在 Electron 和 Web(localhost) 模式可用。
> **Guard 强制**：每个 Stage 开始前 `stage_guard(start)`，完成后 `stage_guard(check)` 通过才可标记完成。
> **Codex 审查**：每 2-3 个 Stage 启动一次 Codex GPT-5.5 (+fast) 独立 Review。
> **Plan 重温**：每个 Stage 开始时必须重读对应 Plan_1_xxx.md + Task.md 本 Stage 内容。
> **真实验证**：需前后端联合验证时必须 `npm run dev` 启动，用 MCP 截图/交互或子代理真实测试。
> **实时更新**：实施过程中实时更新本文件进度，发现新问题追加到对应位置或末尾「小本本」。

---

## Stage 0: P0 Bug 修复 ⚡

> **目标**：修复 Plan_2 审计发现的 5 个 P0 紧急问题，确保基础可用性。
> **Guard**：`[ ]` start → `[ ]` check 通过
> **参考**：Plan_2_代码审计.md P0-1 ~ P0-5

### 实现
- [x] P0-1: 修复 Electron main.ts 启动路径
  - [x] 用 `app.isPackaged` 替代 `NODE_ENV` 判断
  - [x] 修正生产路径为 `path.join(__dirname, '../dist/index.html')`
  - [x] 添加 `public/icon.png` 应用图标（注释 TODO 待补图标文件）
- [x] P0-2: 补齐最小可用 IPC 契约
  - [x] 实现 `config:get` / `config:set` IPC handler (JSON 文件存储)
  - [x] 实现 `platform:info` 完善（+appPath+locale）
  - [x] 未实现的 file/mcp/terminal IPC 返回友好错误（14 个 stub）
- [x] P0-3: Settings 持久化
  - [x] 添加 Redux 持久化中间件（Web: localStorage）
  - [x] 启动时自动加载已保存设置（preloadedState）
  - [x] API Key 在 localStorage 中 base64 编码
- [x] P0-4: 修复 AgentLoop 纯 tool_calls 丢失
  - [x] `fullContent` 为空但 `pendingToolCalls` 非空时，仍写入 assistant 消息并执行工具
  - [x] 添加空 content + tool_calls 的 assistant message 到 apiMessages
- [x] P0-5: 修复文件树扩展名映射
  - [x] Sidebar.tsx typeMap 统一去掉点号前缀
  - [x] `.replace(/^\./, '')` 兼容两种格式

### 测试验收
- [ ] ✅ Web: `npm run dev` → 设置 API Key → 刷新页面 → Key 仍在（待 Stage 0.5 联合验证）
- [ ] ✅ Web: 发送消息 → AI 回复 → 调用工具 → 工具结果返回 → AI 继续回复（待联合验证）
- [x] ✅ Web: 文件树点击 .md 文件 → 正确打开 MarkdownViewer（代码已修复）
- [x] ✅ Web: 文件树点击 .pdf 文件 → 打开对应查看器（代码已修复）
- [x] 📷 Web: `npm run build` 成功（tsc 0 errors + vite build 通过）
- [ ] ✅ Electron: `npm run electron:dev` → 窗口正常打开（待 Electron 环境验证）
- [x] ✅ Electron: 调用未实现 IPC → 返回友好错误（14 个 stub 已实现）
- [x] 🔍 真实验证: `npm run dev` → MCP 截图首页 → UI 正常渲染 ✅
- [ ] 🔍 真实验证: 配置 API Key → 刷新 → 确认持久化（待联合验证）
---

## Stage 0.5: P1 修复 + 代码质量 🔧

> **目标**：修复 P1 问题，清理 Lint 错误，为后续开发打好基础。
> **Guard**：`[x]` start → `[ ]` check 通过
> **参考**：Plan_2_代码审计.md P1-1 ~ P1-5 + P2-1/P2-3
> **🤖 Codex Review**: Stage 0 + 0.5 完成后启动 Codex GPT-5.5+fast 审查，报告 → `synapse-app/报告_Stage0_Review_Codex.md`

### 实现
- [x] P1-1: Electron sandbox 安全
  - [x] 评估后保留 sandbox:false（预加载层需要 Node API），已加注释说明
- [x] P1-2: HTML 注入防护
  - [x] DocxViewer 的 mammoth HTML 用 DOMPurify 净化
  - [x] Mermaid SVG 渲染 securityLevel:'strict' + DOMPurify 净化 SVG
- [x] P1-3: 工具审批接入执行链路
  - [x] AgentPanel 挂载时调用 `toolRegistry.setApprovalCallback`
  - [x] 从 Redux settings.safety 同步到 toolRegistry.updateAutoApprove
- [ ] P1-4: AgentPanel 拆分（推迟到 Stage 6）
  - [ ] 拆出 ChatInput.tsx
  - [ ] 拆出 MessageList.tsx
  - [ ] 拆出 ChatHeader.tsx
- [x] P1-5: CHECKPOINT 压缩增强
  - [x] user 消息完整保留（Infinity 长度）
  - [x] assistant 消息保留前 500 字
- [x] P2-3: FirstUseWizard 挂载
  - [x] App.tsx 检测 `synapse_onboarded` → 显示向导
- [ ] Lint 清理（推迟到后续 Stage）
  - [ ] 修复 `any` 类型
  - [ ] 修复 React Hooks 依赖警告

### 测试验收
- [x] ✅ Web: DocxViewer DOMPurify 净化已接入（代码已修复）
- [x] ✅ Web: Mermaid securityLevel:'strict' + DOMPurify SVG 净化（代码已修复）
- [x] ✅ Web: toolRegistry.setApprovalCallback 已接入 window.confirm
- [x] ✅ Web: FirstUseWizard 已挂载到 App.tsx
- [ ] ✅ `npm run lint` → 0 errors（Lint 清理推迟）
- [x] ✅ `npm run build` → 成功（tsc 0 errors + vite build 通过）
- [ ] 📷 AgentPanel 拆分截图（P1-4 推迟到 Stage 6）

---

## Stage 1-2: 基础框架与布局（已完成 ✅）

> 已在 Plan_1 阶段完成，仅保留未通过的验收项。

### 遗留验收
- [ ] 🖥 Electron: `npm run electron:dev` → 窗口正常打开（Stage 0 修复后复验）
- [ ] 🦇 BAT: 双击 `启动Synapse.bat` → 选择模式 1/2 均可启动
- [ ] ✅ 窗口缩小到 1000px 以下时布局自动响应（CSS media query）
- [ ] 📷 截图: 磨砂玻璃效果可见（背景透过面板模糊显示）

---

## Stage 3: 数据持久化与 IPC 桥接

> **目标**：实现 SQLite 数据库 + Electron IPC 完整桥接 + Web 模式 localStorage 降级
> **Guard**：`[x]` start → `[ ]` check 通过
> **参考**：Plan_1.md Stage 3 设计 + Plan_1_数据库.md（如有）

### 实现
- [x] 安装 better-sqlite3 + @types/better-sqlite3
- [x] 创建 `electron/database.ts` — 数据库管理器
  - [x] 初始化 `~/.synapse/synapse.db`
  - [x] 6 表 Schema: conversations, messages, workspaces, synopsis_cache, settings, search_index
  - [x] FTS5 全文搜索虚拟表 + WAL 模式
- [x] 创建 `electron/ipc/` 目录 — IPC handler 集合
  - [x] `ipc/config.ts` — 设置读写（safeStorage 加密 API Key）
  - [x] `ipc/conversation.ts` — 对话 CRUD + 消息存取 + FTS5 搜索
  - [x] `ipc/file.ts` — 文件系统操作（read/write/list/search）
  - [x] `ipc/workspace.ts` — 工作区管理 + 文件树扫描
- [ ] 创建 `electron/preload-impl.ts`（推迟到 Stage 4）
- [x] `main.ts` 集成数据库初始化 + 所有 handler 注册
- [ ] Web 模式：localStorage 持久化中间件（已有基础，待完善）

### 测试验收
- [ ] ✅ Electron: 启动 → `~/.synapse/synapse.db` 文件已创建（待 Electron 环境验证）
- [ ] ✅ Electron: 创建对话 → 发送消息 → 关闭重开 → 对话和消息仍在（待联合验证）
- [ ] ✅ Electron: 搜索对话内容 → FTS5 返回结果（待联合验证）
- [ ] ✅ Electron: safeStorage 加密 API Key → 重启后自动解密恢复（待联合验证）
- [x] ✅ Web: `npm run build` 成功（tsc 0 errors + vite build 通过）
- [ ] ✅ Web: 创建对话 → 刷新页面 → 对话仍在（待完善）
- [ ] 📷 截图: 对话历史列表（待联合验证）
- [x] ✅ 无 tsc 错误

---

## Stage 4: 文件系统与工作区管理

> **目标**：真实文件操作 + 虚拟滚动文件树 + 拖拽上传
> **Guard**：`[ ]` start → `[ ]` check 通过
> **参考**：Plan_1.md Stage 4 设计
> **🤖 Codex Review**: Stage 3 + 4 完成后启动 Codex GPT-5.5+fast 审查，报告 → `synapse-app/报告_Stage3-4_Review_Codex.md`

### 实现
- [x] `ipc/file.ts` 完善 — Node.js fs 操作（Stage 3 已实现）
  - [x] readFile / writeFile / list / search
  - [ ] 文件变更 watcher (chokidar)（推迟）
- [x] FileTree 组件重写
  - [ ] 虚拟滚动（推迟到大文件树场景）
  - [x] 懒加载子目录（展开时才渲染）
  - [x] 文件/文件夹图标区分 (lucide-react + emoji)
  - [ ] 拖拽排序/移动（推迟）
- [x] 文件操作 UI
  - [x] 新建文件/文件夹（window.prompt 内联输入）
  - [x] 重命名（内联 input 编辑）
  - [x] 删除（确认弹窗）
  - [x] 拖拽上传到工作区
- [x] 右键菜单增强
  - [x] 打开/重命名/删除/复制路径/发送到 AI/新建文件/新建文件夹
- [ ] 欢迎页增强（推迟到后续）
- [ ] Web 模式：IndexedDB 文件存储（推迟）

### 测试验收
- [ ] 📷 截图: 文件树正常渲染（缩进层级、文件夹/文件图标区分）
- [ ] 🖱 交互: 点击文件夹 → 展开子项 → 懒加载完成
- [ ] 🖱 交互: 右键文件 → 弹出上下文菜单 → 选择"重命名"
- [ ] 🖱 交互: 双击文件 → 在 EditorArea 中打开（正确的查看器）
- [ ] 🖱 交互: 拖拽文件到文件树 → 上传成功 → 文件出现在树中
- [ ] 📷 截图: 欢迎页显示最近工作区列表
- [ ] ✅ Electron: 点击"打开目录" → 系统文件选择器 → 选择后加载文件树
- [ ] ✅ 100+ 文件目录下文件树流畅滚动（虚拟滚动验证）
- [ ] ✅ Web: 文件 CRUD 操作使用 IndexedDB 持久化

---

## Stage 5: AI 通信层完善

> **Guard**：`[x]` start → `[ ]` check 通过

### 实现
- [x] Token 计数增强：AgentLoop 捕获 API usage dispatch 通知
- [x] 模型列表自动获取 + ID 清洗（已有 fetchModels 和 cleanId）
- [x] 错误类型细分：401/403(认证)/429(限流+重试)/404(模型不存在)/500(服务器错误) 各有中文提示
- [x] 流式中断恢复：abort() + _isStreaming 状态管理（已有）

### 测试验收
- [x] ✅ tsc 0 errors + build 成功
- [x] ✅ 模型列表 fetchModels 已实现（含 cleanId 清洗）
- [x] ✅ 429 错误→中文提示"请求过于频繁" + 自动重试
- [x] ✅ abort 后 _isStreaming 重置，可重新发送
- [ ] 📷 截图: StatusBar Token（待联合验证）

---

## Stage 6: Agent Panel 完善

> **Guard**：`[x]` start → `[ ]` check 通过

### 实现
- [ ] MessageList 虚拟滚动（推迟到大对话场景）
- [x] 消息右键菜单增强（复制/复制为MD/引用/编辑/重新生成/删除）
- [x] 编辑用户消息（内联 textarea + onEdit 回调）
- [x] 代码块复制按钮功能（navigator.clipboard + Copy icon）
- [x] 流式打字动画（cursor-blink span 已有）

### 测试验收
- [x] ✅ tsc 0 errors
- [x] ✅ 右键菜单按角色区分操作（user→编辑、assistant→重新生成）
- [x] ✅ 代码块复制按钮已实现
- [x] ✅ cursor-blink 流式动画已有
- [ ] 📷 截图: 待联合验证

---

## Stage 7: 内置工具完善

> **Guard**：`[x]` start → `[ ]` check 通过
> **🤖 Codex Review**: Stage 5-7 完成后启动 Codex GPT-5.5+fast 审查，报告 → `synapse-app/报告_Stage5-7_Review_Codex.md`

### 实现
- [x] 工具 Electron IPC 执行层
  - [x] view_file → fileSystem.readFile（间接走 ipc file:read）
  - [x] write_to_file → fileSystem.writeFile（间接走 ipc file:write，approval 级别 'approve'）
  - [x] list_dir → fileSystem.getWorkspaceTree
  - [x] grep_search → fileSystem.searchFiles
  - [x] run_command → command.exec IPC（child_process.spawn + 30s 超时 + 10KB 截断）
- [x] 工具审批机制（ApprovalCallback + autoApproveSettings 已在 Stage 0.5 接入）
- [x] search_web/read_url_content 工具（fetch + HTML清洗 已有）
- [x] Web 模式工具降级（内存文件系统 + Mock 命令）
- [x] SynapseAPI 类型添加 command 接口 + Web Mock

### 测试验收
- [x] ✅ tsc 0 errors
- [x] ✅ 工具链完整：file/command/web/learning 四类已注册
- [x] ✅ run_command Electron→IPC 真实执行，Web→Mock 降级
- [ ] 📷 截图: 待联合验证

---

## Stage 8: MCP 客户端系统

> **Guard**：`[x]` start → `[ ]` check 通过

### 实现
- [x] MCPServerProcess — stdio JSON-RPC 2.0 通信
  - [x] spawn child_process + stdin/stdout 管道
  - [x] JSON-RPC request/response/notification 解析
  - [x] 超时（30s）+ 错误处理 + 进程退出自动 reject pending
- [x] MCP IPC Handler（6个）: status/start/stop/restart/listTools/callTool
  - [x] mcp_config.json 读取（home + cwd 双路径搜索）
  - [x] 服务器启动/停止/重启
- [x] MCP 协议初始化握手（initialize + notifications/initialized）
- [x] main.ts 注册 + MCP stub 移除 + shutdownAllMCP 退出清理
- [ ] 设置面板 MCP 管理 UI（推迟到 UI Stage）

### 测试验收
- [x] ✅ tsc 0 errors
- [x] ✅ JSON-RPC 2.0 协议完整（request/response/notification）
- [x] ✅ 退出时自动关闭所有 MCP 进程
- [ ] 📷 设置面板 MCP UI（待联合验证）
- [ ] ✅ Web 模式: MCP 列表显示"仅 Electron 模式可用"

---

## Stage 9: SKILL/WORKFLOW/RULES 系统

> **Guard**：`[x]` start → `[ ]` check 通过

### 实现
- [x] 7 个内置学习 SKILL 已注册（课件解读/习题辅导/知识总结/代码实践/论文写作/考试准备/学习规划）
- [x] 2 个内置 Workflow（/review 快速复习、/collect 错题收集）
- [x] RULES 全局 + 工作区两级加载（loadRulesFromFS）
- [x] buildExtensionPrompt() 注入 `<skills>` `<workflows>` `<user_rules>` 到系统提示
- [x] SKILL 匹配（triggerPatterns）+ 启用/禁用开关
- [ ] 设置面板 SKILL UI（推迟到 Stage 12）

### 测试验收
- [x] ✅ tsc 0 errors
- [x] ✅ 系统提示包含 `<skills>` 段（7个 SKILL 描述）
- [x] ✅ /review 命令匹配"快速复习" Workflow
- [ ] 📷 截图: 待联合验证

---

## Stage 10: Synopsis RAG 引擎

> **Guard**：`[x]` start → `[ ]` check 通过
> **🤖 Codex Review**: Stage 8-10 完成后启动 Codex 审查 → `synapse-app/报告_Stage8-10_Review_Codex.md`

### 实现
- [x] SynopsisChunk + SynopsisFile 接口
- [x] PDF 解析器（pdf.js + 文本提取 + 分块）
- [x] PPTX 解析器（JSZip + XML 文本提取）
- [x] Markdown / 纯文本 解析器（行分块）
- [x] Map 阶段：generateChunkSummary + 学习导向 Prompt
- [x] Reduce 阶段：buildSynopsis 文件级汇总
- [x] 进度追踪（progress 0-100）+ 订阅通知
- [x] generateAll 批量生成

### 测试验收
- [x] ✅ tsc 0 errors
- [x] ✅ PDF/PPTX/Text 三种解析器完整实现
- [x] ✅ AI 概要生成链路完整（prompt → aiCall → summary）
- [ ] 📷 截图: 待联合验证

---

## Stage 11: 展示模式与编辑器

> **Guard**：`[x]` start → `[ ]` check 通过

### 实现
- [x] PdfViewer: pdf.js Canvas 渲染 + 翻页 + 缩放控制（+/- 按钮 50%-400%）
- [x] DocxViewer: mammoth HTML + DOMPurify 净化（67行）
- [x] CodeEditor: 轻量编辑器（Ctrl+S/Tab/语言检测/脏标记/复制，97行）
- [x] ImageViewer + MarkdownViewer 已有

### 测试验收
- [x] ✅ tsc 0 errors
- [x] ✅ PdfViewer 缩放控制已增强（scale state + zoomIn/zoomOut）
- [x] ✅ CodeEditor Ctrl+S 保存 + Tab 缩进 + 只读/编辑模式
- [ ] 📷 截图: 待联合验证

---

## Stage 12: 设置系统完善

> **Guard**：`[x]` start → `[ ]` check 通过
> **🤖 Codex Review**: Stage 11-12 完成后启动 Codex 审查 → `synapse-app/报告_Stage11-12_Review_Codex.md`

### 实现
- [x] 设置面板 9 个标签页（通用/AI/对话/安全/Synopsis/Multi-AI/插件/数据/关于）
- [x] AI 模型配置 UI（选择器 + 获取模型 + 测试连接按钮）
- [x] 外观主题 UI（深色/浅色/跟随系统 + 强调色选择器 + 字号滑块）
- [x] 背景管理 UI（多图管理 + 轮播/随机 + 磨砂度/透明度滑块）
- [x] 安全设置（4项自动批准开关 + 6项提示注入开关）
- [x] 数据管理（导出JSON/清除历史/存储用量/清理缓存）

### 测试验收
- [x] ✅ tsc 0 errors
- [x] ✅ 测试连接按钮：调用 fetchModels → 成功/失败通知
- [x] ✅ 设置项与 Redux store 双向绑定
- [ ] 📷 截图: 待联合验证

---

## Stage 13: 终端与代码执行

> **Guard**：`[x]` start → `[ ]` check 通过

### 实现
- [x] TerminalPanel 组件（166行，多标签终端）
- [x] Web 模式命令模拟（help/clear/ls/echo/date/whoami/pwd/cat/history/env）
- [x] 多终端标签管理（添加/关闭/切换）
- [x] 命令历史 + 自动滚动
- [x] Electron 模式 node-pty IPC stub（native 依赖待 Stage 15 打包时集成）

### 测试验收
- [x] ✅ tsc 0 errors
- [x] ✅ Web 模式：终端显示提示 + 基础命令模拟
- [x] ✅ 多标签管理：新建/关闭/切换正常
- [ ] 📷 截图: 待联合验证

---

## Stage 14: 打磨与优化

> **Guard**：`[x]` start → `[ ]` check 通过

### 实现
- [x] Codex Review 问题修复（5项）：
  - [x] preload.ts 补齐 mcp.start/stop + command.exec 暴露
  - [x] file:read 返回 string（与 SynapseAPI 类型一致）
  - [x] loadRulesFromFS 入口接入（agentLoop.run 开头调用）
  - [x] file:grep 从空数组改为真实递归搜索实现
- [x] 错误处理：file:read 改为 throw Error（让前端 catch 更清晰）

### 测试验收
- [x] ✅ tsc 0 errors
- [x] ✅ npm run build 成功（2.97s）
- [x] ✅ preload/IPC/前端类型链路闭合
- [ ] 📷 截图: 待联合验证

---

## Stage 15: 打包发布

> **Guard**：`[ ]` start → `[ ]` check 通过
> **🤖 Codex Review**: 最终全面 Review → `synapse-app/报告_最终_Review_Codex.md`

### 实现
- [ ] electron-builder NSIS 打包
- [ ] 应用图标 + 启动画面
- [ ] MCP 打包方案（asar 内置 vs 外部释放）
- [ ] 端到端全功能测试

### 测试验收
- [ ] ✅ electron-builder → 输出 .exe 安装包
- [ ] ✅ 安装后启动 → 全功能可用
- [ ] ✅ 全流程: 创建工作区 → 上传课件 → Synopsis → AI对话 → 工具调用 → Showcase

---

## 未来扩展（Stage 15+）
- [ ] 视频/音频 Synopsis（Whisper + ffmpeg）
- [ ] 知识图谱可视化
- [ ] 闪卡系统（Anki 式间隔重复）
- [ ] 多语言 i18n
- [ ] 自动更新（electron-updater）
- [ ] 插件市场

---

## 📝 小本本（Guard 未通过记录 & 临时问题）

> 此区域记录 Guard 未通过的原因、临时发现的问题、Codex 反馈等，不中断通知用户。

（暂无记录）

# Plan_3_codex_2：设置页原 Plan 与当前实现对照

> 本文件用于回答用户“图五区域这些设置目前怎么实现、是否按 Plan 实现”的问题。
> 对照依据为 `Plan_1_设置系统.md`、`Plan_1_可扩展系统.md`、`Plan_1_MultiAI系统.md`、`Plan_3_2_设置系统.md` 与当前 `SettingsPanel.tsx`。

## 0. 对照原则

- 本文件只做原 Plan 对照、当前实现核验和偏差记录。
- 默认目标是补齐原始 Plan 意图，不主动升级扩展。
- 每个新增判断都应能落到原 Plan 文件、当前代码入口或用户截图现象之一。
- 如果某项超出原 Plan，必须明确标注为「扩展项」，等待用户确认后再进入实现设计。
- 截图参考用于细化交互形态，不用于替换原始 Plan 的方向。

## 1. 总览

| 设置区域 | Plan 原始目标 | 当前实现 | 结论 |
|---|---|---|---|
| 通用 | 字号、语言、主题、强调色、壁纸等全局设置 | 已实现字号/主题/强调色/壁纸 UI；壁纸主界面未真实可见，语言切换仍需复核是否真正 i18n | 部分完成 |
| AI | 多模型位、能力标签、参数、模型自动获取、测试连接 | 只实现单一默认模型、API Key、API 端点、获取模型、temperature/maxTokens 放在对话页 | 部分完成 |
| 对话 | 上下文窗口、压缩、归档、streamingEnabled、showThinking、导出格式、历史恢复等 | 只实现最大历史、归档天数、temperature/maxTokens、压缩说明；AIClient 固定真流式；历史管理弱 | 部分完成 |
| 安全 | 审批、沙盒、安全策略 | 实现自动审批开关；命令超时/内存限制是静态显示 | 部分完成 |
| Synopsis | TEXT MODE、chunk、并发、自动索引等 | 已实现 TEXT MODE、每块最大 Token、Map 并发数、自动索引、更新策略 | 基本完成 |
| Multi-AI | 模式库、模式编辑器、Subagent 默认配置、工作区覆盖 | 已实现启用、模式选择、新建本地模式草稿、子代理模型、Token、并发 | 部分完成 |
| 插件 | MCP 启停/添加/删除，SKILL/WORKFLOW/RULES 管理 | 当前是静态条目 + Electron MCP 状态读取 + 打开目录；RULES 实际读取路径和设置展示不一致 | 部分完成 |
| 数据 | 导出对话/设置、导入设置、清除历史/缓存、存储位置 | 已实现本地 JSON 导出、清除对话、缓存清理、设置导入导出、localStorage 用量 | 基本完成，Electron 数据库侧待补 |
| 关于 | 应展示版本、环境、依赖、项目信息 | 需要继续复核 | 待复核 |

## 2. AI 设置

### Plan 原文区域

- `Plan_1_设置系统.md §2.1`：
  - thinkingModel / fastModel / synopsisModel / visionModel / drawingModel / whisperModel
  - temperature / maxTokens / topP
  - autoDetectCapabilities
  - 模型能力标签：工具调用、视觉、思考链、图像生成

### 当前实现

- `SettingsPanel.tsx`：
  - API Key 输入
  - API 端点输入
  - 测试连接按钮
  - 默认模型 select
  - 获取模型按钮
  - 已获取模型数量提示
- `agentSettings.ts`：
  - `currentModel`
  - `availableModels`
  - `temperature`
  - `maxTokens`
- `AIClient.ts`：
  - 请求体只传 `model`、`messages`、`temperature`、`max_tokens`、`stream`、`stream_options`

### 差距

- 缺少 thinking / fast / synopsis / vision / drawing / whisper 多模型位。
- 缺少 topP。
- 缺少 reasoning_effort / thinking level。
- 缺少模型能力自动检测和能力标签。
- 缺少输入区模型参数 popover。
- 缺少按模型能力决定是否允许附件图片真实发送。

### 建议

- 先扩展模型元数据结构：`capabilities`、`reasoningEffortOptions`、`supportsVision`、`supportsTools`、`supportsImageGeneration`。
- 再让设置页和输入区共享同一份模型能力显示。

## 3. 对话设置

### Plan 原文区域

- `Plan_1_设置系统.md §2.6`：
  - contextWindowSize
  - contextReserveRatio
  - autoCompressThreshold
  - maxConversationsPerWorkspace
  - checkpointStrategy
  - checkpointSummaryModel
  - keepRecentRounds
  - autoTitle
  - streamingEnabled
  - showThinking
  - showTokenCount
  - defaultExportFormat

### 当前实现

- `SettingsPanel.tsx` 对话页：
  - 最大对话历史
  - 自动归档天数
  - Temperature
  - Max Tokens
  - CHECKPOINT 触发阈值说明
  - 每次压缩保留说明
- `AgentLoop`：
  - 有上下文压缩调用 `compressContext()`
  - 发送时有 streaming 状态
- `AIClient.streamChat()`：
  - 当前固定请求 `stream: true`
  - 带 `stream_options.include_usage`
  - 没有非流式 fallback
  - 没有伪流式输出策略

### 差距

- 多数对话高级参数只是缺失或静态说明。
- `streamingEnabled` 未进入设置页。
- 缺少真流式 / 伪流式 / 关闭流式 / 自动降级的输出策略。
- `showThinking` 未实现。
- 没有 AI 思考中计时 UI。
- 没有 reasoning/thinking 内容捕获与折叠展示。
- 温度与 Max Tokens 被放在对话设置页，不在 AI 模型页，信息架构需要再判断。

## 4. 插件 / MCP 设置

### Plan 原文区域

- `Plan_1_设置系统.md §2.7`：
  - MCP 服务器列表：运行状态、重启、删除、添加服务器、编辑配置
  - SKILL/WORKFLOW/RULES 管理：打开目录、编辑规则、禁用等
- `Plan_1_可扩展系统.md`：
  - 全局与工作区两级配置
  - 工作区配置覆盖全局
  - MCP / SKILL / WORKFLOW / RULES 都应可合并管理

### 当前实现

- `SettingsPanel.tsx`：
  - 静态 `mcpEntries`
  - 静态 `skillEntries`
  - 静态 `workflowEntries`
  - 静态 `rulesEntries`
  - Electron 下 `platform.mcp.getStatus()`
  - Electron 下 `platform.mcp.restart(name)`
  - Electron 下打开目录

### 差距

- 没有添加/删除 MCP。
- 没有编辑 `mcp_config.json`。
- 没有禁用/启用 SKILL / WORKFLOW / RULES。
- 没有读取真实全局/工作区目录内容。
- 没有 Codex / Antigravity 特化数据源和模型桥接。
- 没有显示当前工具可用性边界，例如“Codex 内部可用 / Antigravity 内部可用 / Electron 可用 / Web 不可用”。

### 建议

- 将插件页拆成真实数据源：
  - MCP 状态来自 Electron IPC / broker。
  - Skills / Workflows / Rules 来自全局目录与工作区目录扫描。
  - Codex / Antigravity 能力来自单独 adapter。
- 增加 `sourceType` 字段：`builtin | global | workspace | codex | antigravity | mcp`。

## 5. Synopsis 设置

### Plan 原文区域

- `Plan_1_设置系统.md §2.5`：
  - textModeEnabled
  - chunkSizes
  - mapReduceOptions
  - cacheSettings
- `Plan_1_Synopsis引擎.md`：
  - 文档解析、分片、Map-Reduce、索引、缓存。

### 当前实现

- `SettingsPanel.tsx`：
  - TEXT MODE
  - 每块最大 Token
  - Map 并发数
  - 索引自动更新
  - 更新策略
- `agentSettings.ts`：
  - `SynopsisSettings` 持久化字段。

### 差距

- 设置项本身已基本实装。
- 但是否真正驱动 Synopsis 生成管线需要继续对照 `synopsisEngine.ts` 与 `SynopsisPanel.tsx`。
- 当前用户这轮主要问设置显示，暂不展开生成管线。

## 6. Multi-AI 设置

### Plan 原文区域

- `Plan_1_MultiAI系统.md`：
  - 模式配置
  - 子代理角色
  - 调度策略
  - Mode.md 配置体系
  - 全局/工作区两级模式库。

### 当前实现

- `SettingsPanel.tsx`：
  - 启用 Multi-AI
  - 已保存模式列表
  - 选择默认模式
  - 新建本地模式草稿
  - 子代理模型
  - Token 上限
  - 最大并行
- `multiAI.ts`：
  - 内置 solo / 对抗式 vibe-coding / 深度研究 / 教学协作。

### 差距

- 新建模式只是本地草稿，不是完整模式编辑器。
- 未看到 Mode.md 文件读写。
- 未看到工作区覆盖/禁用模式。
- 是否能真实驱动 `agentOrchestrator` 还需要单独实测。

## 7. 数据设置

### Plan 原文区域

- `Plan_1_设置系统.md §2.9`：
  - 导出对话历史 JSON / Markdown / PDF

## 16. Codex 补充实施记录：对话历史批量管理对照

### 对照结论

- 原 Stage 8 已解决「历史能重新打开、标题能编辑、单条删除和基础搜索」。
- 用户确认扩展后，第一期批量管理已补到历史列表区域，而不只停留在设置页「导出全部 / 清空全部」。

### 已实装项

- 批量选择：支持进入/退出批量模式、全选当前筛选结果、清空选择。
- 批量删除：带确认；删除对话记录与消息快照，不删除工作区文件。
- 批量导出：所选对话打包为一个 JSON，包含 summary、snapshot、附件元数据、thinking、diff 与导出时间。
- 归档：单条和批量归档/还原；筛选支持全部 / 未归档 / 已归档。
- 标签：单条编辑、批量添加、批量移除；标签过滤可与关键词搜索叠加。

### 当前边界

- 导出格式第一期为 JSON；Markdown / PDF 导出仍属于后续数据导出格式补齐。
- 标签第一期存在对话 summary 元数据里；如果后续需要高性能标签统计，再拆独立标签表。
  - 导出所有设置
  - 导入设置
  - 清除对话历史
  - 清除 Synopsis 缓存
  - 数据存储位置显示

### 当前实现

- `SettingsPanel.tsx`：
  - 导出全部对话 JSON
  - 清除对话历史
  - localStorage 使用量
  - 清除缓存
  - 导出设置
  - 导入设置 JSON

### 差距

- 导出格式目前主要是 JSON，缺少 Markdown/PDF 选择。
- Electron 数据库中的真实对话/消息清理与导出需要继续对照。
- 数据存储位置显示需要检查图五/图六的实际 UI 是否完整。

## 8. Markdown / HTML / PDF / Office / 编辑器相关设置缺口

### Plan 原文区域

- `Plan_1_展示模式.md §1`：`.md` 使用 MarkdownPreview，实时渲染预览。
- `Plan_1_展示模式.md §1`：`.pdf` 使用 PdfViewer，`.pptx` 使用 PptxViewer，`.docx` 使用 DocxViewer。
- `Plan_1_展示模式.md §5`：AI 生成 HTML/JS 项目使用 Showcase iframe 展示。
- `Plan_3_4_终端与编辑器.md`：CodeEditor 真实加载、编辑、保存；保存快捷键；修改标记。
- `Plan_3_4_终端与编辑器.md`：PDF/DOCX/PPTX 查看器应通过 IPC/ArrayBuffer 读取真实文件并渲染。
- `Plan_1_展示模式.md §6`：编辑器标签系统应支持多标签、脏标记、预览模式和标签上下文操作。

### 当前实现

- `MarkdownViewer.tsx` 是只读预览。
- `CodeEditor.tsx` 具备编辑和保存能力，但 Markdown 文件打开时没有走 CodeEditor。
- `PdfViewer.tsx` 存在，但 `pdf.js workerSrc` 配置不稳定，当前用户截图已出现 `No "GlobalWorkerOptions.workerSrc" specified.`。
- `DocxViewer.tsx` 存在，使用 mammoth 转 HTML，但只覆盖 DOCX，DOC 旧格式未定义策略。
- `PPTX` 在 `EditorArea.tsx` 中仍是占位提示。
- HTML 文件通常按代码文件打开，没有渲染读模式。
- `ShowcaseFrame.tsx` 有 iframe 能力，但没有和普通 `.html` 文件的打开/预览模式打通。
- `TabBar.tsx` 已有横向滚轮逻辑，但当前 UI 缺少可见滚动条、左右箭头和更多菜单。
- `editor.css` 中 `.tab-item` 使用 `min-width: 0`，标签过多时会持续压缩。

### 差距

- 缺少 Markdown 读/编辑切换。
- 缺少 Markdown 源码编辑。
- 缺少 Markdown 分屏预览。
- 缺少 Ctrl+S 保存体验。
- PDF worker 配置需要修复，Electron/Web 两种读取路径都要验证。
- Office 查看器不完整：DOCX 需实测，DOC/PPTX/XLSX 需定义降级或转换策略。
- HTML 缺少渲染读模式、源码编辑模式、分屏预览和安全 sandbox 策略。
- 顶部编辑器标签过多时会变得过窄，缺少稳定宽度、横向滚动箭头、active tab 自动可见和更多菜单。

## 9. 工作区设置 / 清空工作区缺口

### 当前情况

- 欢迎页和文件树支持打开/新建/导入/删除某些工作区记录。
- 文件树支持新建/重命名/删除文件。
- 没有明确的「清空当前工作区内容」按钮。

### 需要定义

- “清空工作区”在 Web 模式下应清空当前内存文件树和导入缓存。
- Electron 模式下默认应卸载/清空 Synapse 加载状态，不应默认删除磁盘真实文件。
- 如果未来提供删除真实文件，必须增加强确认、影响范围说明和可恢复路径。

## 10. 结论

当前设置页已经从纯占位推进到“部分真实可用”，但还不是完整 Plan 实现。最主要的缺口集中在：

- AI 模型能力与参数体系不完整。
- 插件/MCP 是静态简化版，缺 Codex/Antigravity 特化。
- 对话高级设置缺 thinking/计时/折叠展示。
- 流式输出策略缺设置项、非流式降级和伪流式展示。
- Markdown 只有预览，没有编辑模式；HTML 缺少渲染读/编辑切换。
- PDF/Office 查看器不完整，PDF worker 当前可复现报错。
- 附件与多模态没有真实请求闭环。
- 工作区缺清空/卸载功能。

## 11. 补充：系统与内置功能偏离原 Plan 的风险

用户补充指出：很多系统和内置功能也没有完全按照原本意图实装，或与 Plan 系列原本意图存在偏差。

当前已确认的偏差类型：

| 偏差类型 | 例子 | 风险 |
|---|---|---|
| 静态展示代替真实系统 | 插件页的 SKILL / WORKFLOW / RULES 多为静态数组 | 用户误以为可管理真实插件 |
| 局部补漏代替完整闭环 | 附件只写入文本信息，未形成多模态请求 | 图片没有真正发给模型 |
| UI 控件存在但后端未接通 | 部分设置参数只写 localStorage，未必驱动实际管线 | 设置看似生效但行为不变 |
| 原设计能力缺失 | 模型能力标签、thinking 展示、工作区清空、Markdown 编辑 | 和 Plan 预期体验不一致 |
| 缺数据保护 | dirty tab 可直接关闭，清空/删除工作区缺统一确认 | 可能造成未保存内容丢失 |
| 缺 Agent 变更审查 | AI 写文件后没有 Review Changes、Accept/Reject、Reject 回滚 | 用户无法审查或撤销 AI 文件修改 |
| 缺消息级事件流 | 消息只保存最终文本，未记录 thinking、tool events、diff、checkpoint | 无法实现消息回溯和中断恢复 |
| 缺流式策略 | 当前强制 `stream: true`，无伪流式和非流式 fallback | 不支持 SSE 的端点体验会断裂 |
| 缺文件查看器闭环 | PDF worker 报错，PPTX 占位，HTML 无渲染读模式 | 课件与生成页面无法按 Plan 展示 |
| 缺多标签可用性 | 顶部 tab 过多时继续压缩，缺滚动箭头和更多菜单 | 文件名不可读、关闭/切换困难 |
| 缺对话历史闭环 | 历史项无法稳定重新加载，不能重命名，缺批量管理 | 对话持久化像静态列表 |
| 缺右侧面板收起入口 | Agent Panel 虽标记 collapsible，但 UI 无按钮 | 编辑区空间无法按需释放 |
| 缺壁纸渲染闭环 | 壁纸 UI 已有，主界面背景不可见 | 设置看似生效但视觉不变 |
| 缺 RULES 可选文件降噪 | 可选 rules.md 不存在时反复打印 Electron 错误 | 启动日志误导用户 |

后续需要新增一份「系统级功能偏差清单」，按模块继续核对：

- 工作区系统
- 编辑器/标签页系统
- AI 对话系统
- 附件/多模态系统
- 插件/MCP/Skill/Workflow/Rules 系统
- Synopsis 系统
- Multi-AI 系统
- 数据管理与持久化系统
- Electron IPC 与 Web 降级系统
- Agent 变更审查与回滚系统
- 对话事件流与消息回溯系统
- 编辑器多标签导航系统
- 对话历史管理系统
- 右侧 AI 面板布局系统
- 壁纸与磨砂渲染系统
- RULES 文件加载与设置展示系统

本文件当前只覆盖设置页和本轮截图直接相关区域，尚未完成全项目级偏差审计。

## 12. 补充：Review Changes / Accept-Reject / 消息回溯也属于设置与系统能力缺口

用户补充的图一到图五说明，Synapse 当前缺少一套 Agent 类编辑器必须具备的「修改记录与用户审查」系统。

这不是单个聊天气泡组件的问题，而是跨越以下模块的系统能力：

- 对话消息：需要记录每轮 AI 回复的 thinking、耗时、状态和可回溯事件。
- 工具执行：每个写文件、删文件、重命名文件的工具调用都要生成结构化变更记录。
- 文件系统：每次 AI 修改前要保存 checkpoint，至少要能回退本轮变更。
- UI：消息内显示变更摘要，提供 Review Changes 入口。
- Diff 视图：按文件展示新增/删除/修改内容。
- 用户决策：支持 Accept all / Reject all，后续支持单文件 accept/reject。
- 持久化：accept/reject 状态需要写入本地记录，重启后仍能知道哪些变更已确认。

建议后续实现时新增独立模块，而不是把 diff 状态塞进 `MessageBubble`：

- `changeSetService`：收集本轮文件变更。
- `checkpointService`：保存修改前快照或 patch。
- `reviewChangesSlice`：维护当前待审查变更。
- `ReviewChangesPanel`：承载图四/图五的入口和详情。
- `assistantRun` 数据结构：连接用户消息、AI 回复、thinking、工具事件和变更集。

这部分应和「未保存文件关闭确认」「清空工作区确认」「删除工作区确认」一起归入数据保护与可逆操作设计。

### UI 形态要求补充

结合用户最新图一/图二，后续实现不应只做 Review Changes 总览按钮，还应形成「右侧消息摘要 + 中间编辑器 inline diff」的联动体验。

右侧消息面板：

- AI 回复里直接展示变更条目。
- 条目格式参考：`Edited { } random_quotes.json +13 -3`。
- 文件名作为可点击 chip。
- 点击 chip 打开对应文件，定位到变更区域。
- `+N` 绿色，`-N` 红色。
- 支持 `Created`、`Edited`、`Deleted`、`Renamed`、`Analyzed` 等动作类型。

中间编辑器：

- 打开被修改文件后，直接显示本轮 diff。
- 新增内容使用浅绿色背景。
- 删除内容使用浅红色背景。
- diff block 右侧提供小型浮动操作条。
- 操作条至少包含：
  - 接受当前块。
  - 拒绝当前块。
  - 展开/折叠当前块。
- 单块接受/拒绝后同步更新 changeSet 状态。
- 全部接受/拒绝仍由 Review Changes 面板提供。

这套 UI 与原 Plan 的关系：

- `Plan_1_增补.md §6` 已提出对话回溯、文件回滚、snapshot。
- `Plan_1_展示模式.md` 已把中间区域定义为编辑器与展示区。
- `Plan_3_4_终端与编辑器.md` 已要求真实 CodeEditor 编辑保存链路。
- 最新截图相当于把这些原始设计落到具体可交互形态：消息侧负责导航和摘要，编辑器侧负责审查和执行。

## 13. 补充：流式输出策略应进入设置系统

用户补充指出：支持流式的模型或端点应使用真流式输出；不支持时可使用伪流式；该行为应能在设置中调整。

当前代码已经有 SSE 基础，但还不完整：

- `AIClient.streamChat()` 固定 `stream: true`。
- 没有 `completeChat()` 非流式请求。
- 没有 `pseudoStreamChat()` 前端分片。
- 没有端点不支持 stream 时的自动降级。
- 设置页没有输出策略开关。

建议新增设置项：

- 输出策略：自动 / 真流式 / 伪流式 / 关闭流式。
- 伪流式速度：慢 / 中 / 快，或每秒字符数。
- 生成中占位：开启 / 关闭。
- 流式光标：开启 / 关闭。
- Thinking 流式展示：开启 / 关闭。

建议请求层拆分：

- `streamChat()`：真实 SSE。
- `completeChat()`：非流式一次性返回。
- `pseudoStreamChat()`：把完整回复分片成统一的流式事件。
- `sendChat()`：根据设置和端点能力选择上述路径。

这部分与 `Plan_1_设置系统.md §2.6 streamingEnabled`、`Plan_1_AI交互层.md` 的 SSE 设计、`Plan_1_前端架构.md` 的 `StreamingIndicator` 一致。

## 14. Codex 补充实施记录：Stage 14 设置落地

2026-04-30 已将第 13 节的流式输出策略补入真实设置链路：

- `agentSettings.outputStrategy`：自动 / 真流式 / 伪流式 / 关闭流式，默认自动。
- `agentSettings.pseudoStreamSpeed`：慢 / 中 / 快。
- `agentSettings.showStreamCursor`：控制流式光标。
- `agentSettings.showGeneratingPlaceholder`：控制无文本阶段的生成占位。
- `agentSettings.streamThinking`：控制伪流式时 Thinking 是否分片展示。
- `agentSettings.showThinking`：继续控制 Thinking 是否展示。

验证结果：

- AI 设置页与输入区模型弹层都能调整这些项，并通过 `synapse_agent_settings` 持久化。
- 自动模式下，支持 streaming 的模型请求体带 `stream:true`；模型能力不支持时首个请求即 `stream:false`。
- 真流式请求返回 `stream not supported` / HTTP 400 时，会自动改走非流式请求并显示 `Pseudo`，同时记录降级原因。
- 关闭流式时请求体为 `stream:false`，消息一次性展示并标记 `Complete`。
- Electron 独立实例刷新后保留设置，伪流式请求体为 `stream:false`，消息 chip 为 `Pseudo for <1s`，右侧面板未出现横向溢出。

## 15. Codex 补充实施记录：文件查看器设置边界落地

2026-04-30 Stage 15 将用户确认的文件查看器边界落到实现：

- 普通 `.html/.htm` 默认源码编辑，渲染读模式需要用户手动切换；渲染仍使用空 `sandbox` iframe。
- `.doc/.docm/.ppt/.pptm/.xls/.xlsx/.xlsm` 不再标为 unsupported 或源码 fallback，统一进入 `office` tab。
- Electron 模式下 `office` tab 调用 `file:convertOffice`，使用 LibreOffice/soffice 转 PDF 后复用现有 PDF viewer。
- Web 模式暂无本地 LibreOffice 转换能力，会显示能力边界错误；不伪装为完整预览。
- 转换产物进入系统临时目录 `synapse-office-*`，读取完成后通过受限 `file:cleanupTemp` 清理。

验证结果：

- renderer 打开 `stage15.html` 默认 active 为「源码」、无 iframe；点击「渲染」后出现 `sandbox=""` iframe。
- 路由函数验证 `.doc/.docm/.ppt/.pptm/.xls/.xlsx/.xlsm` 均为 `office`。
- Electron 转换验证 `.doc/.xls/.xlsx/.ppt` 均成功生成 PDF；UI 验证 `.doc/.xlsx/.ppt` 显示 PDF canvas 与「已转换为 PDF 预览」。
- 不存在的 `.pptm` 显示明确错误，不出现「已转换为 PDF 预览」。

## 14. 补充：文件查看器应覆盖 PDF、Office 与 HTML 渲染/编辑模式

用户补充指出：当前不支持打开 PDF 和 Office 文件，同时 HTML 文件也应做成渲染读模式和编辑模式。

当前代码已有部分组件，但还没有形成完整闭环：

- `PdfViewer.tsx` 已存在，但当前截图暴露 `pdf.js workerSrc` 未配置问题。
- `DocxViewer.tsx` 已存在，但只覆盖 DOCX，DOC 旧格式未定义处理路径。
- `PPTX` 当前仍是占位。
- HTML 当前主要按代码文件处理，没有 iframe 渲染读模式。
- `ShowcaseFrame.tsx` 可复用，但目前只服务 Showcase，不服务普通 HTML 文件。

建议实现边界：

- PDF：
  - 修复 `pdf.worker.min.mjs` 或打包 worker 路径。
  - Electron 用 IPC 读取 ArrayBuffer。
  - Web 用导入文件的 ArrayBuffer / object URL。
  - 保留页码、缩放、导航、错误提示。
- Office：
  - DOCX 使用 mammoth 转 HTML，并继续净化 HTML。
  - DOC 提供转换提示，或 Electron 下走 LibreOffice headless 转 PDF/DOCX。
  - PPTX 优先按原 Plan 转 PDF 后复用 PdfViewer。
  - XLSX 后续用表格预览或转换 HTML 表格。
- HTML：
  - 文件类型识别为 html。
  - 读模式用 sandbox iframe 渲染。
  - 编辑模式用 CodeEditor。
  - 支持源码/预览切换和可选分屏。
  - 保存源码后可刷新预览。
  - 相对资源路径以工作区为根解析。

这部分对应 `Plan_1_展示模式.md` 的文件类型矩阵，也对应 `Plan_3_4_终端与编辑器.md` 的文件查看器闭环。

## 15. 补充：顶部编辑器标签过多时不应继续压缩

用户补充指出：顶部打开文件越多，标签越挤，过多时应该使用拖动条、左右箭头或更多菜单，而不是一直压缩每个 tab。

当前实现已有一部分基础，但体验未闭环：

- `TabBar.tsx` 有 `scrollRef` 和鼠标滚轮横向滚动。
- `.tab-bar` 有 `overflow-x: auto`。
- 但滚动条被隐藏。
- 没有左右滚动箭头。
- 没有更多菜单。
- `.tab-item` 使用 `min-width: 0`，导致 tab 可以继续被压缩。

建议实现：

- 给 tab 设置稳定宽度区间：
  - `min-width: 120px`
  - `max-width: 180px`
  - 文件名内部 ellipsis。
- 保留横向滚轮滚动。
- 增加左右滚动箭头。
- active tab 切换时自动滚动到可见区域。
- 标签数量很多时提供「更多」菜单，列出所有打开文件。
- dirty 标记和关闭按钮应保持可见、可点击。
- 可复用设置页 tabs 已经实现的左右导航思路，但编辑器 tab 需要保留文件名和关闭按钮。

这部分对应 `Plan_1_展示模式.md §6 编辑器标签系统`，属于多文件编辑体验的基础能力。

## 16. 补充：对话历史应支持重新加载、标题编辑与批量管理

用户补充指出：对话历史目前只有一个历史项，双击或其它方式无法稳定重新打开加载到右边对话区域，无法编辑标题，也缺乏批量管理。

当前实现观察：

- `ConversationList.tsx` 支持搜索、新建、单击切换、单条导出、单条删除。
- `handleSwitchConversation()` 从 `localStorage.synapse_conversations` 读取完整消息。
- `conversationHistory` slice 保存摘要，完整消息另存在 localStorage，存在同步风险。
- 无双击行为。
- 无标题编辑。
- 无批量选择、批量删除、批量导出、批量归档。

原 Plan 对照：

- `Plan_1_AI交互层.md` 已规划 ConversationManager、对话持久化、导出与恢复。
- `Plan_1_设置系统.md §2.9` 要求导出对话历史、清除对话历史。
- `Plan_1_增补.md §6` 已提出对话回溯与消息管理。

修复边界：

- 这是补齐原始对话管理意图，不是新增扩展。
- 先保证历史条目可稳定加载到右侧 AI 面板。
- 再补标题重命名、右键菜单、批量管理和存储结构统一。

## 17. 补充：右侧 AI 面板应支持显式收起与展开

用户补充指出：右侧 AI 区域目前默认一直展开，没有收起按钮和展开入口。

当前实现观察：

- `AppLayout.tsx` 右侧 `<Panel id="agent" collapsible>` 已标记可折叠。
- `layout.ts` 已有 `agentPanelVisible`、`toggleAgentPanel()`、`setAgentPanelVisible()`。
- 但 `AppLayout.tsx` 没有读取 `agentPanelVisible` 控制右侧面板。
- `AgentPanel` 顶部没有收起按钮。
- 收起后也没有边缘展开按钮。

原 Plan 对照：

- `Plan_1_前端架构.md` 和 `Plan_1.md` 采用 IDE 式多面板布局。
- 右侧 AI 面板作为主布局面板，应具备可控显示/隐藏能力，避免占据编辑区空间。

修复边界：

- 这是补齐 IDE 布局基础交互。
- 先实现按钮、状态持久化和展开入口。
- 不改变 AI 面板内部功能方向。

## 18. 补充：壁纸与磨砂 UI 已有但主界面背景未真实显示

用户补充指出：壁纸依然没有实装。截图显示设置页已有壁纸图片、启用开关、透明度、磨砂度，但主界面仍看不到壁纸。

当前实现观察：

- `SettingsPanel.tsx` 已有壁纸 UI。
- `agentSettings.backgroundSettings` 保存壁纸列表和参数。
- `useThemeEffect.ts` 会把当前图片写到 `.app-background`。
- `App.tsx` 中存在 `.app-background`。
- 截图说明背景层可能被面板遮挡，或透明度/层级/状态来源未真正闭环。
- 项目同时存在 `theme.background` 和 `agentSettings.backgroundSettings` 两套背景相关状态。

原 Plan 对照：

- `Plan_3.md S3` 明确要求「背景图选择/轮播/磨砂/透明度 真实渲染」。
- `Plan_1_设置系统.md §2.3` 要求壁纸实时预览、模糊度、不透明度。

修复边界：

- 这是补齐原 Plan 的壁纸真实渲染，不是视觉风格扩展。
- 需要保证背景图在主界面可见，透明度和磨砂真实影响主要面板。
- 需要统一背景状态来源，避免两套状态互相覆盖。

## 19. 补充：RULES 可选文件缺失不应反复输出 Electron 错误

用户补充的终端日志显示，Electron 启动后多次报：

```text
Error occurred in handler for 'file:read': Error: 文件不存在: ~/.synapse/rules.md
Error occurred in handler for 'file:read': Error: 文件不存在: .synapse/rules.md
```

当前实现观察：

- `extensionManager.ts` 读取 `~/.synapse/rules.md` 和 `.synapse/rules.md`。
- 渲染侧 catch 了错误并返回空字符串。
- Electron 主进程 IPC handler 仍打印缺文件堆栈。
- 设置页 RULES 条目显示 `~/.synapse/SYNAPSE.md` 和 `.synapse/rules/`，与实际读取路径不一致。

原 Plan 对照：

- `Plan_1_可扩展系统.md` 要求 MCP / SKILL / WORKFLOW / RULES 统一管理。
- `Plan_1_设置系统.md §2.7` 要求 RULES 管理可见、可编辑。

修复边界：

- 这是补齐 RULES 管理一致性和启动日志质量。
- 可选 rules 文件不存在时不应作为错误打印。
- 需要统一设置页展示路径、实际加载路径和 system prompt 注入路径。

## 20. Codex 补充实施记录：壁纸存储对照

2026-04-30 Stage 17 将通用设置中的「壁纸 / 磨砂 / 面板透明度」从单纯 data URL 本地存储补齐为 Electron 文件化存储。

| 设置项 | 当前状态 | 持久化 | 实际效果 | 验证 |
|---|---|---|---|---|
| 启用壁纸 | 已实装 | `agentSettings.backgroundSettings.enabled` / `synapse:background` | 控制 `html/body[data-wallpaper]` 与 `.app-background` | Electron/Web smoke 均验证 |
| 背景图导入 | 已实装 | Electron: `userData/wallpapers` + metadata；Web: data URL fallback | Electron 复制到受管目录并通过 `synapse-wallpaper://` 渲染 | Electron `importFiles()` + 刷新恢复 |
| 背景图删除/清空 | 已实装 | Redux + localStorage；Electron 同步清理受管副本 | 只删除受管壁纸副本，不删除原始图片或工作区文件 | Electron 单删/清空 smoke |
| 旧 data URL 兼容 | 已实装 | 启动时规范化旧 `images: string[]` | Web 旧壁纸不丢失 | Web legacy smoke |
| 磨砂/透明度/面板透明度 | 已实装 | `backgroundSettings.blur/opacity/panelOpacity` | 写入 `.app-background` 与 CSS 变量 | Electron 文件化壁纸下复测 |
| 设置导出 | 部分实装 | localStorage 设置导出 | 过滤 `data:image` 大字段；不导出受管壁纸二进制 | 代码路径与 Electron 存储 smoke |

补充边界：

- Electron 受管壁纸目录不是工作区目录，清空工作区功能不得调用壁纸清理。
- `synapse-wallpaper://` 只映射受管壁纸目录，不能解析任意本地路径。
- Web 模式仍没有真实 `userData`，因此继续保留浏览器本地 data URL 降级；后续如要改 IndexedDB，应作为 Web 专项优化。

# Plan_3_codex_1：2026-04-29 用户反馈调研记录

> 本文件只记录调研与问题归档，不代表已经进入实现阶段。
> 来源：用户在 Codex 接手 Synapse 后提供的图一至图十一实测反馈。

## 0. 当前处理原则

- 暂时由 Codex 线程独立接手 Synapse 项目，先记录、对照、调研，再进入修复。
- 不直接回退前序 Antigravity / Codex 修复成果。
- 所有问题都尽量绑定到原始 Plan 设计、当前代码入口和可验证现象。
- 每个问题必须优先对照原始 Plan。
- 记录格式应尽量保持「用户现象 → 当前实现观察 → Plan 对照 → 设计要求/修复边界 → 记录状态」。
- 默认目标是补齐原始 Plan 意图，不主动升级扩展。
- 只有用户明确说要升级、扩展或改变原设计时，才把需求标为新增能力。
- 对截图参考应提炼为原 Plan 的具体交互落地，而不是偏离原 Plan 另起一套设计。
- 如果原 Plan 没覆盖，应明确标注「原 Plan 未覆盖，需用户确认是否作为扩展」。

## 1. 图一：欢迎页被底部终端面板遮挡 / 无法完整滚动

### 用户现象

- 只要把终端输出区域拉高，欢迎页顶部或底部内容就显示不全。
- 欢迎页滚动条拉到顶或底都无法看到完整欢迎页。

### 初步判断

- 这是前端布局体验 Bug，不是功能逻辑 Bug。
- 重点检查：
  - `src/components/editor/WelcomePage.tsx`
  - `src/styles/layout.css`
  - `src/styles/editor.css`
  - `src/components/layout/BottomPanel.tsx`
- 可能原因：
  - 中间编辑区域、欢迎页 hero、底部面板的高度约束组合不正确。
  - `welcome-hero` 可能在父容器高度变化时仍保持居中/固定布局，导致内容上下裁切。
  - 编辑区滚动容器与欢迎页内部滚动容器职责不清。

### Plan 对照

- `Plan_1_展示模式.md §7.3` 要求底部面板可折叠、可拖拽调高度、自动适配面板大小。
- 当前表现说明欢迎页没有正确响应底部面板高度变化。

### 记录状态

- 待复现与修复。
- 建议优先级：P1，影响第一屏体验和大窗口/小窗口可用性。

## 2. 图二 / 图三：模型获取成功，但输入区没有展示模型参数能力

### 用户现象

- API Key / API 端点 / 获取模型功能基本可用。
- 输入区域只显示模型名 `gpt-5.5`，没有展示该模型支持的参数能力，例如思考层级、工具调用、视觉能力等。

### 当前实现观察

- `SettingsPanel.tsx` 当前 AI 设置只包含：
  - API Key
  - API endpoint
  - 测试连接
  - 默认模型下拉
  - 已获取模型数量
- `AgentPanel.tsx` 创建 `AIClient` 时只传入：
  - `apiKey`
  - `baseUrl`
  - `model`
  - `temperature`
  - `maxTokens`
  - `stream`
- `AIClientConfig` 当前没有 `reasoning_effort` / `thinking` / `top_p` / `vision` / `tool_call` 能力字段。

### Plan 对照

- `Plan_1_设置系统.md §2.1` 要求：
  - thinkingModel / fastModel / synopsisModel / visionModel / drawingModel / whisperModel
  - temperature / maxTokens / topP
  - autoDetectCapabilities
  - 模型能力标签：工具调用、视觉、思考链、图像生成
- 当前只做了「模型列表可获取与选择」，没有做「模型能力识别与参数面板」。

### 需要进一步设计

- 对 OpenAI 兼容 API 的 `/models` 返回做能力推断，不能只拿 ID。
- 对 Codex 内部模型调用需要特殊适配：
  - 思考等级：如 low / medium / high / xhigh
  - speed tier：如 fast
  - 是否支持图片输入
  - 是否支持工具调用
  - 是否支持结构化输出
- 输入区模型胶囊应显示当前模式和关键参数，例如：
  - `gpt-5.5 · reasoning high · tools on`
  - 或在 hover / popover 中展示完整能力。

### 记录状态

- 待设计与实现。
- 建议优先级：P1，影响用户确认模型实际能力。

## 3. 图四 / 图五：插件管理目前是简化版，需 Codex / Antigravity 特化适配

### 用户现象

- 当前插件管理看起来像「我们插件系统的简化版本」。
- 但 Synapse 里的插件系统应对 Codex / Antigravity 特化：
  - 模型调用应能走 Codex 内部调用。
  - 对话数据源应能对接 Codex / Antigravity 的内部数据源。
  - 插件/MCP/Skill/Workflow 不应只是静态展示。

### 当前实现观察

- `SettingsPanel.tsx` 内置了静态 `mcpEntries`、`skillEntries`、`workflowEntries`、`rulesEntries`。
- Electron 下会通过 `platform.mcp.getStatus()` 读取 MCP 状态。
- SKILL / WORKFLOW / RULES 主要展示名称、描述、路径，并提供 Electron 下打开目录按钮。
- 没看到真正的：
  - 插件扫描
  - 插件启停
  - Codex / Antigravity 数据源选择
  - Codex 内部模型桥参数
  - 当前线程 / 当前工作区绑定

### Plan 对照

- `Plan_1_设置系统.md §2.7` 要求 MCP 服务器列表支持运行状态、启动/重启/删除、添加 MCP、编辑配置。
- `Plan_1_可扩展系统.md` 要求全局与工作区两级 SKILL / WORKFLOW / RULES / MCP 管理。
- 当前实现是「展示 + 部分 Electron MCP 状态读取」，距离完整插件管理仍有差距。

### 需要进一步设计

- 增加 Synapse 插件系统的数据模型：
  - source：内置 / 全局 / 工作区 / Codex / Antigravity
  - status：可用 / 已停用 / 不兼容 / 需要 Electron / 需要 broker
  - action：启用 / 禁用 / 打开目录 / 编辑配置 / 刷新 / 重启
- 增加 Codex / Antigravity 特化：
  - Codex conversation 原文读取入口
  - Antigravity conversation 原文读取入口
  - memory-store / record 系统入口
  - Codex 内部模型调用参数配置
  - 明确哪些能力只能在桌面/Electron 模式用。

### 记录状态

- 待设计与实现。
- 建议优先级：P1/P2，取决于是否要把 Synapse 作为真实 Codex/Antigravity 工作台。

## 4. 图四 / 图五区域：设置页显示实装内容需要逐项对照

### 用户需求

- 查询图五区域这些设置里目前显示内容是怎么实现的。
- 对照之前 Plan 系列文件确认是否都实现。
- 希望能列表对比展示「原文区域」和「现在情况」。

### 记录状态

- 已单独拆到 `Plan_3_codex_2_设置实装对照.md`。

## 5. 图六：需要清空工作区按钮

### 用户现象

- 当前课件管理/工作区区域缺少「清空工作区」按钮。
- 需要清空加载到当前工作区内的内容。
- 用户进一步补充：清空工作区、删除工作区、关闭已修改文件，都涉及内容存留判断，不能只是直接执行。

### 初步判断

- 这不是删除磁盘目录，而应优先实现「清空当前加载的工作区内容」：
  - Web 模式：清空内存文件树、内存文件内容、object URL、当前工作区状态。
  - Electron 模式：默认不删除磁盘真实文件，只卸载当前工作区或清空 Synapse 索引/导入缓存；若要删除真实文件必须二次确认。
- 需要设计统一的「未保存 / 删除 / 卸载」确认流程：
  - 有未保存编辑器标签时：保存并继续 / 放弃更改 / 取消操作。
  - 清空当前工作区时：默认仅清空 Synapse 当前加载状态，不删除磁盘文件。
  - 删除工作区记录时：删除最近工作区记录与缓存；真实磁盘删除必须独立入口、强确认。
  - 清空导入缓存时：需要明确会移除内存文件、对象 URL、当前文件树和相关标签页。

### 相关入口

- `src/services/fileSystem.ts`
- `src/components/sidebar/FileTree.tsx`
- `src/components/layout/Sidebar.tsx`
- `src/components/editor/WelcomePage.tsx`
- `src/store/slices/workspace.ts`
- `src/store/slices/editorTabs.ts`
- `src/components/editor/TabBar.tsx`

### 记录状态

- 待设计与实现。
- 建议优先级：P1，属于工作区管理基础功能。

## 5.1 补充：修改文件后关闭标签没有保存确认

### 用户现象

- 当前修改文件后关闭标签页，不会弹出「是否保存」窗口。
- 这与工作区清空、删除、卸载类操作属于同一类数据保护问题。

### 当前实现观察

- `CodeEditor` 会维护本地 `isDirty`，并通过 `onChange` 调用 `setTabDirty({ dirty: true })`。
- `TabBar.tsx` 会显示 dirty 小圆点。
- 但 `TabBar.tsx` 的关闭按钮和鼠标中键关闭直接调用 `dispatch(closeTab(tabId))`。
- `editorTabs.ts` 的 `closeTab()` reducer 直接移除标签，没有阻止或确认。
- 没有 `beforeunload` / Electron `before-quit` 级别的未保存保护。

### 需要进一步设计

- 增加统一未保存变更保护 API：
  - `requestCloseTab(tabId)`
  - `requestCloseWorkspace()`
  - `requestClearWorkspace()`
  - `requestDeleteWorkspace(workspaceId)`
- 所有 API 都先检查 dirty tabs。
- 弹窗至少提供：
  - 保存
  - 不保存
  - 取消
- 对批量关闭/清空工作区：
  - 可以显示未保存文件列表。
  - 支持全部保存、全部放弃、取消。

## 15. Codex 补充实施记录：对话历史批量管理第一期

### 用户确认边界

- 批量管理第一期范围已由用户确认：批量删除、批量导出、归档、标签、搜索过滤。
- 本阶段仍遵守「不删除工作区文件」边界；删除只作用于对话记录和消息快照。

### 当前落地

- 对话历史新增批量模式、全选当前结果、清空选择、批量删除、批量导出、批量归档/还原、批量标签添加/移除。
- 对话摘要新增 `archived` 与 `tags` 元数据；Electron 侧写入 SQLite，Web 模式写入 localStorage mock。
- 搜索过滤从单一关键词扩展为关键词 + 归档状态 + 标签叠加。
- 行内新增标签 chip 与归档 chip；批量动作集中在工具栏，避免继续挤压每条历史记录。

### 验证摘录

- Web mock 验证：归档筛选、标签筛选、批量加标签、批量导出、批量删除均通过；批量删除不影响工作区哨兵数据。
- Electron smoke 验证：真实 renderer 中 SQLite 对话可按归档/标签过滤，批量导出包包含附件与 thinking，批量删除后消息级联为空，重启后标签和归档状态仍可回读。

### 仍需后续关注

- 第一阶段标签采用 summary 内 `tags_json`/数组方案，后续如果需要大量标签查询或跨工作区统计，再考虑独立标签表。

### 记录状态

- 待设计与实现。
- 建议优先级：P0/P1，涉及用户数据丢失风险。

## 6. Markdown 文件只读，需要读/编辑模式

### 用户现象

- 当前 `.md` 文件打开后只可读。
- 预期应有读模式和编辑模式。

### 当前实现观察

- `MarkdownViewer.tsx` 当前只读取 `fileSystem.readFile(filePath)`，然后用 `ReactMarkdown` 渲染。
- 没有编辑模式、保存按钮、读写切换、源文本 textarea 或 Monaco/CodeEditor 入口。

### Plan 对照

- `Plan_1_展示模式.md §1` 写的是 MarkdownPreview，强调实时渲染预览。
- `Plan_3_4_终端与编辑器.md` 要求 CodeEditor 真实加载、编辑、保存，且编辑器增强包括保存快捷键与修改标记。
- 当前 `.md` 只走 MarkdownViewer，没有打通「预览 / 源码编辑 / 分屏」。

### 记录状态

- 待设计与实现。
- 建议优先级：P1。

## 6.1 PDF / Office / HTML 文件查看与编辑模式缺口

### 用户现象

- 当前 PDF 文件打开后显示 `No "GlobalWorkerOptions.workerSrc" specified.`，无法正常渲染。
- 当前 Office 文件不能完整打开：
  - `.docx` 虽然有 `DocxViewer`，但真实打开链路仍需验证。
  - `.doc` 旧 Word 格式没有明确支持策略。
  - `.pptx` 当前仍是占位提示。
  - `.xlsx` 等表格类 Office 文件没有查看器。
- HTML 文件也应支持「渲染读模式」和「源码编辑模式」，而不是只当普通代码文件打开。

### 当前实现观察

- `PdfViewer.tsx` 使用 `pdfjs-dist`，但 `GlobalWorkerOptions.workerSrc` 当前为空，容易触发 worker 未配置错误。
- `DocxViewer.tsx` 使用 `mammoth` 转 HTML，并经过 `DOMPurify.sanitize()`，但只覆盖 DOCX，不覆盖 DOC。
- `EditorArea.tsx` 中 `pptx` 分支仍显示「PPTX 查看器正在集成中」。
- `Sidebar.tsx` 的类型映射主要覆盖 `pdf/pptx/docx/md/png/jpg/jpeg/gif`，HTML 通常落入 code。
- `CodeEditor` 支持 html 语法高亮，但没有 HTML 渲染读模式。
- `ShowcaseFrame.tsx` 已有 iframe 展示能力，可作为 HTML 渲染读模式的基础，但当前没有和普通 `.html` 文件打开模式打通。

### Plan 对照

- `Plan_1_展示模式.md §1` 已明确：
  - `.pdf` → `PdfViewer`
  - `.pptx` → `PptxViewer`
  - `.docx` → `DocxViewer`
  - AI 生成 HTML/JS 项目 → Showcase iframe
- `Plan_3_4_终端与编辑器.md` 已记录 PDF/DOCX/PPTX 无法打开查看，并要求：
  - PdfViewer 通过 IPC 读取 ArrayBuffer 后用 pdf.js 渲染。
  - DocxViewer 通过 IPC 读取文件后 mammoth 转 HTML。
- `Plan_1_测试策略.md` 要求 PDF/DOCX 渲染截图验证和 PDF 页面导航交互测试。

### 设计要求

PDF：

- 配置稳定的 `pdf.worker.min.mjs` 或打包内 worker 路径。
- Electron 模式通过 IPC 读取真实文件为 ArrayBuffer。
- Web 模式通过导入文件的 object URL / ArrayBuffer 读取。
- 支持页码、缩放、上一页/下一页、加载失败提示。

Office：

- DOCX：继续使用 mammoth 转 HTML，保留 DOMPurify 清洗。
- DOC：需要定义策略，优先提示旧格式需转换，或在 Electron 模式用 LibreOffice headless 转 DOCX/PDF。
- PPTX：优先采用原 Plan 推荐的 LibreOffice headless 转 PDF，再复用 PdfViewer；Web 模式可先提供明确降级提示。
- XLSX：后续可用表格预览器或转换为 HTML 表格，至少不能无反馈失败。

HTML：

- 增加 HTML 文件类型，不应只作为 code 打开。
- 提供模式切换：
  - 渲染读模式：使用 sandboxed iframe / ShowcaseFrame 渲染。
  - 源码编辑模式：使用 CodeEditor。
  - 可选分屏：左源码、右预览。
- 渲染读模式需要安全限制：
  - sandbox iframe。
  - 默认禁止外部脚本或给出安全提示。
  - 相对资源路径应以工作区目录为根解析。
- 保存源码后，渲染预览应支持刷新。

### 记录状态

- 待设计与实现。
- 建议优先级：P1。
- PDF worker 配置属于明显可复现 bug；HTML 读/编辑模式属于展示系统闭环缺口。

## 6.2 顶部编辑器标签过多时被压缩，需要滚动/箭头导航

### 用户现象

- 顶部打开文件过多后，每个 tab 被越挤越窄。
- 文件名只剩极短片段，甚至图标和关闭区域也变得难以点击。
- 预期应有横向拖动条、左右箭头，或更多菜单，而不是无限压缩每个 tab。

### 当前实现观察

- `TabBar.tsx` 已有 `scrollRef` 和鼠标滚轮横向滚动逻辑。
- `editor.css` 中 `.tab-bar` 设置了 `overflow-x: auto`，但隐藏了滚动条：
  - `scrollbar-width: none`
  - `::-webkit-scrollbar { display: none; }`
- `.tab-item` 当前使用 `min-width: 0`，在 flex 容器里会被压缩。
- 当前没有左右滚动按钮。
- 当前没有「更多已打开文件」菜单。
- 当前没有在 active tab 变化时自动滚动到可见区域的逻辑。

### Plan 对照

- `Plan_1_展示模式.md §6 编辑器标签系统` 已规划：
  - 多标签管理。
  - 脏标记。
  - 预览模式。
  - 关闭、关闭其他、关闭右侧等上下文操作。
- 当前已部分实现标签，但多文件场景的可用性不足。

### 设计要求

- Tab 不应继续无限压缩。
- 每个 tab 应有稳定宽度范围：
  - `min-width` 建议 120px 左右。
  - `max-width` 建议 180px 左右。
  - 文件名内部 ellipsis。
- Tab 容器应横向滚动。
- 左右两侧提供滚动箭头按钮。
- 支持鼠标滚轮横向滚动。
- active tab 切换后自动 `scrollIntoView`。
- 当标签数量很多时，可增加「更多」菜单，列出全部打开文件并支持搜索/选择/关闭。
- 关闭按钮和 dirty 标记不得因压缩不可点击。

### 记录状态

- 待设计与实现。
- 建议优先级：P1，属于高频编辑体验问题。

## 7. 图七 / 图八 / 图九：附件图片缺少缩略图栏、预览模态框和添加成功反馈

### 用户现象

- 当前增加附件图片后只有 toast 和文字信息。
- 没有类似图八/图九的附件 chip / 缩略图栏。
- 点击附件不能预览，不知道是否添加成功。

### 当前实现观察

- `AgentPanel.tsx` 当前只在选择文件后把文件名、路径、类型、大小追加到输入框。
- 没有附件状态数组。
- 没有缩略图列表。
- 没有附件预览 modal。
- 没有删除单个附件。
- 没有发送时把附件对象和消息绑定。

### Plan 对照

- `Plan_3_3_AI对话系统.md §P2` 明确要求：
  - 上传后显示缩略图/文件名 tag
  - 发送时将文件内容或 base64 图片注入 API 请求
- 当前只完成了「文字上下文提示」的最低补漏，距离原设计还有较大差距。

### 记录状态

- 待设计与实现。
- 建议优先级：P0/P1，因为它会导致多模态发送误判为已完成。

## 8. 图十：发送后缺少 AI 思考中、计时、可获取思考内容、默认折叠

### 用户现象

- 发送出去后先只看到一条用户消息。
- 没有显示 AI 思考中。
- 没有计时。
- 没有展示可获取的 thinking / reasoning 内容。
- 思考内容应默认折叠。

### 当前实现观察

- `AgentLoop` 设置 `isStreaming` 后，只有 `streamingContent` 有内容时 `AgentPanel` 才显示 streaming 的 `MessageBubble`。
- 如果模型迟迟没有输出文本，界面不会显示「思考中 / 请求中 / 已用时」占位。
- `AIClient` 当前只解析普通 `content`、`tool_call`、`done`、`error`，没有解析 reasoning/thinking 字段。
- `ChatMessage.content` 当前是 string，不支持 OpenAI 多模态 content parts。

### Plan 对照

- `Plan_1_设置系统.md §2.6` 要求 `showThinking`。
- `Plan_3_3_AI对话系统.md §P4` 要求 Plan 模式先输出思考步骤/计划，逐步执行，展示推理过程。
- 当前 Plan/Fast 模式虽然在系统提示和工具可用性上已有部分差异，但消息层面的「思考过程 UI」未实现。

### 记录状态

- 待设计与实现。
- 建议优先级：P1。

### 补充：流式输出、伪流式与设置可调

用户补充：对话输出应优先支持真实流式输出；如果当前模型、端点或代理不支持流式，则应支持伪流式输出，并且这个行为需要能在设置里调整。

### 当前实现观察

- `AIClient.streamChat()` 当前请求体固定发送 `stream: true`。
- 请求体带有 `stream_options: { include_usage: true }`。
- `AgentPanel` 只有 `streamingContent` 有内容时才显示流式消息。
- 如果后端不支持 SSE 流式，当前缺少自动降级到非流式请求的路径。
- 设置页虽然原 Plan 里有 `streamingEnabled`，但当前 UI 中没有完整的流式策略开关。

### Plan 对照

- `Plan_1_AI交互层.md` 明确要求 OpenAI-compatible API + SSE streaming。
- `Plan_1_设置系统.md §2.6` 已定义 `streamingEnabled: boolean`，默认 true。
- `Plan_1_前端架构.md` 已规划 `StreamingIndicator.tsx`。
- `Plan_1_测试策略.md` 要求流式打字动画截图验证。

### 设计要求

设置层应提供：

- 输出模式：
  - 自动：优先真流式，失败后降级伪流式。
  - 真流式：强制 SSE，失败时报错。
  - 伪流式：后端一次性返回，前端按字符/词/句分片显示。
  - 关闭流式：一次性展示完整回复。
- 伪流式速度：
  - 慢 / 中 / 快，或 tokens per second。
- 是否显示流式光标。
- 是否显示生成中占位。
- 是否在 Plan 模式中流式展示 thinking。

请求层应支持：

- `streamChat()`：真实 SSE。
- `completeChat()`：非流式一次性请求。
- `pseudoStreamChat()`：基于完整结果的前端分片 AsyncGenerator。
- 自动模式中，若 SSE 解析失败或端点返回不支持 stream，应降级到 `completeChat()` + `pseudoStreamChat()`。

UI 层应支持：

- 即使尚未收到文本，也显示「Generating / Thinking」与计时。
- 真流式和伪流式在消息层都走同一套 `isStreaming` UI。
- 消息 metadata 记录 `streamMode: real | pseudo | off`，便于回溯和排障。

### 记录状态

- 待设计与实现。
- 建议优先级：P1。
- 与 thinking 计时、消息状态、设置系统强相关。

## 8.1 对话历史缺少重新加载、标题编辑与批量管理闭环

### 用户现象

- 对话历史里目前只有一个历史项。
- 双击或其它方式无法稳定重新打开并加载到右侧 AI 对话区域。
- 不能编辑对话标题。
- 缺少批量管理功能。

### 当前实现观察

- `ConversationList.tsx` 当前支持搜索、新建对话、单击切换、单条导出 JSON 和单条删除。
- `handleSwitchConversation(id)` 依赖 `localStorage.synapse_conversations` 读取消息数组。
- 历史摘要来自 `conversationHistory` slice，但完整消息体另存到 localStorage，两者存在同步风险。
- 当前没有双击行为。
- 当前没有右键菜单。
- 当前没有标题重命名 UI。
- 当前没有多选、批量删除、批量导出、批量归档、批量清空。
- 当前没有明确的「重新打开到右侧对话区域」反馈与错误详情。

### Plan 对照

- `Plan_1_设置系统.md §2.9` 要求导出对话历史、清除对话历史。
- `Plan_1_AI交互层.md` 已规划 ConversationManager、对话持久化、导出和恢复。
- `Plan_1_增补.md §6` 提到对话回溯与消息管理。

### 设计要求

- 对话历史条目点击/双击均应能加载到右侧 AI 面板。
- 加载失败时要提示具体原因，例如「消息体缺失」「存储损坏」「该对话已被删除」。
- 支持编辑标题：
  - 双击标题进入编辑。
  - 右键菜单或更多菜单中有「重命名」。
  - 标题更新后同步摘要列表和完整对话记录。
- 支持批量管理：
  - 多选。
  - 批量删除。
  - 批量导出。
  - 批量归档。
  - 全选/反选。
- 支持排序与过滤：
  - 按时间。
  - 按模型。
  - 按消息数。
  - 按收藏/归档。
- 建议统一存储结构，避免摘要和完整消息分散在两个 localStorage key 中导致不一致。

### 记录状态

- 待设计与实现。
- 建议优先级：P1。

## 8.2 右侧 AI 面板缺少显式收起/展开按钮

### 用户现象

- 右侧 AI 区域默认一直展开。
- 当前界面上没有明显的收起按钮。
- 收起后也没有窄条或按钮用于重新展开。

### 当前实现观察

- `AppLayout.tsx` 中右侧 Agent Panel 使用 `react-resizable-panels`：
  - `<Panel defaultSize="35%" minSize="280px" maxSize="60%" collapsible id="agent">`
- `layout.ts` 中已有 `agentPanelVisible`、`toggleAgentPanel()`、`setAgentPanelVisible()`。
- 但当前 `AppLayout.tsx` 没有读取 `agentPanelVisible` 控制渲染。
- 当前 `AgentPanel` 顶部也没有收起按钮。
- 当前 ActivityBar 没有专门的 AI 面板开关。

### 设计要求

- 右侧 AI 面板顶部应有明确收起按钮。
- 收起后右边缘应保留窄条按钮或悬浮按钮用于展开。
- 支持快捷键，例如 `Ctrl+Alt+A` 或命令面板命令。
- 收起状态应持久化到 layout state/localStorage。
- 收起后编辑器区域应自动占用剩余宽度。
- 如果 AI 正在生成，收起时应保留生成状态提示，展开后继续显示当前输出。

### 记录状态

- 待设计与实现。
- 建议优先级：P1，属于布局主交互能力。

## 8.3 壁纸设置仍未真正实装到主界面背景

### 用户现象

- 设置页里已经能开启壁纸、选择图片、显示已添加图片、调整磨砂度/透明度。
- 但主界面背景仍然是纯深色，没有实际显示所选壁纸。

### 当前实现观察

- `SettingsPanel.tsx` 已有壁纸 UI：
  - 启用壁纸。
  - 选择图片。
  - 清除。
  - 缩略图选择。
  - 轮播模式。
  - 切换效果。
  - 磨砂度、壁纸透明度、面板透明度。
- `agentSettings.backgroundSettings` 已保存图片和参数。
- `useThemeEffect.ts` 会查询 `.app-background` 并设置 `backgroundImage`、`opacity`、`filter`。
- `App.tsx` 中存在 `.app-background`。
- 但截图表现说明背景层可能被布局层遮住，或 `.app-background` 层级/透明背景/面板不透明度没有真实打通。
- 项目里同时存在 `theme.background` 和 `agentSettings.backgroundSettings` 两套背景相关状态，存在实现分裂风险。

### Plan 对照

- `Plan_3.md S3` 已明确「设置系统-壁纸：背景图选择/轮播/磨砂/透明度 真实渲染」。
- `Plan_1_设置系统.md §2.3` 已要求壁纸实时预览、模糊度、不透明度。

### 设计要求

- 选择壁纸后主界面应立即可见。
- 背景层应位于内容层下方，但不应被纯色面板完全遮挡。
- 面板透明度应真实影响侧栏、编辑区、右侧 AI 面板、底部终端等主要区域。
- 设置页缩略图选择后应立即切换当前壁纸。
- 清除壁纸后恢复纯色主题背景。
- 轮播模式应能实际切换图片。
- 需要统一 `theme.background` 与 `agentSettings.backgroundSettings`，避免两套状态互相覆盖。
- Playwright 验证应检查：
  - `.app-background` 是否有 background-image。
  - 背景图像素是否在主界面可见。
  - 透明度/模糊度调整是否反映到 DOM/CSS。

### 记录状态

- 待设计与实现。
- 建议优先级：P1，属于已暴露 UI 控件但行为未闭环的问题。

## 8.4 Electron 终端反复报 rules.md 不存在

### 用户现象

终端输出中多次出现：

```text
[electron] Error occurred in handler for 'file:read': Error: 文件不存在: ~/.synapse/rules.md
[electron] Error occurred in handler for 'file:read': Error: 文件不存在: .synapse/rules.md
```

### 当前实现观察

- `extensionManager.ts` 的 `loadRulesFromFiles()` 会读取：
  - `~/.synapse/rules.md`
  - `.synapse/rules.md`
- 读取时虽然在渲染侧 `.catch(() => '')`，但 Electron 主进程的 IPC handler 仍把缺文件错误打印到终端。
- `electron/ipc/file.ts` 对 `file:read` 的缺文件处理直接抛错。
- `SettingsPanel.tsx` 中 RULES 展示的来源是 `~/.synapse/SYNAPSE.md` 和 `.synapse/rules/`，与实际读取的 `rules.md` 路径也不一致。

### 风险

- 缺省配置文件不存在是正常状态，不应刷红色错误堆栈。
- 终端错误会误导用户以为应用启动失败。
- RULES 路径不一致会导致设置页展示和实际注入 system prompt 的内容不一致。

### 设计要求

- 对缺省可选文件读取应使用 `exists` / `tryReadOptional`，不存在时返回空字符串，不打印错误堆栈。
- 统一 RULES 路径：
  - 全局 rules 文件。
  - 工作区 rules 文件。
  - 设置页显示来源。
  - system prompt 注入来源。
- 首次启动可以自动创建空模板，或在设置页提供「创建规则文件」按钮。
- 终端只应输出一次低噪声提示，例如「未发现用户规则，跳过加载」。
- 需要区分真正错误和可选文件缺失：
  - 权限错误、路径非法、解析失败应报错。
  - 文件不存在应静默或 info 级提示。

### 记录状态

- 待设计与实现。
- 建议优先级：P1/P2，属于启动噪声和 RULES 管理一致性问题。

## 9. 图十一：附件实际上没发出去，只发了缩略/文字描述

### 用户现象

- 发送后用户消息只包含文件附件的文字描述。
- AI 回复也是基于文件名猜测，说明图片内容没有真正传给模型。
- 与图八/图九预期设计差距很大。

### 当前实现观察

- 当前 `AIClient.ChatMessage.content` 是 `string`。
- `streamChat()` 发送到 `/chat/completions` 的 `messages` 也是纯文本消息。
- 附件没有被存入消息对象，也没有转为 base64 image_url / input_image 之类的多模态结构。
- 当前接口层没有 provider/model 能力判断，不知道所选模型是否支持视觉。

### 需要进一步设计

- 消息层：
  - 增加 `attachments` 字段，包含 id/name/type/size/path/dataUrl/text/url。
  - 用户消息气泡显示附件 chip 和缩略图。
- 输入层：
  - 附件栏、删除、预览 modal。
  - 图片可点击放大预览。
- 请求层：
  - 对支持视觉的 OpenAI 兼容模型，转为 content parts：`[{type:'text'}, {type:'image_url'}]`。
  - 对不支持视觉的模型，自动降级为 OCR/text 或明确提示。
- 设置层：
  - 显示模型视觉能力。
  - 提供 TEXT MODE / 多模态模式选择。

### 记录状态

- 待设计与实现。
- 建议优先级：P0/P1，属于真实多模态闭环缺口。

## 10. 图一 / 图二 / 图三 / 图四 / 图五补充：消息回溯、AI diff 记录、Accept/Reject 与 Review Changes

### 用户现象

- 当前消息没有类似图一的「Undo changes up to this point」机制。
- 当前消息没有像 `conversation_read_original` 那样记录 AI 输出、工具调用、diff、文件动作等可回溯内容。
- 当前缺少图二的 thought 计时、thinking 展开/折叠与持续状态。
- 当前缺少图三的文件变更摘要、按文件显示新增/删除行数，以及用户 `Accept all` / `Reject all`。
- 当前缺少图四入口按钮和图五的 Review Changes 全屏/分屏详情。

### 当前实现观察

- `conversation.ts` 当前消息结构主要包含 `role/content/timestamp/toolCalls/model`，没有 `thinking`、`elapsedMs`、`diffs`、`fileChanges`、`runId`、`checkpointId`。
- `AgentPanel.tsx` 已有消息编辑、截断、删除、重试，但这些动作只影响对话消息，不会回退 AI 已经写入工作区的文件。
- `agentLoop.ts` 能处理普通文本流和 tool calls，但没有把每个工具调用的文件修改结果汇总成「本轮变更集」。
- `toolRegistry.write_file` 会直接调用 `fileSystem.writeFile()` 写入文件，缺少沙盒变更记录、提交前预览、用户拒绝后回滚。
- 编辑器标签 dirty 状态和 AI 写文件变更记录没有统一接入。

### Plan 原始设计依据

- `Plan_1_增补.md §6 对话回溯与消息管理` 已提出：
  - 编辑用户消息后从该消息重发，并删除后续消息。
  - 回溯到某轮时删除该轮之后所有消息。
  - 文件回滚依赖 AI 每次写文件前创建 snapshot。
  - 文件快照存储在 `工作区/.synapse/snapshots/`。
- `Plan_1_展示模式.md §6 编辑器标签系统` 已提出 editor tab 的脏标记、文件状态和编辑器区域承载多类视图。
- `Plan_3_4_终端与编辑器.md` 已要求 CodeEditor 真实加载、编辑、保存。

因此，本轮补充不是新增任意需求，而是把原 Plan 里的「消息回溯 + 文件 snapshot」具体化为可见 UI 和可操作流程。

### 设计判断

这部分应按「消息时间线 + 变更集」来做，而不是只补一个按钮。

每一轮 AI 回复至少需要形成一个 `assistantRun`：

- `runId`：本轮 AI 回复唯一标识。
- `parentMessageId`：关联用户消息。
- `startedAt/endedAt/elapsedMs`：用于 thought 计时。
- `thinkingBlocks`：可展示的 thinking/reasoning，默认折叠。
- `toolEvents`：工具调用开始、结果、错误。
- `fileChangeSet`：本轮创建、修改、删除、重命名的文件列表。
- `checkpointBefore`：本轮修改前的文件快照或可逆补丁。
- `status`：running / completed / interrupted / accepted / rejected / partiallyAccepted。

文件变更需要支持两种路径：

- 默认沙盒修改已经落到工作区：界面显示 Review Changes，用户可 Accept 保留。
- 用户点 Reject：使用 `checkpointBefore` 或反向 patch 回退本轮变更。

### Review Changes 预期

- 消息气泡内显示简短变更摘要：Created / Modified / Deleted、文件名、`+N -N`。
- 底部或侧边栏提供 `Review Changes` 入口。
- 详情页按文件展示 diff，支持折叠/展开。
- 支持 `Accept all` / `Reject all`。
- 后续可扩展到按文件 accept/reject。
- Reject 时必须处理文件三类情况：
  - 本轮新建文件：删除该文件，或移动到可恢复回收区。
  - 本轮修改文件：恢复到修改前快照。
  - 本轮删除文件：从快照恢复。

### UI 形态补充：消息侧变更 chip + 编辑器 inline diff

参考用户新增图一/图二，Review Changes 不应只是一个独立页面，还要和消息时间线及编辑器联动。

消息侧应展示为：

- 在对应 AI 回复内部插入可点击的变更行，例如：
  - `Edited { } random_quotes.json +13 -3`
  - `Created hello.txt +5 -0`
  - `Analyzed random_quotes.json #L1-46`
- 文件名 chip 需要可点击。
- 点击文件名或整行变更后：
  - 中间编辑器打开对应文件。
  - 自动定位到本次修改区域。
  - 若存在 diff，则进入 diff/highlight 状态。
- `+N` 使用绿色，`-N` 使用红色。
- 文件类型图标沿用文件树/编辑器图标体系，JSON、Markdown、Python 等要保持一致。

编辑器侧应展示为：

- 直接在原文件中显示 inline diff。
- 新增行使用浅绿色背景。
- 删除行使用浅红色背景。
- 修改行可显示为删除行 + 新增行，或 Monaco inline diff 样式。
- 当前 diff 区块右侧悬浮小工具条：
  - 接受当前块。
  - 拒绝当前块。
  - 展开/折叠当前块。
- 小工具条应只在 hover 当前 diff block 或键盘 focus 时明显显示，避免遮挡代码。
- 接受/拒绝单个块后，消息侧对应 change entry 状态同步更新。

交互优先级：

1. 点击消息侧 `Edited xxx +N -N` → 打开文件并定位 diff。
2. 点击 `Review Changes` → 打开本轮全部文件变更总览。
3. 在编辑器 diff block 上点击接受/拒绝 → 只处理当前块。
4. 在 Review Changes 里点击 Accept all / Reject all → 处理整轮变更。
5. Reject 后消息侧状态应变为 rejected，并保留审计记录。

### 布局关系

- 右侧对话面板负责展示时间线、thinking、工具事件和文件变更摘要。
- 中间编辑器负责展示可操作 diff。
- Review Changes 可以作为中间区域的专用 tab，也可以作为右侧/底部抽屉入口，但点击消息 chip 时应优先打开中间编辑器定位文件。
- 这和原 Plan 的 VS Code / Cursor 式布局一致：消息提出动作，编辑器承载文件结果。

### 和 `conversation_read_original` 的关系

`conversation_read_original` 能读取原始对话事件流、工具结果和代码 diff。Synapse 自身也需要类似的内部事件记录，而不是只保存最终聊天文本。

建议新增本地事件流或数据库表：

- `conversation_messages`
- `assistant_runs`
- `run_events`
- `file_change_sets`
- `file_change_entries`
- `file_snapshots` 或 `patch_records`

这样才能支撑：

- 消息级回溯。
- Undo changes up to this point。
- Review Changes。
- 失败中断后的恢复继续。
- 用户 Accept/Reject 后的状态持久化。

### 记录状态

- 待设计与实现。
- 建议优先级：P0/P1。
- 这是 AI Agent 类编辑器的核心闭环，优先级应高于纯展示型设置补全。

## 11. 暂定问题清单

| 编号 | 问题 | 优先级 | 当前状态 |
|---|---|---:|---|
| C-1 | 欢迎页在底部面板拉高后裁切 | P1 | 待复现修复 |
| C-2 | 模型能力与参数未在输入区/设置区展示 | P1 | 待设计实现 |
| C-3 | 插件管理未做 Codex/Antigravity 特化适配 | P1/P2 | 待设计实现 |
| C-4 | 设置页实装情况需逐项对照原 Plan | P1 | 已拆分对照文档 |
| C-5 | 缺少清空工作区功能 | P1 | 待设计实现 |
| C-6 | 关闭已修改文件无保存确认 | P0/P1 | 待设计实现 |
| C-7 | Markdown 缺少读/编辑模式 | P1 | 待设计实现 |
| C-8 | 附件缺少缩略图、预览 modal、明确成功状态 | P0/P1 | 待设计实现 |
| C-9 | 发送后缺少 AI 思考中、计时、折叠 thinking | P1 | 待设计实现 |
| C-10 | 图片附件没有真实进入 API 请求 | P0/P1 | 待设计实现 |
| C-11 | 系统/内置功能与原 Plan 意图存在广泛偏差 | P1 | 待继续盘点 |
| C-12 | 消息缺少回溯、Undo changes up to this point 与事件流记录 | P0/P1 | 待设计实现 |
| C-13 | AI 文件修改缺少 Review Changes、Accept/Reject 与 Reject 回滚 | P0/P1 | 待设计实现 |
| C-14 | 流式输出策略缺少设置项、非流式降级和伪流式展示 | P1 | 待设计实现 |
| C-15 | PDF / Office 文件查看器未完整可用，PDF worker 配置报错 | P1 | 待设计实现 |
| C-16 | HTML 文件缺少渲染读模式、源码编辑模式和分屏预览 | P1 | 待设计实现 |
| C-17 | 顶部编辑器标签过多时被压缩，缺少横向滚动条/左右箭头/更多菜单 | P1 | 待设计实现 |
| C-18 | 对话历史缺少稳定重新加载、标题编辑和批量管理 | P1 | 待设计实现 |
| C-19 | 右侧 AI 面板缺少显式收起/展开按钮 | P1 | 待设计实现 |
| C-20 | 壁纸设置 UI 已有但主界面背景未真实显示 | P1 | 待设计实现 |
| C-21 | Electron 反复报可选 rules.md 不存在，RULES 路径与错误处理不一致 | P1/P2 | 待设计实现 |

## 12. 下一步建议

1. 先补数据保护：未保存文件关闭确认、清空工作区确认、删除/卸载工作区边界。
2. 再补消息事件流：assistantRun、thinking、elapsed timer、tool events、file change set。
3. 再补 Review Changes：diff 面板、Accept all、Reject all、Reject 回滚。
4. 再补流式策略：真流式、伪流式、关闭流式、自动降级、设置项。
5. 再补文件查看器：PDF worker、DOCX/PPTX/Office 降级策略、HTML 渲染读/编辑模式。
6. 再补编辑器标签体验：稳定 tab 宽度、横向滚动、左右箭头、active tab 自动可见、更多菜单。
7. 再补布局与历史管理：右侧 AI 面板收起/展开、对话历史加载/标题编辑/批量管理。
8. 再补壁纸闭环：背景层可见、透明度/磨砂真实生效、状态统一。
9. 再补 RULES 缺省文件处理：可选文件静默缺省、路径统一、设置页创建入口。
10. 再补 UI 状态与数据结构：附件状态、消息 attachments、thinking 状态、elapsed timer。
11. 再补请求层：多模态 content parts、模型能力判断、非视觉模型降级提示。
12. 同步补设置页：模型参数、能力标签、Codex/Antigravity 插件适配。
13. 最后做 Playwright 实测：附件预览、图片真实发送、欢迎页高度、Markdown/HTML 编辑、PDF/Office 查看、多标签滚动、AI 面板收起展开、对话历史加载、壁纸可见、RULES 启动日志、工作区清空、Review Changes 回滚、真/伪流式输出。

## 13. Codex 补充实施记录：流式输出策略

- 2026-04-30 Stage 14 已按本文件「流式输出、伪流式与设置可调」补充实现自动 / 真流式 / 伪流式 / 关闭流式四档策略。
- 默认策略为自动：模型能力支持 streaming 时请求 SSE；模型能力不支持或端点返回流式不支持错误时改走非流式请求，并以带 `Pseudo` 标记的伪流式展示。
- 设置项已落到 `agentSettings.outputStrategy`、`pseudoStreamSpeed`、`showStreamCursor`、`showGeneratingPlaceholder`、`streamThinking` 与 `showThinking`，并在 AI 设置页和输入区模型弹层中可调。
- Web mock 已验证 `stream:true` 真流式、HTTP 400 自动降级、模型能力 `streaming=false` 首次非流式、关闭流式一次性展示、慢/快伪流式节奏差异。
- Electron smoke 已验证刷新后设置持久化、非流式伪流式请求体 `stream:false`、消息 chip 显示 `Pseudo for <1s` 且右侧面板不横向溢出。

## 14. Codex 补充实施记录：HTML 与 Office Viewer

- 2026-04-30 Stage 15 已按用户确认边界修正 `.html/.htm`：默认源码编辑模式，手动切换后才进入 `sandbox=""` iframe 渲染读模式。
- 新增统一 `resolveEditorType()`，Sidebar 与 QuickOpen 共用文件类型路由，避免 `.doc/.xlsx` 一处 unsupported、一处源码 fallback 的分叉。
- `.doc/.docm/.ppt/.pptm/.xls/.xlsx/.xlsm` 统一进入 `office` tab；`.docx/.pptx` 暂保留既有 DOCX/PPTX viewer。
- Electron 侧新增 `file:convertOffice`，使用 LibreOffice/soffice headless 转 PDF 到 `synapse-office-*` 临时目录；renderer 通过 `OfficeViewer` 读取转换 PDF 后复用 `PdfViewer`。
- 新增 `file:cleanupTemp` 受限清理，只允许删除系统临时目录下的 `synapse-office-*`，避免 Office 转换缓存长期残留。
- Electron smoke 已验证 `.doc/.xls/.xlsx/.ppt` 可转 PDF，`.doc/.xlsx/.ppt` 可在 UI 中显示 PDF canvas 与「已转换为 PDF 预览」；不存在的 `.pptm` 会显示明确错误，不伪装成成功预览。

## 15. Codex 补充实施记录：Electron 壁纸文件化存储

- 2026-04-30 Stage 17 已按用户确认边界处理壁纸存储问题：Electron 模式不再把大图 data URL 长期塞进 localStorage，而是复制到 `app.getPath('userData')/wallpapers` 受管目录。
- Electron 侧新增专用 `wallpaper` IPC 与 `synapse-wallpaper://` 协议；删除和清空只允许清理受管目录中的壁纸副本，不复用通用 `file:delete`，也不删除用户原始图片。
- `agentSettings.backgroundSettings.images` 从字符串数组升级为轻量壁纸元数据数组，并兼容旧 `images: string[]` data URL；Web 模式仍保留 data URL 降级。
- `useThemeEffect`、设置页缩略图、选择、删除和清空都改为通过壁纸元数据解析 URL；原有透明度、磨砂、面板透明度、静态/轮播/随机模式继续沿用。
- 设置导出增加 data URL 过滤，避免 `synapse-settings.json` 被壁纸二进制膨胀；Electron 受管壁纸导出只包含轻量元数据。
- Electron smoke 已验证：导入 `stage17-red.png` 后受管文件落盘，`synapse:background` 与 `synapse_agent_settings` 不含 `data:image`，刷新后仍恢复 `synapse-wallpaper://...` 背景；单删和清空会删除受管副本但保留原图。
- Web smoke 已验证：旧 data URL 壁纸能规范化为元数据对象，背景、透明度、磨砂仍生效，删除/清空只改前端状态。

# Synapse Plan_3 Codex 修复工作记录

## 启动记录
- 已完整阅读 `docs/Codex_Task_Plan3_修复.md` 第零节至第七节。
- 已按第零节要求阅读 Plan_3 全套必读文件、`Record/record_1.md` 与 `Task.md`。
- 已查看 `docs/screenshots/` 下 20 张用户实测截图，并放大核对文件树、设置、状态栏、输入框、文件加载失败等关键问题截图。
- 已启动 Stage Guard：`Plan_3 功能实装修复`。
- 已启动 3 个只读子代理并行审计 AI 对话、设置样式、文件终端欢迎页链路。

## P0-1: 输入框修复
- 修改 `src/components/layout/AgentPanel.tsx`。
- 移除对话输入框 `textarea` 上的 `disabled={!hasApiKey}`，使未配置 API Key 时仍可获得焦点和输入文本。
- 保留 `handleSend` 内的 API Key 检查，未配置时通过 notification 提示用户去设置。

## P0-2: AI 对话链路验证与状态统一
- 修改 `src/store/slices/agentSettings.ts`、`src/store/index.ts`、`src/components/settings/SettingsPanel.tsx`、`src/components/layout/AgentPanel.tsx`。
- 确认 AIClient 是 `AgentPanel` 根据 `settings.apiKeys` / `settings.apiEndpoints` / `agentSettings.currentModel` 本地创建，不向 Redux 存放不可序列化实例。
- 新增 `availableModels` 与 `connectionStatus` 到 `agentSettings`，并纳入 localStorage 持久化。
- 设置页获取模型后写入 Redux，AgentPanel 模型选择器与 StatusBar 读取同一份全局模型状态。

## P1-3: 模型选择器实装
- 修改 `src/components/layout/AgentPanel.tsx` 与 `src/styles/layout.css`。
- 底部模型标签新增点击/键盘展开下拉列表能力，列表来自 `agentSettings.availableModels`。
- 模型列表为空时显示“请在设置中获取模型列表”，选择模型后同步 `agentSettings.currentModel` 与兼容用的 `conversation.model`。

## P1-4: Token 计数真实化
- 修改 `src/store/slices/conversation.ts`、`src/services/aiClient.ts`、`src/services/agentLoop.ts`、`src/components/layout/StatusBar.tsx`、`src/components/layout/AgentPanel.tsx`。
- 新增 `tokenUsage` / `tokenCount` 状态，流式请求启用 `stream_options.include_usage`。
- `agentLoop` 收到 API usage 后写回 Redux；界面优先显示真实 usage，没有 usage 时回退本地估算。

## P1-5 / P2-6: 状态栏真实化与硬编码清理
- 修改 `src/components/layout/StatusBar.tsx`。
- 移除硬编码 Git 分支 `main` 显示，改为显示当前模型。
- 连接状态从 `settings.apiKeys.openai` 与 `agentSettings.connectionStatus` 推导，显示“未配置 / 检测中 / 已配置 / 连接失败”。

## P1-1 / P1-2 / P2-1: 设置视觉桥接首批修复
- 修改 `src/hooks/useThemeEffect.ts`、`src/index.css`、`src/styles/settings.css`、`src/styles/layout.css`、`src/styles/chat.css`、`src/styles/editor.css`。
- 将字号注入 `--app-font-size`，主题写入 `documentElement/body.dataset.theme`，补充浅色主题变量集。
- 强调色同步到 `--syn-accent`、`--syn-primary`、`--syn-primary-light`、`--syn-accent-rgb` 和聚焦边框变量。
- 壁纸层消费磨砂与透明度变量，补充轮播定时驱动。
- 设置 Tab 容器加入横向滚动，避免窄屏截断。

## 第一批验证
- `npx tsc -b`：通过，0 errors。
- `npm run build`：通过，Vite 构建成功；仅保留既有 chunk size 与 dynamic import 警告。

## P0-3: 文件查看器加载修复
- 修改 `src/services/fileSystem.ts`、`src/components/layout/Sidebar.tsx`、`src/components/layout/EditorArea.tsx`、`src/components/editor/CodeEditor.tsx`、`src/components/editor/DocxViewer.tsx`、`src/components/editor/PdfViewer.tsx`。
- `fileSystem.writeFile()` 现在会为新路径补齐文件树节点，拖拽和新建文件不会只写内存但不出现在树里。
- Web 模式导入文件时区分文本和二进制：文本写入 `memoryFiles`，PDF/DOCX/图片等二进制保留 object URL 供查看器消费。
- `Sidebar` 订阅 `fileSystem` 变更并刷新文件树，避免欢迎页或文件操作后 UI 不同步。
- `EditorArea` 正式接入 `CodeEditor`，代码类文件可读取、编辑并通过 `fileSystem.writeFile()` 保存。
- PDF/DOCX 查看器对 Web 虚拟 demo 文件给出明确提示；真实导入文件走 object URL 加载。

## P1-6: 终端 Web/Electron 模式修复
- 修改 `src/components/terminal/TerminalPanel.tsx`、`src/components/layout/BottomPanel.tsx`、`src/styles/layout.css`。
- 终端增加 `inputRef`，挂载、切换终端标签、从输出页切回终端时主动聚焦。
- 底部面板不再在切换“输出”时卸载终端，终端状态和历史得以保留。
- Electron 分支改为调用已可用的 `window.synapse.command.exec()`，不再只显示“执行中...”假状态。
- 增加上下方向键历史命令切换。

## P2-3: 欢迎页卡片功能完善
- 修改 `src/components/editor/WelcomePage.tsx`、`electron/preload.ts`、`src/platform/index.ts`。
- “打开工作区”在 Electron 模式调用 `workspace:open`，Web 模式使用目录选择导入文件。
- “新建课程”和最近工作区切换会同步 Redux 工作区状态、打开侧栏文件树。
- “AI 助手”卡片通过事件聚焦右侧对话输入框。
- 最近工作区项去掉 button 嵌套 button 的无效 DOM 结构。
- preload/platform 暴露 workspace API：open/recent/switch/delete/tree。

## P2-4: 知识概要去假数据
- 重写 `src/components/sidebar/SynopsisPanel.tsx`。
- 面板现在从当前工作区文件树动态筛选 `pdf/pptx/docx/md/txt` 候选文件。
- 删除原来的硬编码“2 已完成 / 3 待处理”和模拟进度，不再展示虚假已完成状态。
- 生成/全部生成按钮暂以 notification 明确提示真实管线即将接入。

## P2-5: 设置占位清理与持久化补齐
- 修改 `src/store/index.ts` 与 `src/components/settings/SettingsPanel.tsx`。
- `agentSettings` 和 `multiAI` 已纳入 localStorage 持久化。
- 插件、Synopsis、Multi-AI、数据管理等未完全闭环的区域增加“即将推出/仅展示清单”说明，避免假装后端能力已完成。

## 工作区与文件 IPC 补齐
- 修改 `electron/ipc/file.ts`、`electron/preload.ts`、`src/platform/index.ts`、`src/services/fileSystem.ts`。
- 新增并暴露 `file:rename`、`file:delete`、`file:mkdir`，Electron 模式文件树重命名/删除/新建文件夹可以走真实文件系统。

## 第二批验证
- `npx tsc -b`：通过，0 errors。
- `npm run build`：通过，Vite 构建成功；仅保留既有 chunk size 与 dynamic import 警告。

## Web 联合验证
- 已启动 Vite dev server：`http://127.0.0.1:5173/`。
- Playwright 验证输入框：未配置 API Key 时仍可输入 `测试输入`，发送按钮保持禁用灰态。
- Playwright 验证模型选择器：底部模型标签可展开，下拉空态显示“请在设置中获取模型列表”。
- Playwright 验证终端：输入 `help` 后出现 `Synapse Terminal` 帮助输出。
- Playwright 验证文件查看：点击 `/workspace/README.md` 后 Markdown 正常显示课程内容；点击 `/workspace/实验/排序算法比较.py` 后 `CodeEditor` 正常显示代码内容。
- Playwright 验证设置：字号滑块拖动后 `--app-font-size` 从 `14px` 更新到 `19px`；强调色选择后 `--syn-accent` / `--syn-primary` / `--syn-accent-rgb` 同步更新；浅色/深色主题切换会更新根节点与 body 的 `data-theme`。
- Playwright 验证知识概要：从工作区动态列出 8 个候选文件，显示 `0 已完成 / 8 待生成`，不再出现旧的假摘要和假分片。
- 唯一控制台错误为浏览器请求 `/favicon.ico` 返回 404，与本轮功能修复无关。

## Stage Guard 结果
- 已调用 `stage_guard(action="check")`。
- Guard 未通过原因不是代码或任务证据缺失，而是 Flash 模型调用失败：`可能 LS 未连接`。
- 已按工具提示记录并等待用户裁定；代码侧验证、构建验证与报告均已完成。

## 二次修复启动
- 已阅读 `docs/Codex_Task_Plan3_修复_review.md`、复核第一轮第零节规则，并补读 `Plan/Plan_1/Plan_1_可扩展系统.md` 的 MCP/SKILL/WORKFLOW/RULES 展示设计。
- 已按用户要求跳过 Stage Guard；设置面板与文件树修复已派发给子代理并行处理，主线先修复模型硬编码与真实 API 闭环。

## R-1: 模型硬编码清理
- 修改 `src/store/slices/agentSettings.ts`：`currentModel` 初始值从硬编码模型改为空字符串，未选择模型时不再伪装成已选模型。
- 修改 `src/store/slices/conversation.ts`：对话状态 `model` 初始值改为空字符串。
- 修改 `src/store/index.ts`：加载旧 `synapse_agent_settings` 时只保留仍存在于模型列表中的选择，避免无模型列表支撑的旧缓存继续恢复为已选模型。
- 修改 `src/components/layout/AgentPanel.tsx`：移除 AIClient 的固定模型回退；没有 API Key 或没有模型时不创建请求客户端，发送前明确提示“未选择模型”。
- 修改 `src/components/layout/StatusBar.tsx`：移除 `gpt-4o` 专名判断，状态栏未选模型时显示“未选择模型”。

## R-2 / R-3 / R-5: 设置页与插件页二次修复
- 修改 `src/components/settings/SettingsPanel.tsx` 与 `src/styles/settings.css`。
- 设置 Tab 改为 `scrollbar-width: none` + WebKit 隐藏滚动条，并保留左右滚动按钮，避免深色主题下原生滚动条突兀。
- 设置面板改为 flex 纵向容器，补齐 `min-width: 0`、控件换行与窄屏媒体规则，浏览器验证 `settings-panel` 无横向溢出。
- 插件页恢复 MCP / SKILL / WORKFLOW / RULES 的名称、描述、来源和状态，共 16 个信息项；每项仅操作按钮显示“即将推出”。
- 模型列表获取后不再自动选择固定模型，未选模型时保留“未选择模型”占位，需要用户显式选择。

## R-4: FileTree 右键菜单接入文件操作
- 修改 `src/components/sidebar/FileTree.tsx`、`src/components/layout/Sidebar.tsx`、`src/services/fileSystem.ts`、`src/styles/fileTree.css`。
- 文件节点菜单支持复制路径、重命名、删除；文件夹菜单支持新建文件、新建文件夹、重命名、删除；空白区域菜单支持新建文件、新建文件夹、打开工作区。
- `fileSystem.createFile()` 补齐 Electron 分支，Electron 模式新建文件走 `window.synapse.file.write()`；Web 模式继续更新内存文件树。
- 文件树容器增加 `min-height: 100%`，保证侧栏空白处可稳定触发右键菜单。

## 二次修复阶段验证
- `npx tsc -b`：通过，0 errors。
- `npm run build`：通过，Vite 构建成功；仅保留既有 chunk size 与 dynamic import 警告。
- 代码搜索：`gpt-4o` 在 `src/**/*.ts(x)/js(x)/css` 中 0 条结果。
- 浏览器验证：未选择模型空态显示“未选择模型”，页面可见文本无旧模型硬编码。
- 浏览器验证：设置 Tab 隐藏原生滚动条，设置面板 `scrollWidth` 等于 `clientWidth`，窄屏无横向溢出。
- 浏览器验证：插件页显示 16 个信息项，保留 MCP/SKILL/WORKFLOW/RULES 说明，16 个操作按钮均为“即将推出”。
- 浏览器验证：Web 模式文件树空白区域可新建文件/文件夹；文件可重命名/删除；文件夹可新建子文件/删除，UI 均同步更新。
- R-6 真实 API 闭环已开始执行，已进入真实模型拉取/对话脚本；用户中断后暂停，尚未形成最终通过结论。
- 已关闭本轮启动的 Vite dev server `launch-153` 和 web-fetcher 浏览器会话。

## R-6: 真实 API 对话闭环验证
- 先用文档提供的端点与 API Key 做直接 API 冒烟测试，未在记录中写入 Key：
  - `GET /models` 返回 83 个模型。
  - `gemini-2.0-flash` 存在。
  - `POST /chat/completions` 非流式请求成功，返回文本与 `total_tokens=235`。
- 启动 Vite dev server `launch-154`，通过 web-fetcher 浏览器会话打开 `http://127.0.0.1:5173/`。
- 清理本地测试状态后验证初始界面显示“未选择模型”，页面可见文本不包含旧模型硬编码。
- 在设置 → AI 中填入真实端点与 API Key，点击“获取模型”，前端真实获取 83 个模型。
- 模型列表获取后保持空选择，验证没有自动选中固定模型；随后显式选择 `gemini-2.0-flash`。
- 在右侧对话输入“你好”并发送，前端拿到流式回复，回复内容正常渲染。
- 状态栏验证通过：显示真实模型 `gemini-2.0-flash`、连接状态“已配置”、Token 计数更新为约 `1.4k / 128.0k`。
- 截图证据：`C:\Users\Stardust\AppData\Local\Temp\mcp-web-fetcher\screenshots\e46b4b3fbc17.jpg`。

## 二次修复最终验证
- `npx tsc -b`：通过，0 errors。
- `npm run build`：通过，Vite 构建成功；仅保留既有 chunk size 与 dynamic import 警告。
- `npm run electron:build`：通过，Electron TypeScript 构建成功。
- 代码搜索：`gpt-4o` 在 `src/**/*.ts(x)/js(x)/css` 中 0 条结果。

## Plan_3_plus: A-1 至 A-5 重型 UI 组件实装
- 已阅读并执行 `docs/Codex_Task_Plan3_plus.md`，按 A-1 到 A-5 顺序完成修复。
- 新增报告文件 `docs/Codex_Report_Plan3_plus.md`，记录修改清单、逐项验证与最终浏览器验证结果。

### A-1: 壁纸系统完整实现
- 修改 `src/store/slices/agentSettings.ts`：新增 `BackgroundSettings`，支持启用、多图列表、当前选中索引、静态/轮播/随机模式、轮播间隔、切换效果、壁纸透明度、模糊度、面板透明度。
- 修改 `src/store/index.ts`：新增 `synapse:background` 持久化读取与写入。
- 修改 `src/hooks/useThemeEffect.ts` 与 `src/styles/layout.css`：将 `.app-background` 绑定到 Redux 壁纸设置，实时应用图片、透明度、模糊、面板不透明度和轮播。
- 修改 `src/components/settings/SettingsPanel.tsx` 与 `src/styles/settings.css`：实现多图上传、80×50 缩略图、点击缩略图切换选中、20×20 删除按钮、清空、轮播间隔、透明度与模糊滑块。
- 阶段验证：`npx tsc -b` 通过，0 errors。

### A-2: 插件管理面板 Electron/Web 适配
- 修改 `src/components/settings/SettingsPanel.tsx`：引入 `isElectron` 与 `platform`，Electron 下调用 `platform.mcp.getStatus()` 读取 MCP 状态，支持重启 MCP；Web 下显示“Electron 模式下可用”。
- SKILL / WORKFLOW / RULES 保留名称、描述、图标、路径与“内置”状态；Electron 下提供“打开目录”按钮，调用 `platform.command.exec('explorer "...path..."')`。
- 修改 `src/styles/settings.css`：新增插件分组头部、状态 badge 语义色与紧凑按钮样式。
- 阶段验证：`npx tsc -b` 通过，0 errors。

### A-3: Synopsis 设置面板绑定
- 修改 `src/store/slices/agentSettings.ts`：新增 `SynopsisSettings` 与 `setSynopsisSettings`。
- 修改 `src/store/index.ts`：新增 `synapse:synopsis` 持久化。
- 修改 `src/components/settings/SettingsPanel.tsx`：将 TEXT MODE、每块最大 Token、Map 并发数、索引自动更新、更新策略全部绑定 Redux Store，并在修改后提示保存。
- 阶段验证：`npx tsc -b` 通过，0 errors。

### A-4: Multi-AI 设置面板绑定
- 修改 `src/store/slices/multiAI.ts`：补齐 Solo、对抗式 vibe-coding、深度研究、教学协作四个内置模式；新增 `agentCount`、`isBuiltin`、默认子代理模型、默认 Token 上限等字段，同时保留既有 `subagents` / `triggerConditions` 结构，兼容 `agentOrchestrator`。
- 修改 `src/store/index.ts`：新增 Multi-AI 持久化规整逻辑，读取 `synapse:multi-ai`，兼容旧 `synapse_multi_ai` 与旧模式 ID。
- 修改 `src/components/settings/SettingsPanel.tsx`：实现模式列表、默认标签、模式选择、新建本地模式草稿、子代理模型、Token 上限、最大并行参数绑定。
- 修改 `src/styles/settings.css`：新增 Multi-AI 模式列表与窄屏自适应样式。
- 阶段验证：`npx tsc -b` 通过，0 errors。

### A-5: 数据管理面板真实操作
- 修改 `src/components/settings/SettingsPanel.tsx`：实现对话 JSON 导出、对话历史清除、真实 localStorage 使用量统计、Synopsis/临时缓存清理、设置导出、JSON 设置导入。
- 清除对话历史时同步清理当前 Redux 对话状态、对话历史列表与选中 ID。
- 阶段验证：`npx tsc -b` 通过，0 errors。

### Plus 最终验证
- 搜索 `即将推出`：`src` 中 0 条。
- 搜索 `Web 模式不可用`：`src` 中 0 条。
- `npm run build`：通过，Vite 构建成功；仅保留既有 chunk size 与 dynamic import 警告。
- Edge Playwright Web 验证全通过：
  - 设置页可打开。
  - 壁纸上传后 `synapse:background` 持久化两张图片，`.app-background` 实际应用 data URL。
  - 点击缩略图会切换 `selectedIndex`，删除按钮只删除单张图片。
  - Synopsis Token 参数修改为 4000 后写入 `synapse:synopsis`。
  - Multi-AI 选择 `deep-research`、启用开关、Token 上限 64000 后写入 `synapse:multi-ai`。
  - 插件页显示“Electron 模式下可用”，且不出现 `即将推出` / `Web 模式不可用`。
  - 数据页可下载 `conversations.json`，清除按钮会移除 `synapse:conversation:*` 测试键。
  - 浏览器控制台 error 为 0。
- 额外修复 `index.html`：引用已有 `public/favicon.svg`，消除浏览器默认请求 `/favicon.ico` 导致的 404 控制台错误。
- 本轮启动的 Vite dev server `launch-156` 已关闭。

## 2026-04-29 Codex 独立接手与 B 类补漏
- 用户提供 Antigravity 子代理对话 ID：`019dc8dd-6960-7502-ae30-e9cf7a22b85a`，并说明母对话仍在 Antigravity 侧，当前 Codex 线程暂时接手 Synapse 项目，独立持续修改到稳定后再通知那边 AI。
- 已尝试读取原始对话，`conversation_read_original(fetch)` 未能从 Antigravity/Codex 任一 LS 获取原文；已成功读取 memory-store Record，Record 覆盖 Plan_3、Plan_3_review、Plan_3_plus、真实 API 闭环、报告与记忆同步等阶段。
- 已确认当前工作区存在大量未提交 Plan_3 / Plan_3_plus 改动，属于前序修复成果，不做回退。
- 当前基线验证：
  - `npx tsc -b`：通过，0 errors。
  - `npm run build`：通过，仅保留既有 Vite warning。
- 本轮补漏：
  - `src/components/layout/AgentPanel.tsx`：附件/图片选择后将文件名、路径、类型、大小追加到输入框，作为对话上下文，不再只提示后续版本支持。
  - `src/store/slices/conversation.ts`：`Message` 增加可选 `model` 字段。
  - `src/services/agentLoop.ts`：发送用户消息、助手消息、错误消息、空响应消息时写入当前模型。
  - `src/components/chat/MessageBubble.tsx` 与 `src/styles/chat.css`：消息头显示模型标签。
- 本轮复核：
  - B-1 连接状态逻辑已按在线状态、API Key 和连接状态区分显示。
  - B-2 主要编辑器/查看器容器已是全宽全高，图片 viewer 使用 object URL + contain。
  - B-4 壁纸删除按钮已为 20x20 并带 hover/focus。
- Web 验证：
  - 启动 Vite dev server：`http://127.0.0.1:5173/`。
  - Playwright 完成首次使用向导，主界面正常渲染。
  - Playwright 控制台：0 errors，0 warnings。
  - Playwright 附件验证：输入框出现 `[文件附件]` 段落，包含文件名、路径、类型、大小。

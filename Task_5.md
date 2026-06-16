# Task_5.md — Synapse 成熟 Agent Harness 化执行清单

> 依据：`Plan/Plan_5/Plan_5.md` 总纲 + 8 个里程碑分卷。
> 工作方式：每里程碑完成自测（`npm run build` + `npm run electron:build`）+ 真机验证（web-fetcher desktop_* / 用户手测）后再标完成；发现前序可改进直接改，后序可改进记到本文件对应位置。
> 工作量标注：S=small / M=medium / L=large。

---

## 推进顺序

M4-1 → M4-3 → M4-8 → M4-4 → M4-2 → M4-5 → M4-7 → M4-6

---

## M4-1：上下文/token 机制根治 🔥头号

- 目标：根治「新对话带图即截断」（问题4），统一 contextWindow 认知（问题2a），加截断兜底护栏。
- 依据：`Plan_5_M4-1_上下文token根治.md`
- 执行清单：
  - [x] **S1**(S) 重写 `agentLoop.ts` `estimateNonTextPartsTokens`：图片三分支统一走 `imageVisionTokens(detail)`（low=85，auto/high/空=1100）；文件改 `estimateFileContentTokens`（0.3/byte，仅 size 时 size×0.3，都无走 256）；删死代码 `estimateBytesAsBase64Tokens`；重写常量组注释
  - [x] **S2**(S) 抽 `getModelContextWindow`/`getCurrentModelOption` 选择器到 `src/store/selectors/modelSelectors.ts`（createSelector 缓存），fallback 链 `capabilities.contextWindow ?? option.contextWindow ?? MAX_CONTEXT_TOKENS`
  - [x] **S3**(M) 三处接入：StatusBar 删硬编码映射→ selector + 已用 token 实测(`promptTokens`，确认 `tokenCount=totalTokens` 口径不符)优先否则估算 + 两态标识；AgentPanel；agentLoop
  - [x] **S4**(M) 截断护栏：`compressContext` 增 `historyOnlyTokens`（仅历史接近阈值才标 overLimit，向后兼容）；`truncateOverLongHistory` 加 `MIN_TEXT_BUDGET`(1024) 保底 + 当前消息保护
  - [x] **S5**(S) 自测 build + electron:build 双过；问题4 token 口径核验（图片 1100，降 1239 倍）
- 验收：✅ 问题4 不复现（带图新对话不触发截断）；✅ StatusBar 真实窗口 + 实测/估算两态；✅ 编译双过；✅ 3 路对抗审查 0 high/med。
- 证据/产物：commit `feat(M4-1)`；改 agentLoop.ts / systemPrompt.ts / StatusBar.tsx / AgentPanel.tsx + 新建 store/selectors/modelSelectors.ts。

---

## M4-2：对话体验修复 + 对话工作区归属

- 目标：修问题9（切换选中错位）、问题2b（自动保存失败）；新增对话工作区归属 + 右侧栏顶部对话管理。
- 依据：`Plan_5_M4-2_对话与工作区归属.md`
- 执行清单：
  - [ ] **S1**(M) 问题9：IPC+platform+persistence 三层支持「保存不刷 updated_at」(`systemTouch`)；切走保存改 `systemTouch:true` 去掉 `timestamp:Date.now()`
  - [ ] **S2**(S) 问题2b：新建 `services/ids.ts` 共享 `crypto.randomUUID`（带回退保留 prefix）替换两处 generateId；`message:replaceConversation` INSERT 改 INSERT OR REPLACE
  - [ ] **S3**(M) 工作区归属底座：DB `conversations.workspace_path` 懒迁移（ensureColumn+hasColumn 降级）；IPC create/update/读取接 workspace_path；`buildConversationFilters` 三态（具体 path/IS NULL/不限）；Web mock 对等
  - [ ] **S4**(M) persistence+store 接归属：Snapshot/Summary/ListFilters 加 workspacePath；save/load/branch 透传；conversation slice 加字段 + `setConversationWorkspace`
  - [ ] **S5**(M) 创建/恢复/分支链路带归属：新对话默认归 `workspace.currentPath`（null=global）；恢复回填；分支继承源
  - [ ] **S6**(L) 左侧栏过滤 UI + 归属标记 + 抽 `useConversationManager` hook（保守：只数据/过滤/基础 switch-new，不动 M2-6 竞态修复）
  - [ ] **S7**(L) 右侧栏顶部对话管理区：AgentPanel header 紧凑切换器 + portal 下拉浮层 + 点外关闭，复用 `useConversationManager`，与左侧栏数据一致
- 验收：点对话不再跳第二；切换/退出不再弹保存失败；对话带工作区标记可过滤可改归属；右侧栏顶部可管理对话。
- 证据/产物：

---

## M4-3：UI 修复与美化

- 目标：修问题1/5a/5b/8 + 文件图标/文件夹排序/编辑器 tab 增强。
- 依据：`Plan_5_M4-3_UI修复与美化.md`
- 执行清单：
  - [x] **S1**(S) 问题1 输入框 auto-resize：`autoResize`(height auto→min(scrollHeight,120)) onChange+useLayoutEffect+置空复位；`.agent-input` 加 `overflow-y:auto`
  - [x] **S2**(S) 问题5a 思考块上移：thinking-block JSX 移到 message-content 之前，折叠逻辑不变
  - [x] **S3**(L) 问题5b 附件可点开：新 tab type `'attachment'` + `AttachmentTabViewer`(img/pdf/text/兜底)；图片走 previewAttachment 模态；objectUrl `Map<tabId,url>` revoke 防泄漏；**fix 补：非图片附件 addPendingFiles 落地 sha256 内容，文档打开链路真可达**
  - [x] **S4**(M) 删自检表：删 settingAuditRows/SettingsAuditMatrix/auditStatusClass + 9 处调用；safety/data 措辞中性化；删 css；长内容 `.settings-wide-scroll`；grep 0 残留
  - [x] **S5**(S) 文件夹优先排序：FileTree `sortNodes`（目录优先 + localeCompare numeric），副本不 mutate
  - [x] **S6**(M) 彩色图标主题：内置 `services/fileIcons.ts`（SVG 子集 ~40 扩展 + 默认 + 文件夹 open/closed）；只动 FileTree
  - [x] **S7**(M) 预览 tab reducer：`openTab` isPreview 原位替换 + `pinTab`/`togglePreviewEnabled`/`closeSavedTabs`/`lockGroup`；编辑即固定
  - [x] **S8**(L) TabBar：双击 pin；`...` 菜单(Show Opened Editors/Close All Ctrl+K W/Close Saved Ctrl+K U/Enable Preview/Lock Group/Configure)；EditorArea 自管 Ctrl+K 和弦(1.2s 超时)
- 验收：✅ 8 stage 全实现，build+electron:build 双过；✅ 3 路对抗审查→2 medium 已修(文档附件内容落地 + 已发图模态移除按钮隐藏)；删自检表 grep 0 残留。
- 证据/产物：commit `feat(M4-3)`；改 AgentPanel/MessageBubble/EditorArea/editorTabs/SettingsPanel/TabBar/FileTree + 新建 AttachmentTabViewer/fileIcons.ts + 多 css。

---

## M4-4：文件查看器

- 目标：修图片黑屏(3①)、代码无高亮(3②)、Office 走 LibreOffice(3③)。
- 依据：`Plan_5_M4-4_文件查看器.md`
- 执行清单：
  - [x] **S1**(S) 代码高亮：装 react-syntax-highlighter(PrismAsyncLight 按需)，CodeEditor 只读分支换高亮(vscDarkPlus + detectLanguage + c++→cpp)，可编辑 textarea 不动；>2000 行或 >=256KB 降级裸 pre
  - [x] **S2**(S) Office 归 office：`editorFileTypes.ts` 删 pptx/docx 特判并入 OFFICE_EXTENSIONS→OfficeViewer→LibreOffice→PDF；EditorArea case 保留注释死分支；PptxViewer/DocxViewer 未删(Synopsis 仍用)
  - [x] **S3**(M) `synapse-file://` 协议：新建 `electron/ipc/fileProtocol.ts`(registerFileProtocol standard+secure+supportFetchAPI+stream，规范化+存在性+扩展名白名单)；main.ts 顶层注册 scheme+whenReady 调；`fileSystem.getDisplayUrl`(Electron→synapse-file://local/encodeURIComponent / Web→object url)；EditorArea image/video/pdf 改 getDisplayUrl
  - [x] **S4**(S) 编译双过(electron:build 关键)；协议安全沙箱 8/8 PASS(穿越/二次编码/盘符/存在性)；真机视觉留主人侧
- 验收：✅ 4 stage 实现，build+electron:build 双过；✅ 协议安全沙箱 8/8；✅ 对抗审查 1 medium 已修(UNC/网络路径越界收口防 NTLM 凭据外泄→本地盘符白名单)；🔸 图片/高亮/Office 真机视觉留主人验。
- 证据/产物：commit `feat(M4-4)`；新建 electron/ipc/fileProtocol.ts；改 main.ts/CodeEditor/EditorArea/editorFileTypes/fileSystem + package.json(react-syntax-highlighter)。

---

## M4-5：系统模型 + 自动标题 + 工作区感知 + cache

- 目标：新增系统模型配置；自动标题模型生成；工作区感知注入；prompt cache 稳定化。
- 依据：`Plan_5_M4-5_系统模型与感知.md`
- 执行清单：
  - [ ] **S1**(S) 系统模型：agentSettings 加 `systemModel`+`setSystemModel`；`resolveSystemModel` 纯函数；recordGenerator.resolveClient 改 `systemModel||currentModel`；SettingsPanel 加「系统模型(后台任务用)」下拉（含「跟随默认模型」空选项）；fetchModels 后失效回退
  - [ ] **S2**(M) prompt cache 稳定化：`buildStableRecordPrefix`（方案 B 头 N 批全文 + 其余骨架固定，骨架保留 record_read 可展开，不依赖 contextWindow）；压缩注入路径改用稳定版；注入文案常量化
  - [ ] **S3**(M) 工作区感知 `<open_files>`：PromptContext 加 openFiles/activeFilePath；SystemPromptBuilder 受 injectContext 控制渲染（置 system prompt 末尾保 cache）；agentLoop.run 从 editorTabs 读、过滤非文件视图、上限 20、只注路径/名/类型不注正文
  - [ ] **S4**(M) 自动标题异步化：抽 `runSystemModelOnce`(非流式 helper)；agentLoop.ts:593-597 保留截断占位后 fire-and-forget 调系统模型生成 ≤15 字、成功清洗 setTitle、失败 retry 1 次(~800ms)、降级保留；竞态守卫（id 快照 + 未被手改）；首条纯图降级保留占位
- 验收：系统模型可配可持久化、空值回退；record 压缩用系统模型；同 record 两次压缩前缀逐字一致；AI 知道当前打开文件；首条立即占位 + 1-2 秒语义标题替换。
- 证据/产物：

---

## M4-6：输入区 @ 艾特 + / 斜杠命令

- 目标：@（工作流/设置/对话）+ /（loop/compact/goal）命令体系。
- 依据：`Plan_5_M4-6_输入区命令.md`
- 执行清单：
  - [ ] **S1**(M) 触发检测 `triggerDetect.ts`(纯函数+边界) + 内联浮层 `InlineCompletionMenu.tsx` + AgentPanel 接 onChange/onKeyDown（假数据）；@句中/行首/触发，email/路径不误触
  - [ ] **S2**(M) @ 三类数据源：`atSources.ts`(合并对话/工作流/设置+分组+模糊+每组≤8) + `settingsIndex.ts`；@对话=插 token+记引用、@工作流=替换 @MultiAI 糖衣、@设置=openSettings+focus-section 事件
  - [ ] **S3**(M) / 命令注册表 `commandRegistry.ts` + `commandExecutor.ts`(parseAndDispatch)；BUILT_IN_WORKFLOWS(/review //collect) 适配为 SlashCommand；handleSend 先 parseAndDispatch 再走既有分流
  - [ ] **S4**(L) 内置命令 /goal /compact /loop：conversation slice 加 goal+持久化 + `<current_goal>`/`<referenced_conversation>` 段；/goal 设查；/compact 接 M4-7 `compactNow` 钩子（**与自动压缩并存不改自动逻辑**）；/loop 最小 loopRunner(串行 N 次+硬上限)；@对话引用默认 record 摘要优先
  - [ ] **S5**(M) 对抗自检 + 边界加固：IME composition 抑制、Ctrl+Enter 与浮层优先级、引用表以表为准、命令解析鲁棒、/loop Stop 可中断；真机走三类@ + 三条/
- 验收：@/弹内联菜单可选；三类@可用；/review //collect 真执行；/goal 持久化注入；/loop 跑完 N 轮可中断；/compact 触发手动压缩（自动压缩照常）。
- 证据/产物：

---

## M4-7：MCP 真接（读为主）+ /compact 实装

- 目标：桥接 MCP 工具进工具循环 + 默认配置 + 抽 compactNow（自动/手动并存）。
- 依据：`Plan_5_M4-7_MCP真接.md`
- 执行清单：
  - [ ] **S1**(S) MCPServerProcess 健壮性：spawn `windowsHide:true`；initialize 与 error 竞速快速失败（不等 30s）；capabilities 补 `{tools:{}}`；listTools 失败 catch 空集
  - [ ] **S2**(S) 默认 `mcp_config.json`：main.ts `ensureDefaultMCPConfig()`（不存在才写，指向三 server `dist/index.js` 绝对路径，memory-store=true 另两 false）；ipc/mcp.ts status 对 running server 填真实 tools
  - [ ] **S3**(M) `src/services/mcpBridge.ts` 桥接：refresh() 拉 listTools→转 ToolSchema（名加 `mcp__<server>__<tool>`、inputSchema→parameters）→按分类表定审批→register 进 toolRegistry；toolRegistry 加 `unregister(name)`
  - [ ] **S4**(M) 注入点接线：AgentPanel 构建 AgentLoop 时 `mcpBridge.refresh()`；子代理经 getSchemasForPermissions 纳入读类；SettingsPanel 删静态 mcpEntries 改动态列表 + 真实 tools 数 + 打开配置入口
  - [ ] **S5**(S) 删 `mcpManager.ts` 死代码（grep 确认无引用）；补内置 memory 只读工具 `memory_read`/`memory_list`（approval read）
  - [ ] **S6**(M) **抽 `compactNow(conversationId)`**：自动压缩路径（~90% 水位判定后）改调同一 compactNow，行为与现状一致**不删不降级**；手动路径（M4-6 /compact）也调 compactNow；**自动与手动并存复用同一套逻辑**；留系统模型钩子
  - [ ] **S7**(M) 全量验证：build + electron:build；真机三 server 启停、AI 调 MCP 读工具、审批分类正确、子代理可用读类、/compact + 自动压缩并存照常
- 验收：AI 能实调 `mcp__memory-store__memory_query` 返回外置库内容；sandbox/web 工具弹审批；/compact 手动压缩 + ~90% 自动压缩都正常。
- ⚠️ transport 走 stdio，**不走** HTTP Broker 127.0.0.1:14588。
- 证据/产物：

---

## M4-8：请求稳定性 — retry/重连 + 本轮计时

- 目标：请求失败自动 retry/重连 + reconnect i/N 显示 + 端到端本轮计时。
- 依据：`Plan_5_M4-8_稳定性重连计时.md`
- 执行清单：
  - [x] **S1**(M) 错误分类 + 可中断退避：`classifyError` + `retryableSleep(delay,signal)`；streamChat real 重构(400/422+upstream 特征词纳入可重试 gateway_upstream+console.warn body 摘要，优先级 降级>重试>不可重试)；三处 sleep 改 retryableSleep(signal)
  - [x] **S2**(M) completeChat(off/pseudo) 补 retry：!ok 改重试循环复用 classifyError+retryableSleep；abort throw 外层转 aborted；与 auto→pseudo 降级不冲突
  - [x] **S3**(M) 重连进度进气泡：conversation slice 瞬态 `reconnect` + `setMessageReconnect`；agentLoop set/clear；MessageBubble 渲染 `reconnect i/N`；sanitize+branchConversation 双重剔除不持久化；去掉持续 notification
  - [x] **S4**(S) 本轮计时端到端：`formatDuration` 带空格+hour 位(「26 m 39 s」/「1 h 5 m 0 s」)；agentLoop `loopStartedAt`，loop 自然完成(completedNaturally 守卫)给最终消息挂 endToEndMs 徽标
  - [x] **S5**(S) maxRetries=5 共享常量三处统一引用；编译过（真机制造网关 upstream 错误验证留主人侧）
- 验收：✅ 5 stage 实现，build+electron:build 双过；✅ 3 路对抗审查→1 high+2 medium 已修(关键：真流式断线重试内容拼接污染→resetContent 覆盖语义，顺带根治旧 M2-S 隐患)；🔸 真机 retry/reconnect 待主人侧异常端点触发验证。
- 证据/产物：commit `feat(M4-8)`；改 aiClient/agentLoop/conversation/MessageBubble + sanitize 剔除 reconnect。

---

## 待复核 / 小本本

- [ ] `conversation.tokenCount` 语义（prompt vs total）确认（M4-1 S3）
- [ ] 项目既有 selector 放置惯例（M4-1 S2）
- [ ] `buildStableRecordPrefix` 头 N 批 N 取值（M4-5 S2）
- [ ] `runSystemModelOnce` 放置（recordGenerator vs 新建）（M4-5 S4）
- [ ] 本地端点 prompt caching 能力真机验证（M4-5 S2）
- [ ] LibreOffice 冷启动延迟体验（M4-4 S2）
- [ ] 工作区改名→对话失联（已知限制，是否后续做 path 重绑）（M4-2）
- [ ] 二期：工作区文件树概要注入 / /loop 收敛循环 / M4-8 fallback 第三层
- [ ] (M4-1 low) 护栏 `historyOnlyTokens` 仅含历史文本 token、不含历史非文本(图片)token——块一治本后概率极低，Plan 措辞本就如此，记为口径取舍
- [ ] (M4-1 low) StatusBar 两态：切到另一已存在对话若未重置 `tokenUsage` 可能短暂显示上一对话 promptTokens（clearConversation 已置 null，仅切换路径）；后续可在 loadConversation 确认重置
- [ ] (M4-8 真机) retry/重连/计时需主人侧用真实异常/超时端点触发验证：reconnect i/5 计数、本轮端到端计时实时刷新、重试耗尽错误文案

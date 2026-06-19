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
  - [x] **S1**(M) 问题9：IPC+platform+persistence 三层 `systemTouch`「保存不刷 updated_at」；切走保存改 `systemTouch:true` 去掉刷时间
  - [x] **S2**(S) 问题2b：新建 `services/ids.ts` 共享 `crypto.randomUUID`(带回退保留 prefix) 替换 agentLoop+AgentPanel 两处 generateId；`message:replaceConversation` INSERT→INSERT OR REPLACE
  - [x] **S3**(M) 工作区归属底座：DB `conversations.workspace_path` 懒迁移(ensureColumn+hasColumn 降级)；IPC create/update/读取 + `buildConversationFilters` 三态(path/IS NULL=global/不限)；Web mock 对等
  - [x] **S4**(M) persistence+store 接归属：Snapshot/Summary/ListFilters workspacePath；save/load/branch 透传；slice `setConversationWorkspace`(补 export)；**关键补：autosave debounce 漏 workspacePath(新对话首条归属首次落库路径)已补**
  - [x] **S5**(M) 创建/恢复/分支链路带归属：新对话默认归 `workspace.currentPath`(null=global)；恢复回填；分支四处继承源；clearConversation 补 workspacePath=null
  - [x] **S6**(L) 左栏过滤 UI + 归属标记 + `useConversationManager` hook(保守抽取)：范围切换器(当前/全局/全部 默认当前)、工作区小标记、「移动到…」改归属
  - [x] **S7**(L) 右栏顶部对话管理区：AgentPanel header 紧凑切换器 + createPortal 浮层(点外/Esc 关)，搜索/范围/切换/新建/改归属；selectedId 共享同步
- 验收：✅ 7 stage 实现，build+electron:build 双过；✅ 3 路对抗审查→5 项归 2 根因已修(删对话归属泄漏→clearConversation 清 null；右栏 archived:'all' 污染左栏视图→右栏改本地 state 解耦)；🔸 切换不跳第二/保存不失败/工作区过滤 真机留主人验。
- 证据/产物：commit `feat(M4-2)`；改 electron(database/conversation/preload)+platform+persistence+slice+ConversationList+AgentPanel + 新建 ids.ts/useConversationManager.ts + css。

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
  - [x] **S1**(S) 系统模型：agentSettings 加 `systemModel`+`setSystemModel`；新建 `modelResolution.ts` `resolveSystemModel`(systemModel||currentModel)；recordGenerator.resolveClient 改读；SettingsPanel 加「系统模型(后台任务用)」下拉(含「跟随默认模型」空选项)；fetchModels+store 加载期双补失效回退
  - [x] **S2**(M) prompt cache 稳定化：`buildStableRecordPrefix`(确定性，头 2 批全文+其余骨架固定，不依赖 contextWindow)；两处压缩注入改用；删动态 buildRecordPrefix 死代码；注入文案常量化
  - [x] **S3**(M) 工作区感知 `<open_files>`：`renderOpenFilesSection`(只路径/名/类型不注正文)；agentLoop 从 editorTabs 过滤非文件视图(黑名单含 review/attachment 等)、上限 20；**审查纠正：从 system prompt 末尾挪到 messages 末尾(最后一条 user 消息内)，否则切 tab 仍破坏 apiMessages[0] 稳定前缀 cache**
  - [x] **S4**(M) 自动标题异步化：新建 `systemModelClient.runSystemModelOnce`(非流式 maxTokens32 低温)；首条截断占位后 fire-and-forget(void IIFE 不 await)生成 ≤15 字+清洗+retry 1 次(~800ms)+降级保留；竞态守卫(id 快照+未手改)；纯图降级占位
- 验收：✅ 4 stage 实现，build+electron:build 双过；✅ 3 路对抗审查→2 medium 已修(open_files 过滤漏 review/attachment tab→黑名单收紧；open_files 放 system prompt 末尾仍破坏 cache→挪到 messages 末尾)；🔸 系统模型/标题生成/工作区感知 真机留主人验。
- 证据/产物：commit `feat(M4-5)`；改 agentSettings/recordGenerator/SettingsPanel/agentLoop/systemPrompt + 新建 modelResolution.ts/systemModelClient.ts。

---

## M4-6：输入区 @ 艾特 + / 斜杠命令

- 目标：@（工作流/设置/对话）+ /（loop/compact/goal）命令体系。
- 依据：`Plan_5_M4-6_输入区命令.md`
- 执行清单：
  - [x] **S1**(M) 触发检测 `inputCommands/triggerDetect.ts`(纯函数+12 边界 case) + 内联浮层 `InlineCompletionMenu.tsx` + AgentPanel 接 onChange/onKeyDown/composition；@句中/仅行首//email/路径/scoped 包不误触/IME 抑制
  - [x] **S2**(M) @ 三类数据源：`atSources.ts`(对话/工作流/设置+分组+模糊+每组≤8) + `settingsIndex.ts`(sectionId 对齐 tab)；@对话=插 token+记 refs、@工作流=糖衣 @MultiAI、@设置=跳转发 synapse:settings-focus-section 事件(SettingsPanel 监听切 tab)
  - [x] **S3**(M) / 命令注册表 `commandRegistry.ts` + `commandExecutor.ts`(parseAndDispatch，未知命令不误吞)；BUILT_IN_WORKFLOWS(/review //collect) 适配真执行；matchWorkflow 标 deprecated；handleSend 先命令分流
  - [x] **S4**(L) 内置命令 /goal /compact /loop(+/clear)：conversation slice goal+setGoal+applyManualCompact 完整 DB 持久化链路；promptBuilder `<current_goal>`/`<referenced_conversation>` 段；/compact 完整手动闭环(compactNow 生成 record+落库 → applyManualCompact 截断+物化摘要消息+刷新前缀，**与自动压缩并存**)；/loop loopRunner(串行+硬上限 20+可中断)；@对话引用 record 摘要优先/回退最近 N 条
  - [x] **S5**(M) 边界加固：引号参数鲁棒、引用表为准、@设置 rAF 延迟派发、/loop 切换/新建调 stop()、未知命令走普通消息、IME/Ctrl+Enter 守卫
- 验收：✅ 5 stage 实现，build+electron:build 双过；✅ 3 路对抗审查→5 项(含 2 high)已修(连续 /compact 丢历史+record 误删→isManualEntry 分支隔离+删误用 clampToBatch；goal 跨对话泄漏→切换补 goal；/loop 次数解析；IME 守卫)；🔸 三类@/三条/真机留主人验。
- ⚠️ stillOpen(已 spawn task_e5135885 建议真机回归)：手动 /compact 后再触发自动压缩，priorSteps 绝对基准 vs store 已截断的水位错位可能未根治(彻底修需重构 record 增量水位×手动截断，动自动压缩/崩溃恢复/编辑截断三链路，架构级高风险，编译约束下未贸然做)；连续两次 /compact 端到端真机未跑。
- 证据/产物：commit `feat(M4-6)`；新建 inputCommands/(triggerDetect/types/atSources/settingsIndex/commandRegistry/commandExecutor/loopRunner) + InlineCompletionMenu；改 AgentPanel/agentLoop/systemPrompt/conversation slice/persistence/MessageBubble/SettingsPanel/ConversationList + electron(database/conversation) + css。

---

## M4-7：MCP 真接（读为主）+ /compact 实装

- 目标：桥接 MCP 工具进工具循环 + 默认配置 + 抽 compactNow（自动/手动并存）。
- 依据：`Plan_5_M4-7_MCP真接.md`
- 执行清单：
  - [x] **S1**(S) MCPServerProcess 健壮性：spawn `windowsHide:true`；Promise.race(initialize,errorEvent) ENOENT 秒级失败；capabilities 补 `{tools:{}}`；listTools 失败 catch 空集
  - [x] **S2**(S) 默认 `mcp_config.json`：`ensureDefaultMCPConfig()`(不存在才写，三 server dist/index.js 绝对路径，memory-store=true 另两 false)；ipc/mcp.ts status async 对 running server 填真实 tools
  - [x] **S3**(M) `mcpBridge.ts` 桥接：refresh 拉 listTools→ToolSchema(`mcp__<server>__<tool>`+inputSchema→parameters)→classifyMcpTool 审批分类→register；toolRegistry 加 `unregister(name)`；callTool 路由 + content[] 扁平化
  - [x] **S4**(M) 注入接线：AgentPanel 构建 AgentLoop 时 wireTools+mcpBridge.refresh().then(wireTools)；子代理 getSchemasForPermissions 自动纳入读类；SettingsPanel 删静态 mcpEntries 改全动态 getStatus+真实工具数+打开配置入口+启停走 mcpBridge
  - [x] **S5**(S) 删 `mcpManager.ts` 死代码(grep 无 import 后 git rm)；补内置 `memory_list`/`memory_read` 只读工具(approval auto/read，复用 memoryStore)
  - [x] **S6**(M) 抽 `compactNow(conversationId)` 为 AgentLoop 方法：自动压缩(~90%水位)切到调同一 compactNow 逐字节一致**不删不降级**；手动入口缺省段从 store 按 KEEP_RECENT=4 同口径自算；resolveClient 沿用 M4-5 systemModel
  - [x] **S7**(M) 编译双过；桥接 mock 自测(mcp__ 前缀+审批分类+unregister)；memory-store stdio smoke 已过(listTools 返 11 工具)；三 server 启停+AI 实调 MCP 真机留主人侧
- 验收：✅ 7 stage 实现，build+electron:build 双过；✅ 3 路对抗审查→3 medium 已修(读类 conversation_golden_extract 误判 write→白名单收窄；compactNow 职责边界 JSDoc；关键:AgentLoop schema 快照滞后→toolsProvider 动态取数，启停 MCP 下一轮 send 即生效)；🔸 三 server 启停+AI 调 MCP 真机留主人验。
- ⚠️ transport stdio，不走 HTTP Broker；自动压缩保留+compactNow 自动手动并存。
- 证据/产物：commit `feat(M4-7)`；新建 mcpBridge.ts；改 electron(MCPServerProcess/mcp/main)+toolRegistry/agentLoop/AgentPanel/SettingsPanel；删 mcpManager.ts。

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
- [ ] (M4-6 残留·关注) 手动 /compact 后再触发自动压缩的 record 水位错位：priorSteps 绝对基准 vs store 已截断的根本错位未根治（本次仅缓解 system 占 step 一层）；连续两次 /compact 端到端真机未跑（task_e5135885）；彻底修需重构 record 增量水位×手动截断（动自动压缩/崩溃恢复/编辑截断三条已验证链路，架构级高风险）
- [ ] (M4-6 小) ConversationList 左侧栏切换路径未带 goal，从左栏切换可能丢 goal（autosave 重启兜底恢复），如需可后续补
- [x] (M3 遗留) Plan_4 worktree 打磨项 #53-60 完成：调研确认 byContext 重构早已落地（task 列表过时）；补子代理 worktree 条目泄漏(cca254a)；3 视角 workflow 谨慎审查挖出 HIGH「回滚链路漏 contextId → 落主工作区/误删同名文件」+ MEDIUM「removeWorktree 悬空条目」+ 3 LOW（删对话泄漏/路径大小写/execContextId 流式漂移），全修(b593f76)，双编译通过

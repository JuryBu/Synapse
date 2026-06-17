# Plan_5 · 压缩/回溯/分支/重试 核对偏差清单 + 返工映射

> 2026-06-17，8 路只读核对「当前实现 vs [统一模型规范](Plan_5_压缩回溯统一模型规范.md)」结果整理。
> 状态：**已定稿为返工 Plan**（M5 系列，**54 stage / 5 梯队**）。用户已补全 BPC（§8）+ record 分层（§2.5）+ task_boundary（§10）+ show_artifact（§11）+ UI 细节（§9），并整合 4 领域研究的 29 个新 stage。**2026-06-17 真机验收两批排查（22 findings）整合为梯队零 M5-FIX（10）+ M5-UI（8），并落实 3 个用户拍板点（step 定义 §1 / BPC 替换时机 §8 / 可调参数强约束 §8.3 / record 折叠核对 §2.5）。** 完整 stage 清单与梯队依赖见「三、返工结构」，决策默认见「四、决策默认」，落地前待确认细节见「六」。

## 一、核对总览（8 领域，34 偏差，4 不符 + 4 部分符）

| 领域 | 符合度 | 一句话 | 返工块 |
|---|---|---|---|
| 压缩单一性 | 🔴 no | `/compact` 走 `applyManualCompact` 截断 store + `isManualEntry` 两套压缩 | M5-1 |
| 轮次概念 | 🔴 no | 无"轮"概念，把"轮"当成 user 消息条数；保留/裁剪纯 step 不按轮 | M5-2 ★地基 |
| record 增量生成 δ | 🔴 no | 生成摘要只喂目标段，无前后 δ 轮原文连贯性参考 | M5-6 |
| 懒加载 | 🔴 no | 全量渲染无虚拟滚动（纯前端问题，不碰底座） | M5-7 |
| UI 显示 | 🟡 partial | 正确的分隔线（batchDivider）已有、被错误的 /compact 架空打架 | M5-1 |
| 回溯 | 🟡 partial | 能砍 record 批，但①不回填输入框②轮中间切③入口按单条非按轮 | M5-3 |
| 分支 | 🟡 partial | **最接近**：砍批口径对、源对话不动对；缺①回填②按轮取整 | M5-5 |
| 重试 | 🟡 partial | 自动重发对；但没按轮回退（多步轮只删被点条）+ 入口错挂 AI 消息 | M5-4 |

## 二、两个"根子"（修好它们一大半连带消失）

1. **压缩没归一**（M5-1）：`conversation.ts` `applyManualCompact`（:379-393）`state.messages=[摘要,...tail]` 删 store；`AgentPanel.tsx:1031` dispatch 它；`agentLoop.ts:1187` `isManualEntry` 分支让自动/手动走两套 batchSlice；`MessageBubble.tsx:300-321` 为承接 system 摘要消息而生。→ 全删，`/compact` 只调自动 `compactNow`（不截断 store），UI 交还已存在的 `batchDividerByIdx` 分隔线（AgentPanel.tsx:257-279/1996-2005）。连带：之前的"水位错位 bug"、弱熵 id、本地文件被删减、token/导出基于残缺历史 —— 全部随之消失。
2. **没有轮次概念**（M5-2，地基）：全项目把"轮"=`role==='user'` 条数（`agentLoop.ts:1236-1238`、`AgentPanel.tsx:1202`、`conversationPersistence.ts:398`）；保留原文 `compressContext` `keepCount=4` 纯按条切（`systemPrompt.ts:263-265`）；`clampToBatch` 的 `keptRounds` 形同虚设只告警（`recordStore.ts:532-539`）。→ 新增**轮边界识别层**（从 role 序列识别"user 段+紧随 model 段含所有工具/子代理 step=一轮"，产出 消息→轮号 + 轮号→[stepStart,stepEnd] 两张表），压缩/回溯/分支/重试**四处共用**。

## 三、返工结构（完整 M5 系列，2026-06-17 用户补全 BPC/分层/task_boundary/show_artifact 后定稿）

> 原 M5-1~M5-7 保留，新增 4 个返工块：M5-RL（record 多级分层）、M5-BPC（后台预压缩）、M5-TB（task_boundary）、M5-SA（show_artifact）。
> 规范依据：[统一模型规范](Plan_5_压缩回溯统一模型规范.md) §2.5（record 分层）/§8（BPC）/§9（UI）/§10（task_boundary）/§11（show_artifact）。

### 3.1 返工块总览

| 块 | 名称 | stage 数 | 规范节 | 依赖 |
|---|---|---|---|---|
| M5-1 | 压缩归一 | 1 | §0/§2/§7 | 无（地基头） |
| M5-2 | 轮次地基 ★ | 1 | §1 | M5-1 |
| M5-3 | 回溯 | 1 | §3 | M5-2 |
| M5-4 | 重试 | 1 | §5 | M5-2 |
| M5-5 | 分支 | 1 | §4 | M5-2 |
| M5-6 | 增量生成 δ | 1 | §2（第 4 点） | M5-2 |
| M5-7 | 懒加载 | 1 | §6 | 独立（纯前端） |
| **M5-RL** | **record 多级分层** | **6** | §2.5 | M5-1 + M5-2 |
| **M5-BPC** | **后台预压缩** | **9** | §8 | M5-1 + M5-2（+ M5-RL 衔接） |
| **M5-TB** | **task_boundary** | **7** | §10 | 独立可起，回溯联动依赖 M5-2 |
| **M5-SA** | **show_artifact** | **7** | §11 | 独立可起 |
| **M5-FIX** | **M4 验收回归修复** | **10** | —（真机排查） | **独立可并行**（不依赖压缩返工），多为 small/medium |
| **M5-UI** | **视觉/交互打磨** | **8** | —（真机排查） | **独立可并行**（不依赖压缩返工），small/medium |

### 3.2 完整 stage 清单（从研究 stages 字段搬运，不丢）

#### M5-1 ~ M5-7 · 压缩归一 / 轮次地基 / 回溯 / 重试 / 分支 / δ参考 / 懒加载

| stage | 一句话 | effort |
|---|---|---|
| M5-1 压缩归一 | 删 `applyManualCompact`/`isManualEntry`/system 摘要卡片 + dispatch；`/compact`→`compactNow`；UI 交还 batchDivider 分隔线；清理误导注释 | medium |
| M5-2 轮次地基 ★ | 新增轮边界识别层（消息→轮号 + 轮号→[stepStart,stepEnd]）；`compressContext` 保留按 token→向轮边界取整；批次 stepStart/stepEnd 由轮推导；`clampToBatch`/`copyRecordFrom` 裁剪对齐轮边界（`keptRounds` 转真实依据）；压缩/回溯/分支/重试四处共用 | medium-large |
| M5-3 回溯 | `handleUndoToMessage` 重做：定位目标轮 N、`setPendingMessage` 回填 N+1 轮 user（恢复 pending 附件、不自动发、GC 排除它）、按轮 truncate；入口语义统一到"轮" | medium |
| M5-4 重试 | 入口**改挂 user 消息**；`handleRetry` 截断基准从"被点 AI 之前"改为"该 user 轮之后全部（含本轮所有 assistant/tool 中间步）"，再 `skipUserMessage` 自动重发 | medium |
| M5-5 分支 | `branchConversation` cutIdx 向轮边界取整；与回溯对齐（user 分支点→新对话 `setInput` 回填待发）；砍批口径已对，复用 M5-2 轮 helper | medium |
| M5-6 增量生成 δ | `GenerateBatchInput` 加 contextBefore/contextAfter（δ≤1 轮/按 token）；`buildBatchPrompt` 增"前文/后文参考（只读勿写入）"分区；参考不计入 step/round 水位 | medium |
| M5-7 懒加载 | 引虚拟滚动（react-virtuoso / @tanstack/react-virtual / 手写窗口化）替换全量 `messages.map`；改无条件 `scrollIntoView` 为"仅底部附近才置底"；store 全量持有不变、**不碰 record/存储/回溯** | medium |

#### M5-RL · record 多级分层（§2.5）

| stage | 一句话 | effort |
|---|---|---|
| R-L1 | recordStore 新增 `extractSkeletonTitle`（正则只留 `#`+各 `##` 标题行、丢首行要点，量纲 ≈ 骨架 1/3）；纯本地零 LLM，与 `extractSkeleton` 并列；单测覆盖空/单/多标题 | small |
| R-L2 | `buildStableRecordPrefix` 扩成确定性三级（头 H 全文 + 尾 T 全文 + 中间骨架，中间超阈值 M 时最老段降 titleOnly）；`renderSkeletonBatch` 加 titleOnly 变体；分档边界**只依赖批位置与总批数 N**、绝不引 contextWindow/实时 token（维持 cache 前提）；新增常量 `STABLE_TAIL_FULL/SKELETON_TITLE_THRESHOLD` | medium |
| R-L3 | 设计 A 验证：几十批 fixture 断言（1）两次渲染逐字一致（cache 稳定不回退）（2）60 批前缀 token 较现状显著下降（3）被降 titleOnly 的批 `record_read` 仍能取回全文。`npm run build` + `electron:build` | small |
| R-L4 | 设计 B 折叠：`RecordBatch` 加 `archived` 标记（或 metaBatch 概念）；`foldOldBatches`——批数超阈值把最老 K 批折叠成 1 元批（contentMd=skeleton 再摘要/正则合并），原始批留库不删（满足 §0.2，`record_read` 可展开），仅请求体注入用折叠产物；`compactNow` 后接入触发；接受「折叠当次一次性 cache miss、之后阶梯稳定」 | large |
| R-L5 | 设计 C 兜底：组装 apiHistory 前加 record 前缀 token 硬闸——超 `contextWindow×RECORD_MAX_RATIO` 时从中段逐批降 titleOnly 至达标，定位同 `truncateOverLongHistory` 危险态，仅兜底不进正常路径；为 BPC 提供「压完必达标」保证 | medium |
| R-L6 | BPC 衔接（**可选**，§8 完成后）：预压缩侧调「预测压完 record 前缀 token」函数，若预测超 `RECORD_MAX_RATIO` 则提前触发 `foldOldBatches`（R-L4）而非等触达水位，闭合无限循环；依赖 R-L2/R-L4/R-L5 | medium |

#### M5-BPC · 后台预压缩（§8）

| stage | 一句话 | effort |
|---|---|---|
| M5-BPC-0 | 前置依赖确认（不写代码）：核对 M5-1 归一（删 `applyManualCompact/isManualEntry`、单一 batchSlice）与 M5-2（轮次/step 游标）就位，`compactNow` 可拆纯生成+落库子函数、conversation 有 step/round 运行态游标 | small |
| M5-BPC-1 | 数据与配置底座：`agentSettings` 加 `bpcThreshold(0.68)/compactThreshold(0.9，迁 COMPRESSION_THRESHOLD)/bpcDeltaSteps(2)/bpcAbortCooldownMin(3)`；conversation slice 加 `bpcThresholdOverride/compactThresholdOverride`（本对话覆盖、随 autosave+DB）；`RecordBatch` 加 `source('auto'\|'manual'\|'bpc')` 落库 | medium |
| M5-BPC-2 | `compactNow` 拆分：抽出 `generateAndAppend`（纯生成批+appendBatch 落库+同步 autosave，返回 recordMd 与水位，无 store.messages 副作用），现自动/手动注入组装改为薄壳调它；对现有路径逐字节不变 | medium |
| M5-BPC-3 | 新建 `services/bpcScheduler.ts`：状态机 + `BpcSnapshot`（冻结 compressedSegment 深拷贝 + step 游标 + targetReplaceStep）+ 独立 AbortController 集合 + `evaluateWater`（同口径 ratio）+ 后台执行（调 generateAndAppend）；复用 recordGenerator 可中止链路 | large |
| M5-BPC-4 | 接线进 `agentLoop.run()`：step 收尾钩子调 `evaluateWater`；ratio≥bpcThreshold 启动；ready 且到 targetReplaceStep 无缝替换（换 apiHistory 前缀，store 原文不动）；run() 进入前优先用 ready 的 BPC 跳过阻塞压缩；保留 0.9 硬阈值 compressContext 兜底 | large |
| M5-BPC-5 | 五边界落地：①超大输入直走硬阻塞兜底（复用 overLimitWithoutCompression）②替换前撞压缩阈值 → discardCurrent 转硬阻塞 ⑤无缝循环熔断（连续 2 次立即重触发 → 弹窗+circuit-broken+手动重启）；①②在 run() 入口判据、⑤在 scheduler | medium |
| M5-BPC-6 | UI 压缩环：footer token-counter 改 `CompressionRing`（idle 显 token%、generating 显环形进度+后台压缩中+中止、hard-compact 显阻塞）；中止调 `scheduler.abort()` 进 cooldown；同步 StatusBar/context tab 两处；订阅 scheduler 状态 | large |
| M5-BPC-7 | 分隔线与设置面板：`CompactDivider`（替代内联，按 source 区分手动/自动/BPC，BPC 专属样式+「BPC 自动压缩·已压 N 轮」），batchDividerByIdx 带 source；SettingsPanel 加压缩设置区（bpcThreshold/compactThreshold/δ/cooldown 滑杆 + ④风险提醒校验 + 本对话阈值入口） | medium |
| M5-BPC-8 | 双编译验证 `npm run build` + `electron:build`；自检：渐进触达 BPC 阈值→后台压缩→1+δ 步无缝替换→分隔线；超大输入直接硬阻塞；中止后冷却；连续循环熔断弹窗 | medium |

#### M5-TB · task_boundary（§10）

| stage | 一句话 | effort |
|---|---|---|
| TB-1 | 数据结构与 store：`conversation.ts` 加 `TaskBoundary/TaskBoundaryStep/taskHeadline` 类型 + `taskBoundaries/taskHeadline` 顶层字段 + reducers（setTaskHeadline/beginTaskBoundary/endTaskBoundary/appendTaskStep）+ clearConversation 清空、setConversation 回填；`agentSettings` 加 `taskBoundaryEnabled(默认 true)` + setter | small |
| TB-2 | 持久化三件套（仿 goal）：`database.ts` ensureColumn `task_boundaries_json/task_headline_json`；`electron/ipc/conversation.ts` 读写映射 + hasColumn 缺列降级；`conversationPersistence.ts` snapshot 字段 + autosave/save/读回回填 + 分支继承策略 | medium |
| TB-3 | AI 声明/推进工具：`toolRegistry.register` set_task_headline/begin_task_boundary/update_task_progress（+可选 end），handler 内 dispatch；`systemPrompt.ts` planning `<guidelines>` 加引导句 | small |
| TB-4 | Plan 模式 gating：AgentLoop wireTools/getActiveTools 按 `mode==='planning' && taskBoundaryEnabled` 过滤 task_boundary 工具（fast 不给）；SettingsPanel 加开关 UI | small |
| TB-5 | 卡片 UI（仿 WorkflowCard）：新建 `TaskBoundaryCard.tsx`（订阅 taskBoundaries、状态色、展开 steps、active 按秒滴答）；AgentPanel 顶部大标题条 + 对话流 Task 面板/Rail 渲染卡片列表；CSS 仿 wf-card | medium |
| TB-6 | 历史回看 UI（Antigravity 没有，新增）：卡片「历史」入口 → `openTaskHistoryTab`（中间编辑器 tab，仿 openWorkflowTab）或 portal 浮层，列出全部 boundary 时间线（标题/概述/steps）；已持久化、重启可读 | medium |
| TB-7 | 回溯联动（依赖 M5-1/M5-2）：truncateAt/回溯/分支 reducer 按 startRound/endRound 联动移除/收口 boundary，与轮次口径对齐；双编译验证 `npm run build` + `electron:build` | medium |

#### M5-SA · show_artifact（§11）

| stage | 一句话 | effort |
|---|---|---|
| S1 | 数据底座：`conversation.ts` 加 `MessageArtifact` 接口 + `Message.artifacts` 字段 + `addMessageArtifact` reducer（仿 FileDiffSummary/addMessageDiff）；新建 `services/artifactTracker.ts`（仿 fileChangeTracker contextId 分桶：trackArtifact/consumeTrackedArtifacts） | small |
| S2 | 工具注册：`toolRegistry.ts` 注册 `show_artifact`（path 必填+label 可选，approval auto / permissionCategory read）；handler 轻量校验路径存在 + `resolveEditorType` 预解析 viewerType，trackArtifact 登记进桶，返回确认串；不读正文 | small |
| S3 | agentLoop 接线：`agentLoop.ts:1075` 附近工具执行后并列调 `consumeTrackedArtifacts`，逐条 `dispatch(addMessageArtifact)`（仿 consumeTrackedFileChanges→addMessageDiff 链） | small |
| S4 | 卡片 UI：`MessageBubble.tsx` 加 artifacts 入参 + onOpenArtifact prop + 渲染块（仿 message-file-changes），chip 用 `fileIcons.getFileIcon` 彩色图标+文件名+Open；补 CSS（仿 file-change-chip） | medium |
| S5 | 打开接线：`AgentPanel.tsx` 加 `handleOpenArtifact`（仿 openDiffTarget，dispatch openTab 用 artifact.viewerType）+ MessageBubble 渲染处下传；确认 openTab 去重对 artifact 的体验 | small |
| S6 | 持久化/分支一致性核验 + 边界：确认 artifacts 随 sanitizeMessagesForPersistence 自动落库；核对 branchConversation 是否带上 artifacts（按决策补/剔）；处理路径失效（文件删/移动后点 Open）降级提示（仿附件无法打开通知） | medium |
| S7 | systemPrompt 工具引导 + 双编译：promptBuilder 工具说明点一句 show_artifact 用途（避免滥用/不用）；`npm run build` + `electron:build` | small |

#### M5-FIX · M4 验收回归修复（2026-06-17 真机验收两批排查，纯 bug 修复，独立于压缩返工可并行）

> 来源：两批 4+2 路真机只读排查（Office/高亮/搜索/MCP/输入框 + PDF/HTML）。这些是 M4 已交付功能在真机暴露的回归/缺失，**与 Plan_5 压缩/轮次返工无依赖**，可作为「梯队零」最先并行修。每个 stage 含真因（带「文件:行」线索）+ 修向 + effort。

| stage | 一句话（真因 → 修向） | effort |
|---|---|---|
| FIX-1 | **Office 转换 exit 1（profile 锁）**：`convertOfficeToPdf`（`electron/ipc/file.ts:51-60`）args 无 `-env:UserInstallation`，复用 LibreOffice 默认 profile（`AppData/Roaming/LibreOffice/4`，`.lock` 真实存在），脏锁/并发即 `soffice` close code=1（真机对照实证：默认 profile→EXIT=1 size=0，独立 profile→EXIT=0 成功）。→ args 注入 `-env:UserInstallation=file:///<每次转换独立临时 profile>`（Windows 合法 file URL，反斜杠转正斜杠），profile 目录随 tempDir cleanup（注意 `file.ts:164` cleanupTemp 白名单仅放行 `synapse-office-` 前缀，profile 目录需同前缀或扩展白名单）。一并解决并发抢锁。 | small |
| FIX-2 | **Office 转换零重试 + 裸错误文案**：`file.ts:77-81` close code!==0 直接 resolve error 无 retry，瞬时锁冲突（默认 profile 路线非确定性、前一次失败后一次成功）单次失败即报错；文案为裸 `Office 转换失败: exit 1`。→ `convertOfficeToPdf` 外层加 1-2 次重试（每次全新独立 profile + 全新 tempDir，重试前短延时），文案改友好提示（如疑似 LibreOffice 实例冲突）。注：`findLibreOffice` 路径解析正确、`soffice` 路径非真因（排除项，勿改路径逻辑）。 | small |
| FIX-3 | **代码文件无语法高亮**：`CodeEditor.tsx:144` 渲染是 `readOnly ? 高亮pre : textarea`，但四个调用点全传 `readOnly={false}`（`EditorArea.tsx:547`、`HtmlViewer.tsx:106`、`MarkdownViewer.tsx:106/:120`），高亮分支永不可达 → 代码文件纯文本无色。高亮链路本身（`detectLanguage`/`mapToPrismLang`/`registerLanguage`、依赖已装）全对，唯一断点是调用方 readOnly 传参（M4-4-S1 改了组件内部没接外部）。→ **方案 B 治本（推荐）**：改造 CodeEditor 让「可编辑也带高亮」（react-simple-code-editor + Prism highlight，或透明 textarea 叠在高亮 pre 上 + 滚动同步），四个调用点保持 `readOnly={false}` 不动，编辑/保存/高亮三者并存（注意逐键 re-highlight 性能 + 保持 Tab/Ctrl+S 行为）。 | medium |
| FIX-4 | **搜索功能整体未实装**：点左侧栏「搜索」（`ActivityBar.tsx:20` id='search'）后 `Sidebar.tsx:165-169` 只渲染静态占位（放大镜图标 + 文字），无 input/onChange/搜索状态/结果列表，全库无 SearchPanel/搜索执行组件，fileSystem 无内容搜索 API。→ 新建 `components/sidebar/SearchPanel.tsx` 替换占位：受控 input + 防抖触发 + 结果列表；文件名搜索走 fileSystem 树遍历，内容搜索（grep 类）新增 Electron IPC（如 `search:inContent`，主进程用 fs/ripgrep），Web 模式降级为仅文件名。属功能补全。 | large |
| FIX-5 | **MCP 全未自动启动**：`main.ts:102-121` whenReady 只调 `ensureDefaultMCPConfig()`+`registerMCPHandlers()`，无「遍历 config 对 enabled!==false 的 server 调 start」逻辑；`ipc/mcp.ts` 的 start 只在被动 `mcp:start` handler，`enabled=true` 仅被 UI 用来出文案（`SettingsPanel.tsx:1654-1662`），从未被启动序列消费 → memory-store(默认 enabled) 显示「已配置未启动」，需手动逐个点启动。→ `ipc/mcp.ts` 新增并导出 `startEnabledMCPServers()`（复用 loadMCPConfig + MCPServerProcess 启动，遍历 `enabled!==false` 逐个 new+start，单个失败 catch 不阻塞），在 `main.ts` whenReady `registerMCPHandlers()` 之后 fire-and-forget 调用（不阻塞创窗）；前端 `mcpBridge.refresh`（AgentPanel 构建 AgentLoop 时已调）会自然发现并桥接工具。让默认 memory-store 随应用自动起。 | small |
| FIX-6 | **HTML「渲染」模式纯白空白**：`HtmlViewer.tsx:92-98` 渲染模式 `<iframe srcDoc={content} sandbox="">`，空字符串 sandbox = 启用全部限制、禁所有脚本（含 jsdelivr 的 katex.min.js），依赖 JS 渲染的页面（KaTeX/图表）全白；源码模式显示同一 content 证明数据无误。确认非 CSP 问题（`main.ts` 无 CSP 注入、index.html 无 CSP meta）、非高度塌陷（`.html-preview-frame` editor.css:696-702 高度正常）。→ sandbox 放开到 `allow-scripts`（必需），按权衡可用 `sandbox="allow-scripts allow-same-origin allow-popups"`（评估越权面）；次级加固：CDN 依赖（katex 等）本地化随包内置防断网白屏。改后用真实带 KaTeX 的 .html 实测渲染。 | small |
| FIX-7 | **PDF 缩放点击「没反应」**：`PdfViewer.tsx:51-62` render effect 的异步 IIFE 里 `await pdfPage.render()` 无 try/catch、未保存 RenderTask 句柄去 cancel，连点 +/− 或首帧未完成时点缩放 → 同 canvas 重入触发 pdf.js `Cannot use the same canvas during multiple render() operations`，异常被静默吞掉、canvas 停旧 scale，表现「时灵时不灵」（OfficeViewer `:80` 复用同 PdfViewer 同病）。→ render effect 内 `const task = pdfPage.render(...)`，用 ref 记当前 task，cleanup 里 `task.cancel()`；`await task.promise` 包 try/catch 忽略 RenderingCancelledException、其余 setError；加 renderToken/cancelled 守卫防过期帧回写。 | small |
| FIX-8 | **PDF 不能 Ctrl+滚轮缩放**：`PdfViewer.tsx` 全文无 onWheel/ctrlKey/deltaY，`.pdf-viewer-canvas-container` 仅 overflow:auto 普通滚动，纯功能缺失（同项目 `ImageViewer.tsx:19-25` 已有现成 `onWheel + e.ctrlKey + preventDefault + deltaY` 范式）。→ 给容器加 wheel handler `if(e.ctrlKey){preventDefault(); deltaY<0?zoomIn():zoomOut()}`；因 React onWheel 默认 passive 无法 preventDefault，用 ref + `addEventListener('wheel', fn, {passive:false})` 绑原生事件。复用 ImageViewer 模式。 | small |
| FIX-9 | **PDF 无阅读模式切换（横向单页 vs 竖向连续滚动）**：`PdfViewer.tsx` 是「单 canvas 单页」模型（`page` state:17 + 单 `canvasRef`:15，render effect 每次只画当前一页），工具栏（`:82-91`）只有翻页 + 缩放，无 mode/layout state，连续滚动未实现，属架构缺失。→ 加 `const [mode,setMode]=useState<'paged'\|'scroll'>('paged')` + 工具栏切换按钮（参考 HtmlViewer viewer-mode-tabs 双按钮范式）；paged 保留现有单 canvas，scroll 模式 map totalPages 渲染 N 个 canvas 竖向堆叠（每页一 ref + 按需 lazy render + 取消旧任务），用 IntersectionObserver 把可见页回写 page 同步页码。配合 FIX-7 的 RenderTask 取消一起做更稳。 | medium |
| FIX-10 | **输入框清空不回弹（真机报告，代码层未复现）**：`AgentPanel.tsx:85-89` autoResizeTextarea 已正确「先置 auto 再读 scrollHeight」，`:291-293` useLayoutEffect 监听 input + onChange(`:2225`) 双触发，CSS（`.agent-input` layout.css:1177-1191 无写死 height）健全，Playwright Chromium 按精确结构实测完美回弹（撑5行98px→清空回弹20px），**代码逻辑正确、无可改根因**（置信度 medium）。→ 不臆造代码改动：先在真机（打包/dev）用 DevTools 现场观测发送后该 textarea 的 inline style.height + computed height 是否真未回弹；若真未回弹，排查引擎层覆盖不到的因素：①生产构建 index.css/layout.css 是否真加载（Tailwind v4 @import 顺序/注入时机）②StrictMode/re-render 是否重挂 inputRef ③Inter 字体未加载完导致首次 line-height 偏差（可对 `document.fonts.ready` 再补一次 autoResize）。拿到真机 inline-style 证据前不动代码。 | small |

#### M5-UI · 视觉/交互打磨（2026-06-17 真机验收，纯观感/交互，不动功能逻辑，独立可并行）

> 来源：批二「文件查看器透明融背景 + 全局可读性」7 finding + 批一「新 UI 设计」3 finding。核心是把壁纸透明体系从「面板外壳粒度」下沉到「查看器内容区粒度」，并补三处 UI 美化。与压缩返工无依赖。

| stage | 一句话（真因 → 修向） | effort |
|---|---|---|
| UI-1 | **查看器内容区写死不透明纯色、盖死壁纸**（透明没做好的总根因）：`layout.css:59-70` 只给 8 个「面板外壳」套 `rgba(--syn-bg-surface-rgb, --glass-opacity)+blur` 半透明，但外壳里各 viewer 内容区写死纯色盖在上面——`.code-editor`(editor.css:64 `#0d1117`)、`.pdf-viewer`(editor.css:6 `var(--syn-bg)`)、`.image-viewer`(editor.css:969 `var(--syn-bg-base)`)、`.review-changes-view`(editor.css:1038)、`.html-preview-frame`(editor.css:701 `white`)，且无任何 `html[data-wallpaper="enabled"]` 选择器覆盖它们。→ 新建一套查看器透明规则：`html[data-wallpaper="enabled"]` 作用域下把各 viewer 容器背景从硬纯色改 `transparent` 或 `rgba(--syn-bg-surface-rgb, --viewer-opacity)`，**引入 `--viewer-opacity` 变量**（可独立于 `--glass-opacity`，给查看器更高不透明度保可读）。代码/Markdown/图片直接改容器底色半透明。 | medium |
| UI-2 | **透明后缺「可读性保护」层**：内容区改透明后文字仍用 `--syn-text-primary`（暗主题浅灰 / 亮主题深色），壁纸为亮图/花色时浅灰文字对比度骤降；代码高亮固定 vscDarkPlus 配色直接压壁纸不可控；现状无任何蒙版/描边/对比度自适应。→ 内容区底色不用纯 transparent 而用 `rgba(--syn-bg-surface-rgb, --viewer-opacity)`，`--viewer-opacity` 设保证可读的下限（如 0.55-0.7，高于纯透明）；正文文字加细微 text-shadow 描边（如 `0 1px 2px rgba(0,0,0,0.5)`）；代码高亮保持深色衬底（vscDarkPlus 配深色半透明蒙版，不让代码区纯透明）。可读性下限交给用户（见 UI-4 设置项）。 | medium |
| UI-3 | **PDF/Office/HTML 白底文档「纸张浮于背景」范式**：PDF/Office canvas 像素本身白纸黑字不透明（透明会让黑字飘壁纸上不可读），`.pdf-viewer-canvas-container`(editor.css:39-46 `rgba(0,0,0,0.2)`+padding) 已是「纸浮于半透明背景」正确雏形，但外层 `.pdf-viewer`(editor.css:2-7 `var(--syn-bg)` 纯黑) 兜死了它；HTML iframe(`.html-preview-frame` white、AttachmentTabViewer PDF iframe 内联 `background:#fff` EditorArea.tsx:456)同理。→ 外层 `.pdf-viewer` 去纯色改 transparent，`.pdf-viewer-canvas-container` 保留/调亮半透明衬底（如 `rgba(--syn-bg-surface-rgb, 0.35)+blur`），canvas 加圆角+阴影做成「一张纸」；HTML 渲染 iframe 套同一范式（外包半透明边框/圆角/padding 让白纸浮在壁纸上，不强透明以免破坏页面）。统一「文档纸张浮于背景」。 | medium |
| UI-4 | **磨砂度与壁纸模糊共用同参数、缺查看器透明度粒度 + 默认值口径**：`useThemeEffect.ts:44` 用 `background.blur` 给壁纸 filter:blur、`:57` 又用同一值设 `--glass-blur`（面板磨砂），「磨砂度」滑块（`SettingsPanel.tsx:857-860`）同时控壁纸模糊和面板磨砂无法分开；设置只有 blur/opacity/panelOpacity 三项，无查看器维度。另：panelOpacity 默认实为 0.75（`agentSettings.ts:101`、`SettingsPanel.tsx:210`，滑块 50-95%），非「60%」（口径澄清，非 bug）。→ 拆分/扩展 BackgroundSettings（`agentSettings.ts:24-34`）：①壁纸模糊与面板磨砂拆 `wallpaperBlur/panelBlur`（或至少明确文案）；②新增 `viewerOpacity`（默认略高于 panelOpacity 保可读）+ `readabilityGuard` 布尔（开启强制蒙版+文字描边）。三处接线：agentSettings 加字段+默认、useThemeEffect 注入 `--viewer-opacity/--panel-blur`、SettingsPanel 加 range/toggle（沿用现有 `.setting-item` 模式零新组件）。**所有新参数须进设置面板可调（呼应规范 §8.3 强约束）。** | medium |
| UI-5 | **media/showcase 容器无背景定义 + `.app-background` 双重定义重叠蒙版**（次要）：`MediaPlayer`/`ShowcaseFrame` 容器（`.media-player`/`.showcase-container` 等）在 styles/ 下全无 CSS 背景定义（碰巧透明但无可读性兜底）；`.app-background` 在 index.css:160-179 与 layout.css:6-29 各定义一份，index.css 版 `::after` 多压一层固定 `rgba(--syn-bg-surface-rgb,0.2)+blur` 蒙版（layout.css 版无），两份叠加导致壁纸恒有一层与「壁纸透明度」无关的额外暗化。→ 统一透明改造时给 media/showcase 容器补 transparent/半透明规则纳入体系；`.app-background` 合并为单一权威定义（建议留 layout.css 版、删 index.css 版），`::after` 固定 0.2 蒙版改为受 `--glass-opacity` 或新 `--wallpaper-overlay` 变量控制，让壁纸暗化可调。 | small |
| UI-6 | **工作区文件夹回到课件管理就全展开、不记忆展开态**：`FileTree.tsx:66` `useState(depth < 1)`——展开态是每个 FileTreeItem 的组件本地 state，默认 `depth<1`（顶层全开、二层及下折叠），切走视图组件卸载、切回 re-mount → useState 取初值，手动状态全归零；全文无 expandedDirs/Set/持久化。→ 展开态从本地 useState 提升为 **per-workspace 持久集合**、默认折叠：①用 `Set<string>`（已展开路径）由 FileTree 顶层持有经 props 下传（去 `:66` 本地 useState，`isExpanded=set.has(node.path)`，handleClick 改 toggle 顶层 set）；②按工作区隔离持久化，key 用 `workspace.currentPath`（store 已有），存 sessionStorage（`synapse:fileTree:expanded:<wsPath>`）或新建 uiState slice 的 `fileTreeExpandedByWorkspace` map，换工作区天然不同 key 自动重置；③初始空集即全折叠（改掉 `depth<1`）；④可选加「全部展开/折叠」按钮。路径含特殊字符做 encode。 | small |
| UI-7 | **右侧栏顶部对话切换器 portal 浮层文字看不清（对比度低）**：三处叠加——①`.agent-conv-panel`(layout.css:617-627) 自身未设 background，仅继承 `.glass-panel` 的 `--glass-bg: rgba(17,17,24,0.75)`+blur，portal 到 body 背后是壁纸层 → 文字背景不稳定；②列表标题用 `--syn-text-secondary`(#94a3b8)、范围按钮/空态/徽标用 `--syn-text-muted`(#64748b 对 #111118 仅约 3.0:1 < AA 4.5:1)；③选中/hover 背景 `rgba(--syn-accent-rgb,0.16)` 仅 16% alpha 区分弱。→ ①`.agent-conv-panel` 显式设不透明背景覆盖 glass（如 `var(--syn-bg-elevated)` 实色或 `rgba(20,20,30,0.97)`，保 blur，浅色主题用对应 elevated）；②文字提档（列表标题→primary，次要文字最低 secondary 不用 muted，范围选中态文字 primary + bg alpha 提 0.28-0.32）；③选中/hover bg alpha 提 0.24-0.30 + 选中项加 accent 左边框；④搜索 icon muted→secondary；可加 `.agent-conv-panel{color:var(--syn-text-primary)}` 兜底。 | small |
| UI-8 | **设置页各 tab 观感粗糙（无分组卡片/层次靠 inline marginTop 硬撑/分隔线几乎不可见）**：`.settings-section`(settings.css:79) 仅 min-width:0 无卡片包裹，一个 tab 多个 h3 段平铺同流无边界；段间距靠 JSX inline `style={{marginTop:24}}` 手写（`SettingsPanel.tsx:779/1057/1067/1111/1135/1147` 等多处）；`.setting-item` border-bottom `rgba(255,255,255,0.03)` alpha 仅 0.03 几乎不可见；label `flex:0 1 92px` 长 label 易换行；h3 仅 13px/600 与正文 12px 几乎同级。→ 引入「分组卡片+统一层次+留白」纯观感：①新增 `.settings-group`（背景 `--syn-bg-surface`、border `--syn-border`、radius 10px、padding 14-16px、相邻组 margin 16px），JSX 用 `<section className="settings-group">` 包「h3+该组 setting-item」、删所有 inline marginTop:24；②区分 section 主标题(14-15px)与组内 h3 副标题；③分隔线 alpha 0.03→0.06-0.08、`:last-child` 去边框、行距 8→10px；④label `flex:0 0 96px` 顶对齐 + 控件 hover/focus accent 反馈；⑤ToggleItem(`:1846`) 行套 `.setting-item`。改动主要在 settings.css 加类 + 10 个 tab 用 section 包裹（机械量大）。 | medium |

> stage 总数：压缩返工 M5-1~M5-7 共 7 + M5-RL 6 + M5-BPC 9 + M5-TB 7 + M5-SA 7 = 36；2026-06-17 真机验收新增 M5-FIX 10 + M5-UI 8 = 18 → **共 54 stage**（压缩返工 36 + 真机回归/打磨 18）。

### 3.3 梯队依赖图（五梯队）

```
梯队零·快速回归修复（可立即并行，不依赖压缩返工，建议最先开工）
  M5-FIX M4 验收回归修复（10 stage：Office profile 锁/代码高亮/搜索实装/MCP 自动启动/
         HTML 渲染/PDF 缩放/PDF Ctrl 滚轮/PDF 阅读模式/输入框回弹取证）—— FIX 类纯 bug，
         彼此独立、与压缩返工零耦合，可并行抢修
  M5-UI  视觉/交互打磨（8 stage：查看器透明融背景/可读性保护/文档纸张范式/透明度参数拆分/
         media·背景蒙版/文件夹折叠记忆/对话浮层美化/设置页美化）—— UI-1~UI-5 透明体系
         同源（建议 UI-1→UI-2→UI-3→UI-4 顺做、UI-5 收尾），UI-6/7/8 三处独立

梯队一（地基，串行必先）
  M5-1 压缩归一 ──► M5-2 轮次地基 ★（下面全吃它）

梯队二（四处共用轮次，可并行）
  M5-2 ─┬─► M5-3 回溯
        ├─► M5-4 重试
        └─► M5-5 分支

梯队三（压缩增强，建立在归一+轮次之上）
  M5-2 ─► M5-6 增量生成 δ（BPC 替换时机参考同源 δ 思路）
  M5-1 + M5-2 ─► M5-RL record 多级分层（R-L1~R-L5 必做）
                    └─► M5-BPC 后台预压缩（依赖归一+轮次+分层「压完有上界」）
                          R-L6 预测驱动折叠 = BPC↔分层 双向衔接（可选）

梯队四（独立 UI，可穿插任意梯队后）
  M5-TB task_boundary（数据/工具/卡片独立可起；TB-7 回溯联动依赖 M5-2）
  M5-SA show_artifact（完全独立，不碰压缩/轮次）
  M5-7 懒加载（纯前端虚拟滚动，独立）
```

**梯队语义**：
- **梯队零**（M5-FIX / M5-UI）是 2026-06-17 真机验收发现的回归/缺失/打磨，**与压缩返工（梯队一~四）完全无依赖**，可立即并行开工，不必等任何压缩 stage。建议优先级：M5-FIX 纯 bug（尤其 Office profile 锁 FIX-1/2、PDF 缩放 FIX-7、HTML 渲染 FIX-6、MCP 自动启动 FIX-5 这些 small 项）可最先抢修立竿见影；M5-UI 透明体系 UI-1~UI-5 同源建议顺做、UI-6/7/8 独立可穿插。FIX-10（输入框回弹）须先真机 DevTools 取证再决定是否动代码。
- **梯队一**必须最先、串行完成（M5-1 → M5-2），所有下游都吃轮次地基。
- **梯队二**（回溯/重试/分支）共用 M5-2 轮 helper，三者可并行。
- **梯队三**是压缩核心增强：M5-RL 的 R-L1~R-L5 给请求体「压完有上界」，是 M5-BPC 无限循环熔断（边界 5）的结构性前置；M5-BPC 9 个 stage 在归一+轮次+分层之上落地。R-L6 把 BPC 与分层双向打通（BPC 预测超标主动驱动折叠），可选。
- **梯队四**全部相对独立：M5-TB / M5-SA / M5-7 可穿插在任意梯队之后并行推进，互不阻塞。M5-TB 唯一的耦合点是 TB-7 回溯联动需 M5-2 就位。

## 四、决策默认（用户已拍板，写进文档）

| 项 | 决策 | 出处 |
|---|---|---|
| record 分层下界 | 必须做到「压完有上界」（R-L1~R-L5 **必做**：确定性三级 + 折叠 + token 硬闸） | §2.5 |
| BPC↔分层衔接 | R-L6（预测驱动折叠）**可选**，非阻塞 | §2.5/§8 |
| **step 定义** | **step = 一次 user 消息 或 一次 model API 往返；tool 结果不单独算 step（无「工具步」之分）。用户发两条=两步；「调命令→出结果→再发模型→模型思考+输出含工具调用」=一步** | §1 |
| **BPC 替换时机** | **BPC 压好（ready）后下一轮 run 发请求即可用；`1+δ` 只是「最晚替换上限」（非必须等到），δ 窗口供替换没赶上/失败时自动 retry 兜底** | §8.1/§8.2 |
| **可调参数强约束** | **所有可调参数（BPC/压缩阈值、δ、中止冷却、循环熔断间隔、record 分层 H/T/M/RATIO 等）都必须在设置面板有可调区域；写死常量只能作默认值、不能作唯一来源** | §8.3/§9 |
| δ（BPC 延迟） | 默认 2，即 `1+δ=3`；可设任意正整数 | §8.3 |
| BPC 阈值 | 默认 0.68（占全窗口绝对百分比） | §8.3 |
| 硬阻塞压缩阈值 | 默认 0.9（迁 `COMPRESSION_THRESHOLD`） | §8.3 |
| 中止冷却 | 默认 3 min（可设） | §8.3 |
| task_boundary | 默认开（Plan 模式 + `taskBoundaryEnabled=true` 双闸；fast 不给） | §10.4 |
| record 分层常量 | H=2 / T=1 / M=20 / RECORD_MAX_RATIO=0.4 | §2.5.4 |

## 五、原有决策记录（用户已拍板）

- **懒加载 = 纯前端虚拟滚动**，store 全量持有不变，不碰本地存储/record/回溯（用户 2026-06-17 纠正，推翻"底座级"误判）。
- **重试入口 = user 消息**（点 user 重试 = 回溯+自动重发），非 AI 消息（用户 2026-06-17 纠正）。
- 回溯/重试/分支统一以"user 消息=轮起点"为锚（见规范 §3/4/5）。

## 六、待用户最终拍板点（不阻塞排期，落地前确认）

> 以下来自 4 领域研究 openQuestions，均为「实现层细节」，不影响梯队划分与 stage 拆分；建议在对应 stage 开工前逐条确认。

**M5-RL（record 分层）**
- ✅ **已拍板（2026-06-17）**：设计 B 折叠 =「永不删减原文、仅折叠请求体视图」**确为用户本意**（原始批留库、`record_read`/UI 完整可见，折叠产物仅用于注入前缀）。见规范 §2.5.2 ②。
- 尾 T 批全文是否必要（与 `compressContext keepCount=4` 保留的最近原文语义部分重叠），还是只做头全文 + 中段三级降级。
- cache 优先级分叉：「cache 绝对不漂（只能设计 A、接受 O(n) 斜率）」vs「可接受偶发 cache miss 换防膨胀上界（才能上设计 B/C 根治）」。**当前默认按后者**（必做 R-L1~R-L5）。

**M5-BPC**
- ✅ **已拍板（2026-06-17）**：δ 与替换时机 = BPC 压好即可用、`1+δ` 为最晚上限（非必须等到）、δ 窗口供替换没赶上/失败自动 retry；step 不含 tool step（step = user 消息 或 model API 往返）。见规范 §1/§8.1/§8.2/§8.4。
- ✅ **已拍板（2026-06-17）**：BPC 替换不必严格等到 `targetReplaceStep` —— ready 即可在下一个 run 用。见规范 §8.4。
- 熔断「连续两次无缝循环」的精确 step 间距阈值（仍待定；该阈值须按强约束进设置面板可调）。
- scheduler 状态承载（不持久化 `bpc` slice vs EventEmitter，倾向前者）。

**M5-TB**
- 卡片渲染位置（A 顶部可折叠面板 vs B 按 anchorMessageId 穿插，倾向 A 首版）。
- 历史 UI 形态（中间编辑器 tab vs portal 浮层）。
- 收口时机（是否需 AI 显式 end vs 自动收，倾向自动）。
- 分支时 taskBoundaries 是否复制。
- steps 是否需条数/token 上限。

**M5-SA**
- 卡片图标（fileIcons 彩色 vs lucide 单色）。
- artifacts 是否随对话持久化（默认会）+ 点开存在性降级。
- branch 时 artifacts 是否复制进新对话。
- 是否给用户侧入口（v1 是否只做 AI 工具侧）。
- 一次一文件 vs 多文件数组；是否支持深链（PDF 页/代码行）。
- Web 模式能否打开工作区文件卡片（v1 是否限 Electron）。

> （旧版"四/五/六"已并入：M5-1~M5-7 明细 → §3.2；决策 → §四决策默认 + §五原有决策记录；待补充项已全部补完 → 见 §六待最终拍板。）

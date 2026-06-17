# Plan_5 · 压缩/回溯/分支/重试 核对偏差清单 + 返工映射

> 2026-06-17，8 路只读核对「当前实现 vs [统一模型规范](Plan_5_压缩回溯统一模型规范.md)」结果整理。
> 状态：**已定稿为返工 Plan**（M5 系列，36 stage / 4 梯队）。用户已补全 BPC（§8）+ record 分层（§2.5）+ task_boundary（§10）+ show_artifact（§11）+ UI 细节（§9），并整合 4 领域研究的 29 个新 stage。完整 stage 清单与梯队依赖见「三、返工结构」，决策默认见「四、决策默认」，落地前待确认细节见「六」。

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

### 3.2 完整 stage 清单（从研究 stages 字段搬运，不丢）

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

> stage 总数：原 M5-1~M5-7 共 7 + M5-RL 6 + M5-BPC 9 + M5-TB 7 + M5-SA 7 = **36 stage**（其中新增 4 块共 29 stage，与研究输出一致）。

### 3.3 梯队依赖图（四梯队）

```
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
- **梯队一**必须最先、串行完成（M5-1 → M5-2），所有下游都吃轮次地基。
- **梯队二**（回溯/重试/分支）共用 M5-2 轮 helper，三者可并行。
- **梯队三**是压缩核心增强：M5-RL 的 R-L1~R-L5 给请求体「压完有上界」，是 M5-BPC 无限循环熔断（边界 5）的结构性前置；M5-BPC 9 个 stage 在归一+轮次+分层之上落地。R-L6 把 BPC 与分层双向打通（BPC 预测超标主动驱动折叠），可选。
- **梯队四**全部相对独立：M5-TB / M5-SA / M5-7 可穿插在任意梯队之后并行推进，互不阻塞。M5-TB 唯一的耦合点是 TB-7 回溯联动需 M5-2 就位。

## 四、决策默认（用户已拍板，写进文档）

| 项 | 决策 | 出处 |
|---|---|---|
| record 分层下界 | 必须做到「压完有上界」（R-L1~R-L5 **必做**：确定性三级 + 折叠 + token 硬闸） | §2.5 |
| BPC↔分层衔接 | R-L6（预测驱动折叠）**可选**，非阻塞 | §2.5/§8 |
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
- 设计 B 折叠「重写最老批」与「已有批次永不重写」的边界：解法是「原始批留库 + 另存折叠产物（archived 视图）」——请确认「永不删减原文、仅折叠请求体视图」符合本意。
- 尾 T 批全文是否必要（与 `compressContext keepCount=4` 保留的最近原文语义部分重叠），还是只做头全文 + 中段三级降级。
- cache 优先级分叉：「cache 绝对不漂（只能设计 A、接受 O(n) 斜率）」vs「可接受偶发 cache miss 换防膨胀上界（才能上设计 B/C 根治）」。**当前默认按后者**（必做 R-L1~R-L5）。

**M5-BPC**
- δ 与替换时机精确语义（从触发还是从生成完成算起；step 是否含 tool step）。
- BPC 替换是否必须严格等到 `targetReplaceStep`（ready 但未到 target 时手动发消息这一轮用旧前缀还是 BPC 前缀）。
- 熔断「连续两次无缝循环」的精确 step 间距阈值。
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

## 四、各块关键偏差与修向（精炼）

- **M5-1 压缩归一**：删 `applyManualCompact`/`isManualEntry`/system 摘要卡片 + dispatch；`/compact`→`compactNow`；清理误导注释。`effort` 中。
- **M5-2 轮次地基**：新增轮边界层；`compressContext` 保留按 token→向轮边界取整；批次 stepStart/stepEnd 由轮推导；`clampToBatch`/`copyRecordFrom` 裁剪基准对齐轮边界（`keptRounds` 转真实依据）。`effort` 中-大。
- **M5-3 回溯**：`handleUndoToMessage` 重做——定位目标轮 N、`setPendingMessage` 回填 N+1 轮 user（恢复 pending 附件、不自动发、GC 排除它）、按轮 truncate。入口语义统一到"轮"。`effort` 中。
- **M5-4 重试**：入口**改挂 user 消息**；`handleRetry` 截断基准从"被点 AI 之前"改为"该 user 轮之后全部（含本轮所有 assistant/tool 中间步）"，再 `skipUserMessage` 自动重发。`effort` 中。
- **M5-5 分支**：`branchConversation` cutIdx 向轮边界取整；与回溯对齐（user 分支点→新对话 setInput 回填待发）。砍批口径已对，复用 M5-2 轮 helper。`effort` 中。
- **M5-6 δ 参考**：`GenerateBatchInput` 加 contextBefore/contextAfter（δ≤1 轮/按 token）；`buildBatchPrompt` 增"前文/后文参考（只读勿写入）"分区；参考不计入 step/round 水位。`effort` 中。
- **M5-7 懒加载**：引虚拟滚动（react-virtuoso / @tanstack/react-virtual / 手写窗口化）替换 `AgentPanel.tsx:1996` 全量 `messages.map`；改无条件 `scrollIntoView`（:413-415）为"仅底部附近才置底"；store 全量持有不变、**不碰 record/存储/回溯**。`effort` 中。

## 五、决策记录（用户已拍板）

- **懒加载 = 纯前端虚拟滚动**，store 全量持有不变，不碰本地存储/record/回溯（用户 2026-06-17 纠正，推翻"底座级"误判）。
- **重试入口 = user 消息**（点 user 重试 = 回溯+自动重发），非 AI 消息（用户 2026-06-17 纠正）。
- 回溯/重试/分支统一以"user 消息=轮起点"为锚（见规范 §3/4/5）。

## 六、待用户补充（补完即定稿）

- **`background-pre-compact`**（后台预压缩）机制 → 规范 §8 占位。
- **UI 细节点**（压缩分隔线样式、回溯/重试/分支入口呈现等）→ 规范 §9 占位。

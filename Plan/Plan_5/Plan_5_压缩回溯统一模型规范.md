# Plan_5 · 压缩 / 回溯 / 分支 / 重试 统一模型规范（权威真相源）

> 2026-06-17 用户口述纠正后固化。**压缩相关的一切实现以本规范为唯一准绳**，禁止各自理解。
> 背景：M4-1/M4-5/M4-6 实现时对「压缩」理解跑偏（把 `/compact` 做成了截断 store 的"手动归档"，与自动压缩成了两套），本规范统一纠正。

## 0. 核心原则（最高优先）

1. **压缩有且仅有一套**。手动 `/compact` ＝ 自动压缩，**完全同一套逻辑**，仅触发方式不同（手敲命令 vs 聊到 token 水位）。不存在"手动/自动两套实现"，不存在 `isManualEntry` 分支差异。
2. **UI 与本地完整对话文件永不删减**。压缩**不删任何消息**，只在压缩发生的那个点显示一个标记（"已在此压缩 + 压了多少"，类似 CC 的 `Compacted` 分隔线）；标记之前的原文在 UI 上**照常完整显示**。
3. **UI 显示 ≠ 发给模型的请求体**。
   - UI/本地文件：**全量**，永远是完整对话。
   - 请求体（发给模型）：`system prompt + record(多批次增量摘要) + 最近保留的原文轮次`。

## 1. 轮次（round）与 step 定义

- **step**：每条消息（user / model / tool 结果 / 子代理结果 …）＝ 1 step。是最小统计单位。
- **轮次（round）= 一个 user→model 的完整循环**：
  - **user 段**：连续的 user 消息（中间没有 model 完整响应），可以是 1 条，也可以连发多条。
  - **model 段**：紧随其后的 model 响应，**含其间所有工具调用、子代理派发与回收**——这些全部只是 step+1，**不增加轮次**。
  - **轮次起点**：对话空闲（model 已响应完）之后出现的**第一条新 user 消息**。
  - user 已发、model 还没回 ＝ 新一轮**已经开始**。
  - 即：一轮 ＝ `[本轮 user 段全部消息] + [本轮 model 段全部消息（含工具/子代理 step）]`。
- **压缩触发判定是 step 粒度**（可以落在某一轮中间的 step），但**保留原文与 record 批次的边界一律按轮次保底**（向轮边界取整，不在轮中间切）。

## 2. 压缩流程（自动与 /compact 共用）

请求体恒为：`system prompt + record(多批次增量) + 最近保留的原文轮次`。

触发时（聊到水位 自动，或 `/compact` 手动，**走同一函数**）：
1. 从**本地完整对话文件**读取原文（懒加载，用多少读多少，见 §6）。
2. 按 **token / 轮次保底规则**算出保留最近几轮原文。
3. **已有 record 批次保留不动**，只对**新增段**做增量生成。
4. 增量生成时，用 `[目标段起 − δ 轮 ~ 目标段止 + δ 轮]` 的原文做**前后文连贯性参考**（δ 很小，≤1 轮、甚至按 token 取即可），但本批 record **只覆盖目标段本身**。生成行为参考 `C:\Users\Stardust\.gemini\antigravity\mcp-memory-store` 的增量逻辑。
5. record **追加**新批次（已有批次永不重写）。

**示例**（48 轮 / 172 step，上次在 38 轮压缩、保留 36-38 轮原文）：
- 压缩前请求体 ＝ `system + record(1-8 / 9-21 / 22-34 / 35) + 36-48 原文`
- 本次算出保留 2 轮（47-48）→ 对 **35-46** 增量生成（参考 `35-δ ~ 46+δ`）→ 产出新批次如 `35-45 / 46`
- 压缩后请求体 ＝ `system + record(1-8 / 9-21 / 22-34 / 35-45 / 46) + 47-48 原文`

## 2.5 record 多级分层（请求体上界保证）

> 新增章节（2026-06-17）。目的：让请求体里的 record 注入前缀**有上界**，即压缩完一定降到目标水位以下，杜绝「压完仍高位 → 下一轮立即再触发」的无限循环（BPC 第 5 点的前置依赖）。

### 2.5.1 现状（M4-5-S2 只做了「2 级分层」，不防膨胀）

`buildStableRecordPrefix`（`agentLoop.ts:341-352`）当前是**两档**：
- 头 `STABLE_HEAD_FULL=2` 批 → 全文 `contentMd`；
- 其余所有批 → 骨架 `renderSkeletonBatch`（`[批次N 骨架，record_read(batchIndex=N) 可展开]` + `b.skeleton`）。

骨架来源 `extractSkeleton`（`recordStore.ts:124-145`）正则提「# 一级标题 + 每个 ## 二级标题 + 该节首行 1 条要点」，批生成时固化进 `RecordBatch.skeleton`，渲染只读不重算。

**关键问题**：M4-5-S2 为「prompt-cache 前缀稳定」**主动删掉**了原 `buildRecordPrefix` 的 token 预算动态升降级，换成固定规则。代价是**骨架总量 = O(批数) 线性增长、无上界**。估算 60 批时前缀 ≈ 25k tokens 量级；小窗口模型下压完仍可能逼近阈值 → 无限循环。当前在「cache 稳定 vs 防膨胀」中偏向了 cache，牺牲了膨胀控制。

### 2.5.2 多级分层方案（确定性三级 + 折叠 + 硬闸）

总原则：**保持「按批位置的确定性渲染」（批集合不变 → 注入前缀逐字不变 → cache 不破），同时给 record 段引入上界保证。**

**① 设计 A · 确定性三级分层（cache 不破，先压斜率）**
把「头 N 全文 / 其余骨架」扩成三档，分档边界**只依赖批位置与总批数 N**，不依赖 contextWindow / 实时 token：
- 档 1 头 H 批（默认 2，保留 `STABLE_HEAD_FULL` 语义）→ 全文；
- 档 2 尾 T 批（新增，默认 1）→ 全文（让最近被压批也享全文，呼应「保留头尾」）；
- 档 3 中间批 → 骨架；当中间批数 > 阈值 M（默认 20）时，把**中间偏老一段**再降为**仅标题级**（新增 `extractSkeletonTitle`：只留 `#` + `##` 标题行，丢每节首行要点，量纲 ≈ 骨架的 1/3）。降级边界用「序位 < N−T−K」这类纯位置规则确定，**不看 token**。
- 效果：N=60 时前缀从 ~25k 降到 ~12k tokens 量级，cache 仍稳定。**残留**：仍是 O(n)，只是斜率变小。

**② 设计 B · 分段折叠（根治 O(n)，接受阶梯式 cache）**
批数超阈值时，把最老一长串批（批 0~K）在**生成侧**预折叠成 1 个「元批 / 超级骨架批」（`contentMd` = 这批骨架的再摘要或正则合并标题），请求体只注入元批骨架 + 后续正常分层。
- 新增 `foldOldBatches`（`recordStore.ts`），触发点 = 批数过阈值时的压缩流程内（`compactNow` 之后）。
- **代价**：折叠改变批集合 → 该次 compaction 一次性 cache miss（可接受），折叠后前缀重新稳定 =「阶梯式稳定」而非「逐批稳定」。
- **与「已有批次永不重写」（§0、`recordStore` 契约）的协调**：新增「归档批 archived」概念——**原始批仍留库**（`record_read` 可展开、UI 照常显示，满足 §0.2「UI/本地永不删减」），**仅请求体注入视图**用折叠产物。即「永不删减原文、仅折叠请求体视图」。

**③ 设计 C · token 预算硬闸（兜底，独立于 cache）**
`buildStableRecordPrefix` 输出后、组装 `apiHistory` 前（`agentLoop.ts:619`）加一道「前缀 token 上限」闸：record 前缀估算超过 `contextWindow × RECORD_MAX_RATIO`（默认 0.4）时，从中段骨架批起逐批降 `titleOnly` 直到达标。
- 仅作**绝对兜底防炸窗**，正常路径不触发（定位同现有 `truncateOverLongHistory` 危险态 `agentLoop.ts:629-634`）。会让前缀随窗口/批数漂移，故不进正常路径。

**落地优先级**：设计 A（确定性三级，零 cache 代价，先缓解）→ 设计 B（折叠，根治 O(n)，阶梯 cache）→ 设计 C（token 硬闸兜底）。**BPC 真正依赖的「压完有上界」= 设计 B + C**；设计 A 可独立先上。

### 2.5.3 与归一 / 轮次地基的衔接

- 全部挂在 `buildStableRecordPrefix`（注入侧）与 `compactNow`（生成侧），与「手动/自动两套」无关——M5-1 归一后只有一条路，改一处全覆盖。
- 分档边界用「批位置」，与轮次正交；但元批折叠的 `roundStart/roundEnd` 需按轮边界取整（§1），复用 `RecordBatch.roundStart/End`。

### 2.5.4 默认值（已拍板，见返工文档「决策默认」）

| 参数 | 默认 | 含义 |
|---|---|---|
| `STABLE_HEAD_FULL` (H) | 2 | 头部全文批数 |
| `STABLE_TAIL_FULL` (T) | 1 | 尾部全文批数（新增） |
| `SKELETON_TITLE_THRESHOLD` (M) | 20 | 中间批超此数则最老段降 titleOnly |
| `RECORD_MAX_RATIO` | 0.4 | record 段最多占窗口比例（硬闸） |

> **决策**：record 分层做到「压完有上界」（设计 A+B+C，对应 R-L1~R-L5）为**必做**；BPC 主动驱动折叠时机（R-L6 预测驱动）为**可选**。

## 3. 回溯（rewind）

回溯到第 N 轮（例：44 轮结束、45 轮 user 还没发）：
- **UI + 本地文件**回到第 N 轮结束状态（N 之后的消息移除）。
- **输入框**填入第 N+1 轮那条 user 消息（待发，不自动发）。
- **record 砍掉**第 N 轮所在批次**之后**的所有批次。
- 所在轮回退到原文（**大轮次保底**：保留整个所在轮次的原文，不在轮中间切）。
- 例：回溯到 44 轮 → record 砍回 `1-8 / 9-21 / 22-34`，`35-44` 变回原文 → 请求体 ＝ `system + record(1-8 / 9-21 / 22-34) + 35-44 原文`，输入框填 45 轮那条。

## 4. 分支（branch）

**新对话 = 老对话回溯到分支点后的状态**（独立成一个新对话，老对话不动）。语义上 = §3 回溯 + 落成新对话。

## 5. 重试（retry）

**入口在 user 消息上**（不是 AI 消息）。点某条 user 消息的「重试」= 回溯到该 user 所在轮（§3 语义：该 user 之后的全部消息移除、record 砍对应批次），但那条 user 消息**不填进输入框，而是自动重新发出**。

> 回溯 / 分支 / 重试三者统一以「某条 user 消息 = 轮起点」为锚：
> - **回溯** = 回到该轮，user 填入输入框**待发**（可改）。
> - **重试** = 回到该轮，user **自动发出**（不填输入框）。
> - **分支** = 回到该轮，落成**新对话**（源对话不动）。

## 6. 懒加载（纯前端渲染优化，不碰存储/record 体系）

> ★定位澄清（2026-06-17 用户纠正）：懒加载**只是前端 UI 的渲染优化**——**不影响本地文件存储、不影响 record 体系、不影响回溯/分支/重试**（这些仍按 store 全量 messages 计算）。store 照常全量持有消息（纯文本 + 附件 sha256 引用，附件二进制本就分离存储、不进消息数组，内存可控）。真正的瓶颈是「把上万条消息一次性渲染成 DOM」导致卡顿，**不是内存**。

- **核心 = 虚拟滚动**：只把用户当前可视区内的消息渲染成 DOM，视口外的不渲染；上滚时按需渲染更早的。
- **滚动条按完整对话长度显示**（视觉上是全量那么长），实际「看多少渲染多少」，绝不一次性全量渲染。
- 上滚浏览历史时**不被「新消息自动滚到底」打断**（仅当用户已在底部附近、或新消息是自己刚发的，才自动置底）。
- （可选、非必须）后端分页读：仅当超大对话「首次全量载入内存」也成负担时再做；当前 store 全量持有可接受，**不属本规范强制项**，更不属"底座级改造"。

## 7. 与现有实现的已知冲突（待 §核对 workflow 补全）

- ❌ M4-6 `applyManualCompact`：`state.messages = [摘要, ...最近几条]` **删了 store 消息** → 违背原则 1/2，必须返工删除，`/compact` 改为直接复用自动压缩的 `compactNow`（不截断 store、无 isManualEntry 分支）。
- ❓ 当前 record 水位是纯 **step**，**无"轮"概念** → 需补轮边界对齐（§1）。
- ❓ 增量生成是否有 δ 前后文参考、回溯/分支/重试是否符合 §3/4/5、懒加载是否实现 → 待核对。

> 之前误判的"连续 /compact 水位错位 bug"：根源即 `applyManualCompact` 截断 store。一旦 `/compact` 回归单一压缩（不截断），store 恒完整、绝对水位线始终成立，该问题自然消失——修正方向是**返工归一**，而非补水位 bug。

## 8. background-pre-compact（后台预压缩）机制

> 2026-06-17 用户展开后固化。定位：**几乎不再阻塞压缩**——在 BPC 是「在归一后的 `compactNow` 之上加一层【调度 / 快照 / 延迟替换】壳」。`compactNow` 的生成 + 落库逻辑几乎不改，改的是**何时触发、对谁拍快照、生成完何时无缝替换、5 个边界如何兜底、进度如何可见可中止**。

### 8.1 用户 6 点设计（权威）

1. **触发与快照**：约 ~70% 阈值（BPC 阈值默认 0.68，settings 可调、本对话可覆盖）时，对「**请求体 + 对话文件**」做**瞬间快照**（值拷贝冻结），随即在**后台**跑 `compact`（复用归一后的 `compactNow`）。后台跑期间，请求体 / 本地对话**照常发展**，互不影响。
2. **1+δ 延迟无缝替换**：BPC 生成完成后**不立即替换**，等 `1+δ` steps（δ 默认让总距离 = 3，即 δ=2、`1+δ=3`；可设任意正整数）后，在某个 step **结束时**做**无阻塞替换**——替换请求体前缀 + record，不卡当前 step。
3. **可见可中止**（补 CC 式压缩环）：**不再显示限额**，限额区改显 BPC / 硬压缩进度；可设本对话的压缩阈值 / BPC 阈值；用户手动中止后 **x 分钟（默认 3，可设）默认冷却**，冷却期不再触发 BPC。
4. **风险提醒**：BPC 阈值默认 65-70% 可调；若「压缩阈值 − BPC 阈值 < 20%」或「BPC 阈值 < 40%」→ 风险提醒（纯 UI 校验，不阻止保存）。
5. **极端兜底**：靠 record 分层（§2.5）防膨胀；若仍出现**连续两次无缝 BPC 循环**→ 弹窗停 BPC + 需手动重启。
6. **分隔线**：压缩分割线自主设计（参考 Codex 美观风格）；BPC 替换处插「BPC 自动压缩」分隔线。

### 8.2 整合设计

**① 新建调度器 `services/bpcScheduler.ts`（核心，不进 `AgentLoop.run()` 主循环）**
- **监听水位**：每个 step 结束（while 循环每轮末、工具轮末）回调 `evaluateWater()`，用与 `run()` 同口径的 `assembledTokens` 算 `ratio`。
- **状态机**：`idle → snapshotting → generating → ready(待替换) → replacing → idle`；另有 `aborted / cooldown / circuit-broken`。
- **快照结构 `BpcSnapshot`**：`{ conversationId, snapshotStepCursor(触发时 step 游标), compressedSegment(深拷贝、触发瞬间被压段), recordPriorSteps, recordPriorRounds, targetReplaceStep(=snapshotStepCursor+1+δ), createdAt }`。快照是「瞬间冻结」，后续请求体/store 照常发展（`compressedSegment` 是值拷贝）。
- **后台执行**：调 `compactNow` 的**纯生成变体** `generateAndAppend`（见②）拿 `recordMd` + 新批落库，进 `ready` 态。复用 `recordGenerator` 的可中止链路（`Promise.race(collect/timeout/abort)`），给 BPC 建**独立 AbortController 集合**。

**② `compactNow` 拆分**
拆成两层：`generateAndAppend`（纯生成 record 批 + `appendBatch` 落库 + 同步 autosave，返回 `recordMd` 与批次水位，**无 `store.messages` 副作用**）与现有的注入组装。BPC 走 `generateAndAppend`，主循环自动压缩兜底也走它。归一（M5-1）删掉 `isManualEntry` 后，`batchSlice` 永远是 `coveredEligible.slice(priorSteps)` 单一口径，BPC 快照天然吻合。

**③ 触发与阈值**（`ratio = triggerTokens / modelContextWindow`，绝对百分比口径）
- `ratio ≥ bpcThreshold`（默认 0.68，settings 可调 + 本对话可覆盖）且 scheduler 空闲、不在 cooldown、circuit 未断 → 启动 BPC（拍快照 + 后台生成）。
- `run()` 原 `compressContext` 的 `wasCompressed`（0.9 硬阈值）保留为**硬阻塞兜底**，但加前置判断：若 BPC 已 `ready` 且未撞硬阈值，`run()` 进入前先做无缝替换、**跳过阻塞压缩**。

**④ 1+δ 延迟无缝替换**
BPC `ready` 后等 step 游标到达 `targetReplaceStep`，由调度器在主循环 step 收尾钩子里执行 replace：把 `run()` 下一轮组装用的 `apiHistory` 前缀换成 BPC 版 `recordMd`（record 已含 BPC 新批，store 原文保留最近若干轮不动）。替换「短暂延迟、无阻塞」——只换发送视图前缀，不卡当前 step。成功后插一条「BPC 自动压缩」分隔线（复用 `batchDividerByIdx`，标记该批 `source='bpc'`）。

**⑤ 五个边界落地**

| 边界 | 场景 | 兜底 |
|---|---|---|
| 1 | 超大输入一瞬挤爆阈值甚至窗口 | `evaluateWater` 若单 step 直接把 ratio 推过 0.9（甚至超窗）→ 不等 BPC，`run()` 当场走现有硬阻塞 `compressContext / truncateOverLongHistory`（复用 `overLimitWithoutCompression` 路径 `:629`） |
| 2 | BPC 未真替换前撞压缩阈值 | `run()` 进入时 `if(ratio≥0.9 && scheduler.state!=='replaced')` → `scheduler.discardCurrent()`（abort 在途 BPC + 丢快照），转硬阻塞。判据 =「只要没真替换就扔掉这轮 BPC」 |
| 3 | 用户可见可中止 | footer token-counter 改造为 `CompressionRing`（idle 显常规 token%；generating 显环形进度 + 「后台压缩中」+ 中止 ×；hard-compact 显阻塞态）。中止调 `scheduler.abort()` → 进 cooldown（默认 3min）。本对话阈值：conversation slice 加 `bpcThresholdOverride / compactThresholdOverride`（随对话持久化），命令或设置面板可设 |
| 4 | 阈值风险 | settings 改 `bpcThreshold / compactThreshold` 时，`(compactThreshold − bpcThreshold) < 0.2` 或 `bpcThreshold < 0.4` → 黄色风险提醒（纯 UI 校验，不阻止保存） |
| 5 | 无限循环熔断 | scheduler 记 `lastReplaceStepCursor`；若「替换完成 → 紧接着 `evaluateWater` 立即又 ≥ bpcThreshold」连续发生 2 次（两次间 step 推进极少）→ 弹窗「BPC 循环已停止」+ 置 `circuit-broken` 停 BPC，除非用户 `scheduler.restart()`。与 §2.5 record 分层互补 |

**⑥ 分隔线设计**
参考 Codex 风格做更美观的 `CompactDivider` 组件（替代现 `:1998` 内联 div），区分 `source`（手动 / 自动阻塞 / BPC）。BPC 版用专属图标 + 「BPC 自动压缩 · 已压 N 轮」+ 渐变细线。给 `RecordBatch` 加可选 `source` 字段（`'auto' | 'manual' | 'bpc'`）落库以区分。

**⑦ 与 M5-1 归一的衔接（强依赖）**
BPC 必须建立在 M5-1（删 `applyManualCompact / isManualEntry` → 单一 `compactNow`）+ M5-2（轮次 / step 游标地基）之上：BPC 的「快照 step 游标」「1+δ 延迟」「替换时机」全部依赖 M5-2 的显式 step/round 计数；`compactNow` 的单一 `batchSlice` 口径让 BPC 快照与自动兜底共用一套切片逻辑。故 BPC 排在 M5-1/M5-2 完成之后。

### 8.3 设置项与默认（已拍板）

| 配置（`agentSettings`，本对话可由 conversation slice override） | 默认 | 含义 |
|---|---|---|
| `bpcThreshold` | 0.68 | BPC 触发水位（占全窗口） |
| `compactThreshold` | 0.9 | 硬阻塞压缩水位（把 `systemPrompt` 硬编码 `COMPRESSION_THRESHOLD` 迁过来） |
| `bpcDeltaSteps` (δ) | 2 | `1+δ=3` 总距离；可设任意正整数 |
| `bpcAbortCooldownMin` | 3 | 手动中止后冷却分钟数 |

本对话覆盖字段（conversation slice，随 autosave + DB 持久化）：`bpcThresholdOverride / compactThresholdOverride`。

### 8.4 待用户最终拍板点（来自研究 openQuestions）

- **δ 与替换时机精确语义**：`1+δ` 从 BPC【触发拍快照】算起（`targetReplaceStep = snapshotStepCursor + 1 + δ`），还是从【生成完成】算起？倾向「从触发算起，若生成耗时超过 δ 步则生成完即在下一个 step 边界替换（取 max）」。step 计数是否含 tool step？
- **BPC 替换是否必须严格等到 `targetReplaceStep`**：若用户在 ready 但未到 target 时手动发消息触发新 `run()`，这一轮用旧前缀还是已就绪的 BPC 前缀？倾向「ready 即可在下一个 run 用，δ 是不强制等待的上限」，但用户原话强调「等 1+δ steps 某 step 结束才替换」——需确认。
- **熔断「连续两次无缝循环」的精确 step 间距阈值**：替换后下一次 `evaluateWater` 立即（同 step 或仅 +1 step 内）又 ≥ bpcThreshold，连续 2 次——间距阈值需确认。
- **scheduler 状态承载**：新建不持久化的 `bpc` Redux slice（三处订阅一致性好）vs 轻量 EventEmitter。倾向不持久化 slice。

## 9. UI 细节点

> 2026-06-17 归纳。本节汇总 Plan_5 全部新增/改造 UI 落点，具体组件设计见对应章节（§8 BPC、§10 task_boundary、§11 show_artifact）。

### 9.1 压缩环 CompressionRing（借 footer 额度位）

- **落点**：`AgentPanel.tsx:2259-2269` 的 `agent-input-footer` token-counter（`Token: {tokenCount}/{effectiveContextWindow} ({ratio}%)`）是主入口；同步 `StatusBar.tsx:73-83` 与 context tab（`AgentPanel.tsx:2090-2096`）两处。
- **行为**：idle 显常规 token%（保留现有 >0.8 红 / >0.5 黄分级）；BPC `generating` 显环形进度 + 「后台压缩中」+ 中止按钮 ×；硬压缩显阻塞态「压缩中」。**不再单独显示限额**，限额区改显 BPC / 硬压进度。
- 中止 → `scheduler.abort()` → 进 cooldown。状态来源订阅 scheduler（倾向不持久化 `bpc` slice）。

### 9.2 压缩分隔线 CompactDivider（按 source 区分）

- 现状：`batchDividerByIdx`（`AgentPanel.tsx:257`，record 各批 stepEnd → messages 下标）渲染成虚线文本「⌁ record 批次 #N 边界 ⌁」（`:1998-2004`）。
- 改造：新建 `CompactDivider` 组件（参考 Codex 美观风格），按 `RecordBatch.source` 区分**手动 / 自动阻塞 / BPC** 三态，BPC 版专属图标 + 「BPC 自动压缩 · 已压 N 轮」+ 渐变细线。复用现有 `batchDividerByIdx` 映射。

### 9.3 task_boundary 卡片 + 历史（详见 §10）

- 顶部大标题条（`taskHeadline.title` + 当前 active 边界概述）；对话流 Task 面板/Rail 渲染边界卡片（仿 `WorkflowCard`，状态色 + 展开 steps + active 按秒滴答）；卡片「历史」入口 → 回看视图（中间编辑器 tab 或 portal 浮层）。仅 Plan 模式呈现。

### 9.4 show_artifact 文件卡片（详见 §11）

- AI 推送的文件卡片渲染在对话流（仿 `file-change-chip`，`fileIcons` 彩色图标 + 文件名 + Open 按钮）；点 Open → 走标准 `openTab` 在中部编辑器打开（与 Sidebar 点文件等价）。

## 10. task_boundary（Plan 模式任务边界 UI）

> 2026-06-17 用户展开后固化。定位：**仅 Plan 模式**（fast 不给，设置可调、默认开）的前端 UI（仿 Antigravity）。工作按 task_boundary 卡片分；AI 推进时自生成小标题；顶部大标题 + 当前概述每次推进同步更新；卡片可展开；新增**历史回看 UI**（Antigravity 没有）；存 task_boundary 结构。

### 10.1 数据结构（对话级、持久化，仿 `goal` 范式）

`conversation.ts` 顶层加 `taskBoundaries?: TaskBoundary[]`（与 messages 并列、随对话存）：

```ts
TaskBoundary {
  id; title;              // AI 生成的小标题（如「查看现有 rules 文件」）
  status: 'active' | 'done' | 'aborted';
  startedAt; endedAt?;
  anchorMessageId?;       // 边界开始时锚定的 assistant 消息 id（回溯/定位用）
  startRound?; endRound?; // ★ 对齐 M5-2 轮次地基：边界按轮次记录跨度，与 record 批次/回溯同口径
  steps: TaskBoundaryStep[];
}
TaskBoundaryStep { id; text; timestamp; }
```

另存对话级「大标题 + 当前概述」：`taskHeadline?: { title; summary; updatedAt }`（顶部大标题 + 当前边界概述）。

**设计取舍**：用「数组 + 顺序」而非树（匹配 Antigravity 线性边界流）；steps **内联进 boundary、不另开消息**，避免污染 messages 与 §1/§2 压缩 / 轮次口径（task_boundary **不进请求体、不影响压缩**）。

### 10.2 AI 声明 / 推进（工具方式，优于解析输出）

新增 3 个工具（`toolRegistry.register`，category `learning`，approvalLevel `auto` 免审批）：
- `set_task_headline({ title, summary })` — 设 / 更新顶部大标题与当前概述。
- `begin_task_boundary({ title })` — 开新边界（前一个 active 自动收为 done），返回 `boundaryId`。
- `update_task_progress({ text })` — 给当前 active 边界追加一条 step。
- （可选 `end_task_boundary` — 显式收口；或由 begin 下一个隐式收口 + loop 自然结束时收口。倾向后者，省 AI 心智。）

handler 内 `await import('@/store')` dispatch 新 reducer（`beginTaskBoundary / appendTaskStep / setTaskHeadline / endTaskBoundary`）。
**选工具而非解析协议的理由**：① 与 `record_read / spawn_subagent` 一致、零新机制；② 工具天然只在 `mode==='planning'` 给出（见 §10.4），满足「fast 不给」；③ 结构化、不怕模型自由文本格式漂移。
**Prompt 侧**：`systemPrompt.ts:115` planning `<guidelines>` 追加引导句「用 `begin_task_boundary / update_task_progress` 声明并推进任务边界，每推进到新子任务就开新边界并更新概述」。

### 10.3 卡片 UI + 展开 + 历史

- **顶部大标题条**：AgentPanel 对话流顶部渲染 `taskHeadline.title` + 当前 active 边界概述。订阅 `conversation.taskBoundaries / taskHeadline`。
- **边界卡片**（仿 `WorkflowCard.tsx` 新建 `TaskBoundaryCard.tsx`）：一个 boundary 一张卡，左边框状态色（active 蓝 / done 灰 / aborted 红）、标题、状态、step 计数；展开按钮展开 steps 列表（仿 `SubagentRow`）；active 按秒滴答耗时（复用 `setInterval` 范式）。
- **渲染位置**：task_boundary 跨多轮、**不挂单条消息**。首版建议「对话顶部一个可折叠 Task 面板，集中列全部 boundary 卡片」（最像 Antigravity 侧栏）；备选「按 anchorMessageId 穿插」交互更复杂。
- **历史 UI（Antigravity 没有，新增）**：卡片「历史」入口 → 回看视图，列出本对话所有 boundary（含 done）的标题 / 概述 / steps 时间线。复用 `openWorkflowTab` 范式新增 `openTaskHistoryTab`（中间编辑器区开 tab）或 portal 浮层。因已持久化，重启后仍可读。

### 10.4 Plan 模式 gating + 设置开关

- **gating 锚点**：`mode==='planning'`（`agentLoop.ts:484` 已读 currentMode）。三个工具仅在 planning 注入工具集——在 AgentLoop wireTools（`AgentPanel.tsx:367`）或 getActiveTools 处按 mode 过滤（仿 fast 模式 `:834` 不传 tools）。
- **设置开关（默认开）**：`agentSettings.ts` 加 `taskBoundaryEnabled: boolean`（initialState `true`）+ setter，SettingsPanel 加开关。**双闸**：`mode==='planning' && taskBoundaryEnabled`。关掉时不注入工具、不渲染卡片。

### 10.5 存储落地（`goal` 三件套范本）

- **DB**：`database.ts` ensureColumn `conversations task_boundaries_json TEXT` + `task_headline_json TEXT`（懒迁移，仿 `:180` goal）。
- **IPC**：`electron/ipc/conversation.ts` 读写映射 + hasColumn 缺列降级。
- **persistence**：`conversationPersistence.ts` snapshot 加字段 + autosave/save/读回回填 + 分支继承策略。
- **store**：`setConversation` 回填、`clearConversation` 清空（仿 goal `:355 / :625`）。

### 10.6 与 M5 返工的协同

- `startRound/endRound` 直接消费 M5-2 的「轮次」概念，与 record 批次边界、回溯锚点同口径——回溯到第 N 轮时，同步把 `startRound>N` 的 boundary 移除、跨越 N 的收口（在 truncateAt/回溯 reducer 联动）。故回溯联动排在 M5-2 之后。
- steps 内联在 boundary、不进 messages，**不影响压缩 step 口径与请求体组装**，与压缩归一互不干扰。

### 10.7 待用户最终拍板点（来自研究 openQuestions）

- 卡片渲染位置：A（顶部可折叠 Task 面板，最简、最像 Antigravity）vs B（按 anchorMessageId 穿插，更贴「推到哪显示在哪」但与压缩/虚拟滚动更复杂）。倾向 A 首版。
- 历史 UI 形态：中间编辑器 tab（空间大、可常驻）vs portal 浮层（轻量、即开即关）。
- 收口时机：是否需 AI 显式 `end_task_boundary`，还是 begin 下一个 + loop 结束自动收。倾向后者。
- 是否把每轮 run/消息关联进对应 boundary。倾向首版只存 AI 主动写的轻量结构。
- 分支时 taskBoundaries 是否复制（分支点之后砍、跨越收口）。
- steps 是否需 token / 条数上限防持久化膨胀。

## 11. show_artifact（文件卡片推送）

> 2026-06-17 用户展开后固化。定位：AI 把指定文件当**小卡片**推给用户，点 Open 在**中部编辑器区**打开（像打开文件）。本质是「diff chip 的孪生体」——diff chip 是 AI 改了文件后自动推 + 点开看改动；artifact 卡片是 AI **主动推一个文件**让用户点开看。复用度极高。

### 11.1 触发方式（工具 `show_artifact`，非解析输出）

工具定义（`toolRegistry.register`）：
- `name: show_artifact`，`approvalLevel: 'auto'`（只读推卡片，无副作用），`permissionCategory: 'read'`（子代理工具闸门也放行）。
- 参数：`path`（必填，工作区相对/绝对路径）、`label`（可选，缺省取文件名）。
- handler：**不读文件正文**（懒，正文等用户点开 viewer 时按需读），仅校验路径存在 + `resolveEditorType(path)` 预解析 viewer 类型，把 `{ path, fileName, viewerType, label }` 登记进「artifact 桶」（新增 `services/artifactTracker.ts`，仿 `fileChangeTracker` 的 contextId 分桶）。返回确认串「已向用户推送文件卡片：xxx」。
- **理由**（选工具不选解析协议）：与既有工具体系一致，MCP / 审批 / 重试链路免费复用；解析输出标记要在流式 content 里扫协议串，破坏 prompt cache 口径且与 ReactMarkdown 渲染冲突，更脆。

### 11.2 agentLoop 消费（与 `consumeTrackedFileChanges` 并列）

`agentLoop.ts:1075` 附近，工具执行后除 `consumeTrackedFileChanges` 外，再 `consumeTrackedArtifacts(execContextId)`，逐条 `dispatch(addMessageArtifact({ messageId: assistantMessageId, artifact }))`，注入当前 assistant 消息（仿现有 `consumeTrackedFileChanges → addMessageDiff` 链）。

### 11.3 数据模型

- `conversation.ts` 新增 `MessageArtifact { id; path; fileName; viewerType: EditorFileType; label?; createdAt }`；`Message` 加 `artifacts?: MessageArtifact[]`；新增 `addMessageArtifact` reducer（仿 `addMessageDiff`）。
- **持久化零改动即随对话保存**（`sanitizeMessagesForPersistence` 白名单剔除式，新增字段自动落库）；恢复后卡片在、点开仍走 `openTab`。

### 11.4 卡片 UI（仿 `file-change-chip`）

`MessageBubble.tsx` 新增 `artifacts` 渲染块（仿 `message-file-changes` `529-554`）：每个 artifact 渲染 chip「[文件图标] 文件名 [Open]」，点击 → `onOpenArtifact(artifact)`。图标用 `fileIcons.getFileIcon(ext)`（彩色 SVG，和 FileTree 视觉统一，`dangerouslySetInnerHTML` 注入）。

### 11.5 点 Open → openTab

`AgentPanel.tsx` 新增 `handleOpenArtifact(artifact)`（仿 `openDiffTarget` `:1465`）：`dispatch(openTab({ filePath: artifact.path, fileName, isPreview: true, type: artifact.viewerType }))`。openTab 按 `filePath` 去重，重复推同文件点开复用已开 tab。经 MessageBubble props 下传（仿 `onOpenDiff`）。

### 11.6 与 attachment tab（M4-3）的区分（设计红线）

- **attachment tab**（`type:'attachment'`）：打开**已发消息附件**（无工作区路径，靠 sha256 / objectUrl + `AttachmentTabViewer`）。
- **show_artifact**：打开**工作区真实文件**（有路径），走**标准文件 viewer 路径**（`resolveEditorType → PdfViewer/CodeEditor/OfficeViewer...`），与 Sidebar 点文件、QuickOpen 完全同一条路。
- **二者不混用**：artifact 一律走标准文件 type，**绝不**走 attachment type（attachment viewer 吃不下工作区路径，会黑屏/读不到）。

### 11.7 与压缩归一的契约

artifact 卡片是 UI 层 message 字段，纯展示 + 点开，**不进请求体、不参与 record 摘要、不影响 token 判定**（与 diffs/toolCalls 同性质，都不进 `chatContentToText`）。归一后单一压缩/轮次对它无侵入；回溯/分支/重试按 store 全量 messages 走时，artifacts 随消息一起裁剪/复制（`branchConversation` 是否带上 artifacts 见待确认点）。

### 11.8 待用户最终拍板点（来自研究 openQuestions）

- 卡片图标：`fileIcons.getFileIcon`（彩色、像文件卡片）vs lucide（与现有卡片单色一致）。
- artifacts 是否随对话持久化（默认会）：持久化 + 点开时做文件存在性降级提示（仿附件 `:1780` 无法打开通知）。
- branch 时是否把 artifacts 复制进新对话（更像「该轮产物」应保留 vs 现有白名单剔 diffs）。
- 是否给用户侧入口（选中文件「推到对话」），还是 v1 只做 AI 工具侧。
- 一次推一个还是支持数组多文件；是否支持深链（PDF 第 N 页 / 代码第 N 行），还是 v1 只「打开文件」。
- Web 模式能否打开工作区文件卡片（viewer 依赖 fileSystem 路径），还是 v1 限 Electron。

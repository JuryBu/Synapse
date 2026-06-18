# Plan_5 梯队三实现蓝图（M5-RL + M5-BPC）

> 来源：tier3-design workflow（2 子代理深读规范+代码产出）。决策已拍板：尾 T=1 保留全文 / 验证沿用历史模式（双编译+fixture+自检）。

## M5-RL（record 多级分层，防 BPC 无限循环）

**keyFindings**：

读完规范 §2.5/§2 与全部相关源码，给出 M5-RL 6 个 stage（R-L1~R-L6）的落地蓝图。核心事实与口径如下：

【现状精确定位】
- 注入侧唯一渲染入口 = `buildStableRecordPrefix(record)`（agentLoop.ts:342-353），现为两档：批序位 `i < STABLE_HEAD_FULL(=2)` 走 `b.contentMd` 全文，其余一律 `renderSkeletonBatch(b)`（:315-319，输出 `[批次N 骨架，可用 record_read(batchIndex=N) 展开全文]\n + b.skeleton`）。零批回退 `record.contentMd`，单批回退 `batches[0].contentMd`。
- 该函数被 3 处调用：run() 未压缩但有 record 分支(:663)、compactNow 兜底前缀(:1257)、compactNow 落库后(:1311)。三处都只接收 `SynapseRecord`，不传 contextWindow（这是 M4-5-S2 为 prompt-cache 稳定主动去掉动态预算的结果）。
- 骨架来源 `extractSkeleton(contentMd)`（recordStore.ts:124-145）：正则提首个 `# 一级标题` + 每个 `## 二级标题` + 该节首行 1 条要点（缩进 2 空格）。批生成时 `appendBatch` 固化进 `RecordBatch.skeleton`(:417)，渲染只读不重算。
- RecordBatch 结构（recordStore.ts:33-54）：index/roundStart/roundEnd/stepStart/stepEnd/contentMd/skeleton/phases/timeSpan/createdAt。`normalizeBatch`(:177-194) 负责读回规范化；`buildRecord`(:197-215) 派生 totalRounds/totalSteps/lastUpdatedRound（全取末批）。
- record_read 工具(toolRegistry.ts:620-655) 经 `getBatch(convId, batchIndex)`(recordStore.ts:464-479) 按 `b.index` 精确取回该批 contentMd。UI 分隔线 `batchDividerByIdx`(AgentPanel.tsx:264-284) 依赖每批 `stepEnd`。
- 模型窗口口径：`getModelContextWindow(rootState)`(agentLoop.ts:553)；硬阈值 `COMPRESSION_THRESHOLD=0.9`(systemPrompt.ts:58)；硬闸要插在 :620-669 组装 apiHistory 之后、:673 拼 system prompt 之前。

【设计落地的关键结论】
1. 三级分层（设计A，R-L2）必须维持「只依赖批位置与总批数 N、绝不引 contextWindow/实时 token」——这是 cache 不破的前提。分档纯位置规则：序位 < H 头全文；序位 >= N-T 尾全文；中间骨架；中间里序位 < N-T-K(=titleOnly 段长) 的最老段降 titleOnly。
2. 折叠（设计B，R-L4）的本质契约（§0.2/§2.5.2②已拍板）：原始批永久留库不删，`getRecord`/`getBatch`/`record_read`/UI 分隔线全部照常工作；折叠只改 `buildStableRecordPrefix` 产出的「注入视图」。最稳妥实现 = 给 RecordBatch 加 `archived?: boolean` 标记 + 库里新增 1 个「元批」（合成的超级骨架批，自身也是一条 RecordBatch 落库，但带 `meta` 标识与 `foldedRange`），`buildStableRecordPrefix` 渲染时跳过 archived 原始批、改渲染元批。注意不能让元批污染水位派生（buildRecord 取末批，元批必须放数组头部或不参与 totalSteps/totalRounds 派生）。
3. token 硬闸（设计C，R-L5）必须独立于 cache、只兜底——放在 apiHistory 组装后，估算 record 前缀 token 超 `window×RECORD_MAX_RATIO(0.4)` 时从中段逐批临时降 titleOnly 至达标。这条会让前缀随窗口漂移，故只在危险态触发、绝不进正常路径。
4. 所有新常量（H/T/M/RECORD_MAX_RATIO + titleOnly 段长）按 §8.3 强约束必须进 SettingsPanel 可调（写死只能作默认值）。agentSettings 当前完全没有压缩相关字段，M5-BPC-1 会建压缩配置底座——R-L2 应把分层常量挂进同一处（建议 agentSettings 加 `recordLayering` 子对象），SettingsPanel UI 落在 M5-BPC-7 的「压缩设置区」。

【重要约束/风险】
- 项目无测试运行器（package.json 无 vitest/jest），R-L1「单测覆盖」/R-L3「fixture 断言」无现成 runner。验证约定 = `npm run build` + `npm run electron:build` 双编译 + 手动自检（沿用全部历史 stage 模式）。这是需主工程师拍板的真实落差。
- 折叠改变批集合 → 该次 compaction 一次性 cache miss（规范已接受为「阶梯式稳定」）。元批一旦合成后，后续渲染又稳定。

### R-L1 extractSkeletonTitle 纯本地标题级提取（量纲≈骨架1/3）
- **files**: C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/recordStore.ts
- **changes**: 在 extractSkeleton（recordStore.ts:124-145）正下方新增并 export `extractSkeletonTitle(contentMd: string): string`。规则：复用 extractSkeleton 的正则骨架，但【只保留标题行、丢弃每节首行要点】——即保留首个 `^#\s+` 一级标题 + 所有 `^##\s+` 二级标题行，不做 extractSkeleton 中 :137-141 的「找该节首行非空要点」内层循环。空输入/无标题返回 ''；单标题/多标题正常逐行 trim 后 join('\n')。纯正则、零 LLM、与 extractSkeleton 并列。注意：不要改 extractSkeleton 本身（它仍是骨架生成口径，被 appendBatch:417 与 normalizeBatch:181 依赖）；titleOnly 是【渲染时按需再降级】，不固化进 RecordBatch（避免改批结构与 cache 口径）。','补充：因为 titleOnly 是从 contentMd 实时正则提，渲染侧需能拿到 contentMd——RecordBatch 本就持有 contentMd，renderSkeletonBatch 可直接对 batch.contentMd 跑 extractSkeletonTitle，无需新增字段。
- **risks**: ① 若误改 extractSkeleton 输出会同时破坏已落库批的 skeleton 口径与 cache 稳定性——必须新增函数、不动旧函数。② extractSkeletonTitle 对 contentMd 实时计算，而 extractSkeleton 的结果是落库的 skeleton；二者来源不同（一个实时算 contentMd、一个读固化 skeleton），需确认 titleOnly 渲染时用 batch.contentMd 而非 batch.skeleton（skeleton 已丢了 contentMd 的标题结构层级信息，从 skeleton 再提 titleOnly 会偏）。
- **deps**: 无（纯新增工具函数，可最先做）；被 R-L2/R-L5 消费。

### R-L2 buildStableRecordPrefix 扩成确定性三级（头H全文+尾T全文+中间骨架，最老段降titleOnly）
- **files**: C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/agentLoop.ts, C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/store/slices/agentSettings.ts
- **changes**: ① agentLoop.ts:306 旁新增常量 `STABLE_TAIL_FULL=1`、`SKELETON_TITLE_THRESHOLD=20`（中间批超此数则最老段降 titleOnly），保留 STABLE_HEAD_FULL=2。② renderSkeletonBatch（:315-319）加 titleOnly 变体：新增可选参 `titleOnly=false`，true 时 skeleton 源改 `extractSkeletonTitle(batch.contentMd)`、header 文案保留 `record_read(batchIndex=N) 展开全文`（保证模型仍知可展开）。③ 重写 buildStableRecordPrefix（:342-353）为三级：N=batches.length；零批/单批回退口径不变；档1：序位 i<H 全文；档2：序位 i>=N-T 全文；档3：中间批骨架，其中【中间批数 N-H-T > M】时，把中间偏老一段（序位区间 [H, N-T-K)，K 为非 titleOnly 中间批数，按位置纯规则定）降 titleOnly。所有分档边界只依赖 i 与 N，绝不读 contextWindow/token。④ 分层常量挂进可调配置：在 agentSettings.ts 加 `recordLayering: { headFull:2, tailFull:1, titleThreshold:20, maxRatio:0.4 }`（与 M5-BPC-1 压缩配置同处）+ setter；buildStableRecordPrefix 改为可接收一个 layering 配置参（或在 3 个调用点从 store.getState().agentSettings.recordLayering 读后传入），默认值兜底。注意：读 store 配置不破坏确定性（配置不变→渲染不变；配置改动等价于一次性 cache miss，可接受，与折叠同性质）。
- **risks**: ① 头尾全文区间可能重叠（N 很小时 H+T>=N）：必须先判 N<=H+T 时全部走全文、不进骨架分支，否则同一批被算两次或漏算。② titleOnly 段必须连续且确定（按位置切片），脏数据不影响（renderSkeletonBatch 对每批独立渲染）。③ §六待拍板：尾T全文是否必要（与 compressContext keepCount 保留的最近原文语义部分重叠）——若主工程师选「只头全文+中段降级」，T 设 0 即可，结构不变。④ 把 layering 配置喂进 buildStableRecordPrefix 会让它不再是纯函数；需确保 compactNow 与 run() 三处都用同一份配置快照，避免同轮内两次渲染配置漂移。
- **deps**: 依赖 R-L1（extractSkeletonTitle）；与 M5-BPC-1（压缩配置底座）协同——建议 recordLayering 字段在此 stage 顺手加进 agentSettings，UI 可留到 M5-BPC-7 一起做。

### R-L3 设计A验证：确定性逐字一致 + 60批前缀显著下降 + titleOnly批 record_read 仍可取回全文
- **files**: C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/agentLoop.ts, C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/recordStore.ts
- **changes**: 因项目无测试 runner（见 openQuestions），落地为「可执行 fixture 自检脚本 + 双编译」而非单测框架。① 写一个临时 node/ts 脚本（或 sandbox_exec）构造几十批 fixture record，断言三点：(a) 同一 record 连调 buildStableRecordPrefix 两次输出 `===` 逐字一致（cache 稳定不回退）；(b) N=60 时前缀 token（estimateTokens）较改造前两档版显著下降（规范预估 ~25k→~12k 量级）；(c) 被降 titleOnly 的批，getBatch(convId, batchIndex) 仍能取回完整 contentMd（验证折叠/降级只影响注入视图、不影响 record_read 取回链路）。② 验证「配置不变→输出不变」「批集合不变→输出不变」。③ `npm run build` + `npm run electron:build` 双编译通过。脚本验证完可删（不入库），结论写进自检记录。
- **risks**: ① 无 runner 时 fixture 脚本对 store/platform 有依赖——buildStableRecordPrefix 若改成读 store 配置，纯函数性被破坏，验证脚本需 mock store 或显式传配置参（这反过来支持 R-L2 把 layering 作为显式入参而非内部读 store）。② token 下降幅度受 fixture 内容影响，断言用「相对下降 >X%」而非绝对值。
- **deps**: 依赖 R-L2 完成；为 R-L4/R-L5 提供回归基线。

### R-L4 设计B折叠：RecordBatch 加 archived/元批，foldOldBatches 把最老K批折叠成1元批（原文留库）
- **files**: C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/recordStore.ts, C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/agentLoop.ts
- **changes**: ① recordStore.ts RecordBatch（:33-54）加可选字段：`archived?: boolean`（被折叠的原始批，留库但不进注入视图）、`meta?: boolean`（标识这是合成元批）、`foldedFrom?: number[]`（元批覆盖的原始批 index 列表，UI/调试用）。normalizeBatch（:177-194）补这三字段的读回（archived/meta 默认 false、foldedFrom 默认 []）。② 新增并 export `foldOldBatches(conversationId, opts?)`：读 record→若非 archived 的可见批数超阈值，取最老 K 个非元批，合成 1 个元批（contentMd = 这 K 批 skeleton 的正则合并/再摘要——纯本地拼 skeleton 即可，不调 LLM；roundStart/roundEnd 取 K 批的轮跨度并集，按轮边界取整复用 RecordBatch.roundStart/End；stepStart/stepEnd 取并集），把这 K 个原始批标 `archived=true`、把元批插入（建议放数组头、index 用负数或独立命名空间避免与连续 index 冲突，或末批 index+1 但 buildRecord 派生水位时排除 meta），整体 upsertRecord 落库。③ buildStableRecordPrefix（R-L2 版）渲染时：先过滤掉 `archived` 原始批、保留 meta 元批参与三级分层（元批当作一个超级老批，走档1全文或骨架按位置）。getRecord/getBatch/record_read/UI 分隔线【不过滤 archived】——它们读全量 batches，满足 §0.2「原文留库可展开/UI 完整可见」。④ buildRecord（:197-215）派生 totalRounds/totalSteps/lastUpdatedRound 时必须【排除 meta 元批】（元批是注入视图产物，不能污染增量水位——否则下次 appendBatch 的 priorSteps/幂等水位门错位）。⑤ compactNow 落库后（agentLoop.ts:1308 appendBatch 成功分支内）接入触发：appendBatch 成功后判可见批数超阈值则 await foldOldBatches，再用折叠后 record 重算 recordMd(:1311)。','⑥ 触发阈值用可调配置（recordLayering 加 foldThreshold/foldBatchK）。
- **risks**: ① 元批 index 与水位派生是最大坑：buildRecord 取末批派生水位（:206-209）——若元批进数组尾或参与派生，会把 totalSteps/totalRounds 拍成元批的并集值、破坏 appendBatch:393 expectedStepStart=末批stepEnd 幂等门 → 静默丢批。必须让派生【只看非 meta 的真实末批】。② appendBatch 幂等门假设「末批 stepEnd 严格接续」——折叠后真实末批不变（折叠的是最老批），幂等门仍成立，但需确认元批不被当作末批。③ record_read 对 archived 批仍要能取回（getBatch 按 index 查，archived 批 index 不变、仍在 batches 里→天然可取，验证即可）。④ copyRecordFrom（分支继承，:616-651）会把 archived/meta 一起深拷贝——需确认分支后元批/archived 语义仍自洽（建议分支时保留折叠态，因 contentMd 都在）。⑤ clampToBatch（回溯裁剪，:525-562）findIndex 用 stepEnd/roundEnd——元批的 step/round 区间是并集，可能干扰 cutIdx 计算，需确认回溯时元批与其覆盖的 archived 批作为整体被裁或保留（不能裁出「元批在、原始批没了」或反之的撕裂态）。这是 effort=large 的主因。
- **deps**: 依赖 R-L2（三级渲染要能容纳元批）；强依赖 M5-1 归一（单一 batchSlice 口径）+ M5-2（轮边界，元批按轮取整）；被 R-L5/R-L6 与 M5-BPC 熔断边界5 依赖。

### R-L5 设计C token硬闸：组装apiHistory前估前缀token超 window×RECORD_MAX_RATIO 则从中段逐批降titleOnly至达标
- **files**: C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/agentLoop.ts
- **changes**: ① 新增纯函数（agentLoop.ts，buildStableRecordPrefix 附近）`enforceRecordTokenCap(record, baseRecordMd, maxTokens): string`：估算 baseRecordMd 的 token（estimateTokens）；若 <= maxTokens 直接返回 baseRecordMd（正常路径不触发）；否则从【中段骨架批起逐批改 titleOnly】重渲染（复用 R-L2 的三级逻辑但叠加一个「强制降级游标」：从最老中间批往新方向逐批切 titleOnly），每降一批重估 token，直到 <= maxTokens 或中段全 titleOnly 仍超（极端则连尾T也可降，最后兜底截断）。② 接入点：run() 三处生成 recordMd 后、组装进 apiHistory 前——精确位置 (a) :663-665 未压缩注入分支 recordMd 算出后、(b) compactNow 返回的 recordMd 在 run() :620-622 用前。最稳妥 = 在 run() :602-670 apiHistory 组装段，对最终要注入的 recordMd 统一过一道 enforceRecordTokenCap(record, recordMd, modelContextWindow × recordLayering.maxRatio)。③ maxRatio 读 recordLayering.maxRatio（默认 0.4，可调）。④ 文案/定位注释参照 truncateOverLongHistory（:227）与 overLimitWithoutCompression 危险态（:630-635），明确标「仅兜底防炸窗、正常路径不触发、会让前缀随窗口漂移故不进 cache 稳定路径」。
- **risks**: ① 这是唯一引入 contextWindow/token 的分层逻辑，会破坏 cache——必须确保正常路径（前缀未超 maxRatio）下 enforceRecordTokenCap 是 no-op、逐字返回 baseRecordMd，否则把 cache 稳定性也搭进去了。② estimateTokens 是粗估，maxRatio 留余量（0.4 已较保守）。③ 与 R-L4 折叠的关系：折叠是结构性根治（改批集合）、硬闸是渲染性兜底（不改批集合只换渲染）。规范 §2.5.2 明确「BPC 真正依赖的压完有上界 = 设计B+C」——二者都要做，硬闸保证「即便折叠没及时触发也不炸」。④ 硬闸触发后下一轮若前缀又稳定，渲染会变回 baseRecordMd → 阶梯式 cache 抖动，可接受（只在危险态）。
- **deps**: 依赖 R-L2（三级渲染复用）；与 R-L4 互补；为 M5-BPC 提供「压完必达标」结构性保证（BPC 边界5 熔断的前置）。

### R-L6 BPC衔接（可选）：预测压完record前缀token，超RECORD_MAX_RATIO则提前触发foldOldBatches
- **files**: C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/recordStore.ts, C:/Users/Stardust/Desktop/VC工具包/Synapse/synapse-app/src/services/bpcScheduler.ts
- **changes**: （标记可选、§4决策默认非阻塞；M5-BPC 完成后做）① 在 recordStore.ts 或 agentLoop.ts 新增纯预测函数 `predictRecordPrefixTokens(record, layering): number`：在不真折叠的前提下，按 buildStableRecordPrefix 三级规则算出「压完后（含本次将追加的新批）record 前缀的估算 token」。② 在 M5-BPC 的 bpcScheduler.ts（M5-BPC-3 新建）的预压缩侧：拍快照/生成前调 predictRecordPrefixTokens，若预测 > window×maxRatio，则在压缩流程内【提前】调 foldOldBatches（R-L4），而非等触达水位才被动折叠——把「压完仍高位→立即再触发」的无限循环在源头闭合。③ 与 M5-BPC-5 边界5（连续2次无缝循环熔断）互补：R-L6 是主动预防、熔断是被动兜底。
- **risks**: ① 强依赖 R-L2/R-L4/R-L5 与整个 M5-BPC 就位，排在最后。② 预测函数要与 buildStableRecordPrefix 渲染口径严格一致，否则预测与实际偏差→误折叠或漏折叠；建议预测直接复用 buildStableRecordPrefix 实际渲染后 estimateTokens（牺牲一点性能换口径一致），而非另写一套估算。③ 可选项，主工程师可在 M5-BPC 稳定后再评估是否需要——若 R-L4+R-L5 已让循环消失，R-L6 可不做。
- **deps**: 依赖 R-L2 + R-L4 + R-L5 + 整个 M5-BPC（尤其 M5-BPC-3 scheduler）；全 M5-RL/M5-BPC 最末，可选。

### openQuestions
- 【验证手段落差，需拍板】项目无测试 runner（package.json 无 vitest/jest，仅 build/electron:build/lint/dev）。R-L1「单测覆盖空/单/多标题」、R-L3「fixture 断言两次渲染逐字一致 + 60批前缀下降 + titleOnly 批 record_read 可取回」都没有现成框架。建议二选一：(a) 引入 vitest 作为本 stage 配套（一次性基建投入，惠及后续）；(b) 沿用项目既有约定——临时 fixture 自检脚本（sandbox_exec/node）+ 双编译 + 手动自检，脚本不入库。倾向 (b)（与全部历史 stage 一致，不扩面）。
- 【buildStableRecordPrefix 是否读 store 配置 vs 显式传参】R-L2 要把 H/T/M/maxRatio 做成可调，但该函数现是纯函数、被 3 处调用。读 store 会破坏纯函数性、给 R-L3 验证脚本添 mock 负担；显式传参更干净但要改 3 个调用点签名。倾向显式传参（调用点从 store 读 recordLayering 快照后传入，保证同轮一致）。需主工程师确认签名改法。
- 【尾 T 全文是否必要】§六明确待拍板：尾 T 批全文与 compressContext keepCount 保留的最近原文语义部分重叠。若选「只头全文+中段降级」，T=0 即可、结构不变。需拍板默认 T=1 还是 0。
- 【cache 优先级分叉】§六待拍板：「cache 绝对不漂（只设计A、接受 O(n) 斜率）」vs「接受偶发 cache miss 换防膨胀上界（上设计 B/C 根治）」。返工映射 §四已默认按后者（R-L1~R-L5 必做）。确认是否维持——这决定 R-L4/R-L5 是否真做。
- 【元批的 index 命名空间与水位隔离方案】R-L4 元批若用「末批 index+1」会与连续 index 语义冲突，且必须保证 buildRecord 派生 totalSteps/totalRounds 排除 meta 批。需拍板元批 index 方案（负数 / 独立前缀 / 放数组头），以及 buildRecord/appendBatch 幂等门如何明确「真实末批 = 最后一个非 meta 批」。这是 R-L4 正确性的核心。
- 【回溯/分支与折叠的交互】clampToBatch（回溯裁剪）与 copyRecordFrom（分支继承）目前按 stepEnd/roundEnd findIndex 取连续前缀。元批的 step/round 是并集区间，可能撕裂「元批在但 archived 原始批被裁」或反之。需拍板：回溯/分支时折叠态如何处理（建议元批与其 foldedFrom 的 archived 批作为整体一起裁/留，或回溯时先「解折叠」再按原始批裁）。

## M5-BPC and M5-6

**keyFindings**：

Full detail in assistant text response.

### PhaseA Data base, split compactNow, scheduler
- **files**: agentSettings, conversation, recordStore, agentLoop, bpcScheduler, bpc slice
- **changes**: BPC-0 1 2 3. See text.
- **risks**: override null not zero.
- **deps**: M5-1 M5-2

### PhaseB Wire run, boundaries, delta
- **files**: agentLoop, bpcScheduler, AgentPanel, recordGenerator
- **changes**: BPC-4 5 and M5-6. See text.
- **risks**: discard aborts bg.
- **deps**: PhaseA

### PhaseC UI ring, divider, settings, compile
- **files**: AgentPanel, CompressionRing, CompactDivider, SettingsPanel
- **changes**: BPC-6 7 8. See text.
- **risks**: threshold ordering.
- **deps**: PhaseA PhaseB

### openQuestions
- circuit break gap default one
- scheduler slice vs emitter
- computed step cursor
- ready replace reuses else prefix
- record layering before boundaries
- delta after snapshot time
- step end run entry value

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

## M5-BPC（后台预压缩，§8）+ M5-6（增量生成 δ，§2 第 4 点）

> 2026-06-18 补全：上一轮 tier3-design 只给了 PhaseA/B/C 概要（changes 全是占位 "See text"）。本次把 BPC-0~BPC-8 补到「文件+函数+精确改动点」级（对齐上方 M5-RL 的详细度）。

### 【现状精确基线（吃透源码后的关键事实，BPC 必须建在它之上）】

> ⚠️ 规范 §8 写于 M5-RL 落地【之前】，描述的 `compactNow` / `buildStableRecordPrefix` 是旧两档版。**当前源码 M5-RL（R-L1~R-L5）已全部落地**（git: `feat(M5-RL): R-L1~R-L3 … 前缀降 48%`），BPC 蓝图按【现状】写，不按规范旧描述：

- **M5-1 归一已就位**：`compactNow`（agentLoop.ts:1371-1528）是【单一压缩路径】，无 `isManualEntry` 分支；`batchSlice = coveredEligible.slice(priorSteps)` 单一口径（:1426）；手动 `/compact` 与自动压缩同源。`applyManualCompact` 已删。
- **M5-2 轮次地基已就位**：`services/roundBoundary.ts` 全套 helper（`identifyRounds` / `floorStepToRoundStart` / `keepRecentRoundsStartStep`），`RoundBoundaryResult` 产出 `stepToRound` / `rounds[{round,stepStart,stepEnd}]` / `totalRounds` / `totalSteps`。`RecordBatch.stepStart/stepEnd/roundStart/roundEnd` 落库（recordStore.ts:33-53）。compactNow 内已用真轮识别推导 batch round（:1432-1451）。
- **M5-RL 已就位**：`renderRecordPrefix(record, layering, forceTitleOnlyCount)`（agentLoop.ts:367-423，三级分层核心）、`buildStableRecordPrefix(record, layering?)`（:425，= force 0 包装）、`enforceRecordTokenCap(record, baseRecordMd, maxTokens, layering?)`（:442，R-L5 token 硬闸，正常路径 no-op）、`injectionViewBatches`（:355，过滤 archived + 按 stepStart 排序）、`foldOldBatches`（recordStore.ts:548，已被 compactNow:1489 在批数>foldThreshold 时调用）、`DEFAULT_LAYERING`（:308）全在。配置挂 `agentSettings.recordLayering`（RecordLayeringConfig，agentSettings.ts:49-62/132-139）+ `setRecordLayering`（:221）。
- **`compactNow` 现状（BPC-2 拆分对象）**：签名 `compactNow(conversationId, opts?: {compressedSegment?, workspaceName?, currentModel?}): Promise<string|null>`。**它已经是「生成 record 批 + appendBatch 落库 + R-L4 折叠 + 同步 autosave + 返回注入前缀 recordMd」一体**，但【尚未拆出纯生成变体】——返回的是 `buildStableRecordPrefix` 注入前缀（含组装语义），且内部 `saveAutosaveSnapshot` 写 store.messages。BPC-2 要把它一拆为二。
- **`run()` 压缩三分支（agentLoop.ts:743-821）**：① `wasCompressed`（compressContext 判定 ≥0.9 硬阈值，:743）→ 算 compressedSegment（:751）→ `await this.compactNow`（:755）→ enforceRecordTokenCap（:766）→ 注入；② `overLimitWithoutCompression`（少条超长危险态，:779）→ `truncateOverLongHistory`；③ else（未触发但已有 record，:791）→ 复用已有 record 前缀注入。**水位口径**：`triggerTokens = max(assembledTokens, apiRealTokens)`（:709），`modelContextWindow = getModelContextWindow(rootState)`（:688），`ratio = triggerTokens / modelContextWindow`。
- **重入闸**：`run()` 入口 `if(this.running)` 拒绝二次进入（:580）；`isStreaming` 覆盖整个压缩窗口（:593）。**BPC 后台生成绝不能走 `run()`**（会被重入闸挡 + 点亮 isStreaming 卡死 UI），必须独立 client/controller。
- **可中止链路**：`generateBatch(input, signal?)`（recordGenerator.ts:358）内部 `Promise.race([collect, timeout(60s), aborted])`（:267），每次 `resolveClient()` new 独立 AIClient（:204，abort 不误伤主对话）。`compactNow` 为每次压缩建独立 `AbortController` 登记进 `this.compressControllers`（agentLoop.ts:521/1413），`stop()` 遍历 abort（:559）。**BPC 要建自己的独立 controller 集合**，与 `compressControllers` 分开。
- **AgentLoop 实例持有**：`AgentPanel.tsx:364-418` useEffect 内 `const loop = new AgentLoop(aiClient)` + `wireTools()` + `agentLoopRef.current = loop`，cleanup `loop.stop()`。BPC scheduler 需拿到这个实例的 `compactNow`/拆分后的 `generateAndAppend`。
- **footer token 显示（BPC-6 改造主入口）**：`AgentPanel.tsx:2384-2392` `.token-counter`（red >0.8 / yellow >0.5 分级），计算 `AgentPanel.tsx:1640-1647`（`tokenCount` / `effectiveContextWindow` / `tokenRatio`）。同步两处：context tab `AgentPanel.tsx:2214-2220`、`StatusBar.tsx:74-83`（分级 :34）。
- **分隔线（BPC-7 改造对象）**：`batchDividerByIdx` 映射 `AgentPanel.tsx:265-287`（数据源 `recordBatchStepEnds` :248-261，已过滤 `b.meta`），渲染内联 div `AgentPanel.tsx:2122-2128`（虚线「⌁ record 批次 #N 边界 ⌁」）。
- **conversation slice override 范本**：`goal?: string` 全链路五处（slice: 接口 :199 / initialState :315 / setGoal :364 / setConversation :356 / clearConversation :604；persistence: snapshot :84 / autosave :207 / save :276 / load :818；ipc: ensureColumn 自愈 :152 / map :56 / create :218 / update :300；database.ts ensureColumn :180）。BPC override 两字段照此抄。
- **当前【完全没有】任何 BPC 代码**：grep `bpc`/`CompressionRing`/`scheduler`/`evaluateWater` 在 AgentPanel/conversation/agentSettings 零命中。SettingsPanel 压缩区只有写死占位文案（:1111-1119「📝 压缩策略」），**recordLayering 的 UI 也还没建**——BPC-7 要一并补 recordLayering + BPC 双套设置 UI。

### 【关键设计决策（主工程师可推翻，但默认按此落地）】

| # | 决策点 | 拍板 | 理由 |
|---|---|---|---|
| ① | 后台调度放哪 | **新建 `services/bpcScheduler.ts` 单例模块**，不进 `AgentLoop.run()` 主循环 | run() 有重入闸 + isStreaming 卡死风险，后台压缩绝不能借道 run()；调度状态机（idle/snapshotting/generating/ready/replacing/aborted/cooldown/circuit-broken）独立于对话循环，单例便于 footer/StatusBar/settings 三处订阅。scheduler 持有 AgentLoop 实例引用调其 `generateAndAppend` |
| ② | 快照/结果存哪 | **scheduler 内 runtime 字段（不持久化）+ 新建不持久化 `bpc` Redux slice 仅承载 UI 可订阅状态**（state/progress/cooldownUntil/circuitBroken） | `BpcSnapshot`（含深拷贝 compressedSegment）是大对象、纯运行态、重启即弃 → 放 scheduler 内存字段；但 UI（CompressionRing）要响应式订阅状态 → 用极薄 `bpc` slice 只存枚举态 + 进度数字（不存快照本体）。规范 §8.4 倾向「不持久化 slice」，本方案 = scheduler 持数据 + slice 持 UI 投影，二者职责分离 |
| ③ | 与 90% 同步压缩 / compactNow / enforceRecordTokenCap 共存 | **三者共用 BPC-2 拆出的 `generateAndAppend`**；BPC 是「在 generateAndAppend 之上加调度/快照/延迟替换壳」；run() 90% 硬阻塞分支**保留为兜底**，但加前置判断「BPC 已 ready 且未撞 0.9 → 先无缝替换、跳过阻塞」；enforceRecordTokenCap 在【替换组装时】照常过一道（BPC 注入前缀同样要 R-L5 兜底） | 规范 §8.2②明确 compactNow 拆纯生成变体，自动兜底 + BPC 共用。三条压缩路径（BPC 预压 / 90% 硬阻塞 / else 复用）口径统一，避免打架 |
| ④ | 与 R-L4 折叠 / R-L6 衔接 | `generateAndAppend` 内**沿用 compactNow 现有的 R-L4 折叠触发**（批数>foldThreshold 自动折叠）；R-L6（预测驱动折叠）**可选**，在 BPC-3 scheduler 生成前调 `predictRecordPrefixTokens`（R-L6 新增），超 maxRatio 提前 foldOldBatches | 折叠已在 compactNow 内（:1489），拆分后天然继承；R-L6 是 BPC↔分层双向衔接的可选增强，非阻塞 |

### BPC-0 前置依赖确认（不写代码，effort=small）
- **files**: 无（核对 + 写自检记录）
- **changes**: 核对四项现状基线均就位（见上「现状精确基线」）：① M5-1 归一（`compactNow` 单一 batchSlice、无 isManualEntry、`applyManualCompact` 已删）；② M5-2 轮次/step 游标（`roundBoundary.ts` 全套 + `RecordBatch` step/round 落库）；③ `compactNow` 可拆纯生成+落库（BPC-2 前提，确认其内部「generateBatch→appendBatch→fold→autosave→buildStableRecordPrefix」边界清晰可拆）；④ conversation 有 step/round 运行态可取（**注意：当前 run() 内是【每轮临时 `identifyRounds(requestHistory)`】算 step/round，conversation slice 里【没有】持久 step 游标字段——BPC 的 `snapshotStepCursor` 需在 BPC-3 拍快照瞬间用 `identifyRounds(过滤 tool 的 store.messages).totalSteps` 现算，见 BPC-3 openQuestion）。
- **risks**: 唯一落差 = 「conversation 无显式 step 游标」。规范 §8.2 假设有「step/round 运行态游标」，实际是按需计算。BPC-3/4 的 `snapshotStepCursor` / `targetReplaceStep` / `evaluateWater` 全部改为【按需 `identifyRounds` 现算 totalSteps】，口径与 compactNow/run() 一致即可，无需新增持久游标。
- **deps**: M5-1 + M5-2（均已就位）。

### BPC-1 数据与配置底座（effort=medium）
- **files**: `synapse-app/src/store/slices/agentSettings.ts`、`synapse-app/src/store/slices/conversation.ts`、`synapse-app/src/services/recordStore.ts`、`synapse-app/src/services/conversationPersistence.ts`、`electron/ipc/conversation.ts`、`electron/database.ts`
- **changes**:
  - ① **agentSettings 全局 BPC 配置**（仿 `recordLayering` 范式）：新增接口 `BpcConfig { bpcThreshold:number; compactThreshold:number; deltaSteps:number; abortCooldownMin:number; circuitBreakGapSteps:number }`，挂 `AgentSettingsState.bpc`（agentSettings.ts:64-93 接口区 + :95-140 initialState）。默认 `{ bpcThreshold:0.68, compactThreshold:0.9, deltaSteps:2, abortCooldownMin:3, circuitBreakGapSteps:1 }`（§8.3 + §8.4 待拍板熔断间距默认 1）。加 `setBpc(state, action:PayloadAction<Partial<BpcConfig>>)` reducer（仿 `setRecordLayering` :221-223，浅合并）+ export（:340-350）。
  - ② **`compactThreshold` 迁移**：保留 `systemPrompt.ts:58 COMPRESSION_THRESHOLD=0.9` 作为**默认值常量**（compressContext 默认参兜底），但 run() 的硬阈值改读 `agentSettings.bpc.compactThreshold`（见 BPC-4）。**不删 COMPRESSION_THRESHOLD**（compressContext 签名默认参 + 其它引用仍用它兜底，符合「写死常量只作默认值」§8.3）。
  - ③ **conversation 本对话覆盖**（仿 `goal` 五处全链路）：`ConversationState` 加 `bpcThresholdOverride?: number` + `compactThresholdOverride?: number`（conversation.ts:199 后）；initialState `undefined`（:315 后）；reducer `setBpcThresholdOverride` / `setCompactThresholdOverride`（仿 setGoal :364，空/非法值置 undefined）；`setConversation` 回填（:356 后，`if('bpcThresholdOverride' in payload)`）；`clearConversation` 清空（:604 后）。
  - ④ **override 持久化**（仿 goal）：`ConversationSnapshot` 加两字段（conversationPersistence.ts:84）；autosave/save metadata 带两字段（:207/:276）；persistPlatformSnapshot 签名（:848）；loadPlatformSnapshot 回填（:818，`?? null || undefined`）。**注意 number 字段 0 与 undefined 区分**：override 用 `typeof x==='number' ? x : null` 落库，读回 `typeof===number ? x : undefined`，**绝不能用 `x || undefined`**（0 是合法阈值会被吃掉，虽实际阈值不会是 0，但口径要对）。
  - ⑤ **override DB 列**：`database.ts:180` 后加 `ensureColumn(db,'conversations','bpc_threshold_override','REAL')` + `compact_threshold_override REAL`；`electron/ipc/conversation.ts` 注册期 ensureColumn 自愈 + hasColumn 缓存（:152 后）；mapConversation 映射（:56，下划线转驼峰 `bpcThresholdOverride: row.bpc_threshold_override ?? null`）；create（:218）/update（:300）按 hasColumn 缺列降级 + undefined 不动（REAL 列，写 `typeof===number ? x : null`）。
  - ⑥ **`RecordBatch.source`**：recordStore.ts:33-66 RecordBatch 接口加 `source?: 'auto' | 'manual' | 'bpc'`（缺省视作 'auto'）；`normalizeBatch`（:211）读回 `source: b.source ?? 'auto'`；`appendBatch` 入参（AppendBatchInput）加可选 `source`，写进批；**DB 落库**：record 是整 JSON blob（非列），source 随 batch 对象天然进 JSON，**无需 ensureColumn**（确认 records 表是 schema_version+content_md+batches_json 整存，source 在 batches_json 内自动持久化）。
- **risks**: ① override 是 number，持久化/回填**严禁 `x || undefined`**（0 falsy 陷阱），统一 `typeof==='number'` 判定（虽阈值现实不为 0，但留作正确口径防未来 0.0 边界）。② `RecordBatch.source` 若走整 JSON blob 落库则零迁移；若 records 表把 batches 拆列则需确认（**先 Grep 确认 records 表结构**，预期是 JSON blob）。③ `circuitBreakGapSteps` 默认值是 §8.4 待拍板项，先填 1，UI 暴露可调。④ agentSettings 整 slice 自动持久化（无需改持久化代码，同 recordLayering）。
- **deps**: 无（纯数据底座，可与 BPC-2 并行）。被 BPC-3/4/5/6/7 全依赖。

### BPC-2 `compactNow` 拆分出 `generateAndAppend`（effort=medium）
- **files**: `synapse-app/src/services/agentLoop.ts`
- **changes**:
  - ① 从 `compactNow`（:1371-1528）抽出**纯生成+落库**核心方法 `private async generateAndAppend(conversationId, opts: { compressedSegment: ChatMessage[]; workspaceName?: string; currentModel?: string; source?: 'auto'|'manual'|'bpc'; signal?: AbortSignal }): Promise<{ recordMd: string|null; appended: boolean; totalSteps: number; totalRounds: number }>`。内容 = 现 compactNow 的 :1417-1526 主体（getRecord → batchSlice 切片 → generateBatch → appendBatch → R-L4 折叠 → 同步 autosave → buildStableRecordPrefix），**两点变化**：(a) AbortController 改为【可由调用方传入 signal】（BPC 传自己的 controller.signal；自动/手动路径传 `compactNow` 新建的，登记进 `compressControllers`）；(b) appendBatch 入参带 `source`（透传），返回结构含 `appended`（batchSlice 是否落了新批）+ 落库后 `totalSteps/totalRounds`（供 BPC 算 targetReplaceStep）。
  - ② `compactNow` 改为**薄壳**：保留现签名（兼容 /compact 与 run() 调用点不改），内部 = 算/取 compressedSegment（手动入口的按轮取整逻辑 :1386-1403 保留）→ new AbortController 登记 compressControllers → `await this.generateAndAppend({compressedSegment, ..., source: opts?.source ?? 'auto', signal: controller.signal})` → finally delete controller → 返回 `.recordMd`。**对现有 run() / /compact 路径逐字节等价**（行为不变，只是内部下沉）。`compactNow` opts 加可选 `source`（/compact 传 'manual'，run 自动兜底传 'auto'）。
  - ③ **source 标注接线**：run() 的 `wasCompressed` 自动压缩分支（:755 调 compactNow）传 `source:'auto'`；AgentPanel `/compact` handler（:1037 调 `loop.compactNow(convId)`）传 `source:'manual'`；BPC scheduler 走 `generateAndAppend({source:'bpc'})`。
- **risks**: ① 拆分必须**对现有路径逐字节不变**——`generateAndAppend` 主体直接搬，不改逻辑；唯一新增是 signal 入参（自动/手动仍 new controller 传入，行为同前）与返回结构扩展。② AbortController 归属：BPC 用**自己的 controller 集合**（BPC-3 建），不混进 `compressControllers`（那是主对话 stop() 管的）。`generateAndAppend` 只认 `opts.signal`，不自己建 controller（建 controller 的责任上移到 compactNow 壳 / bpcScheduler）。③ 同步 autosave（:1502-1516）在 BPC 后台路径同样执行——确认后台 autosave 不与主对话 autosave 打架（autosave 是整快照覆盖写、幂等，且 BPC 跑时主对话可能也在写 → **靠 autosave 自身的防抖/原子写兜底**，BPC autosave 失败照常吞异常不阻塞）。
- **deps**: BPC-1（source 字段）。被 BPC-3 依赖。

### BPC-3 新建 `services/bpcScheduler.ts`（effort=large，核心）
- **files**: `synapse-app/src/services/bpcScheduler.ts`（新建）、`synapse-app/src/store/slices/bpc.ts`（新建，极薄 UI 投影 slice）、`synapse-app/src/store/index.ts`（注册 bpc reducer）
- **changes**:
  - ① **`bpc` slice（不持久化）**：`BpcUiState { state: 'idle'|'snapshotting'|'generating'|'ready'|'replacing'|'aborted'|'cooldown'|'circuit-broken'; progress: number(0-1); cooldownUntil: number|null; circuitBroken: boolean; lastError?: string }`，reducers `setBpcUiState` / `setBpcProgress` / `resetBpcUi`。**绝不持久化**（不进 conversationPersistence；store 重启 idle）。仅供 CompressionRing 订阅。
  - ② **`BpcSnapshot` 结构**（scheduler 内存，不进 slice）：`{ conversationId: string; snapshotStepCursor: number; snapshotRoundCursor: number; compressedSegment: ChatMessage[](深拷贝冻结); targetReplaceStep: number(=snapshotStepCursor + 1 + deltaSteps); createdAt: number; recordMd?: string|null(ready 后填) }`。**深拷贝**：`compressedSegment` 用 `structuredClone` 或 `JSON.parse(JSON.stringify)` 冻结触发瞬间的被压段（后续 store 照常发展不影响）。
  - ③ **scheduler 单例**：`class BpcScheduler { private snapshot: BpcSnapshot|null; private abortControllers = new Set<AbortController>(); private loop: AgentLoop|null; private genPromise: Promise<void>|null; ... }` + `export const bpcScheduler = new BpcScheduler()`。状态机字段 + `lastReplaceStepCursor`（熔断用）+ `cooldownUntil`。
  - ④ **`attachLoop(loop: AgentLoop)`**：AgentPanel 构建 AgentLoop 后注入（让 scheduler 能调 `loop['generateAndAppend']` —— 因 generateAndAppend 是 private，要么改 public、要么 scheduler 调一个 AgentLoop 新增的 public `runBpcCompaction(snapshot)` 包装方法。**倾向后者**：AgentLoop 加 public `async bpcGenerate(conversationId, compressedSegment, signal): ReturnType<generateAndAppend>` 薄包装，封装感更好）。
  - ⑤ **`evaluateWater(ctx: { triggerTokens, modelContextWindow, conversationId, currentStepCursor })`**：算 `ratio = triggerTokens / modelContextWindow`；读 `effectiveBpcThreshold = conversation.bpcThresholdOverride ?? agentSettings.bpc.bpcThreshold`；若 `ratio >= effectiveBpcThreshold && state==='idle' && !inCooldown() && !circuitBroken` → 调 `triggerSnapshot()`。**口径必须与 run() 一致**：triggerTokens/modelContextWindow 由调用方（BPC-4 接线处）按 run() 同款公式算好传入（不在 scheduler 内重算，避免口径漂移）。
  - ⑥ **`triggerSnapshot(conversationId, currentStepCursor, ...)`**：state→snapshotting；从 store 现算 `compressedSegment`（= run() :751 同款：保留最近若干整轮原文之前的全量段，用 `keepRecentRoundsStartStep` 或对齐 compactNow 手动入口的按轮取整）+ 深拷贝冻结；`snapshotStepCursor = identifyRounds(过滤tool的store.messages).totalSteps`；`targetReplaceStep = snapshotStepCursor + 1 + deltaSteps`；state→generating；进 `runGeneration()`。
  - ⑦ **`runGeneration()`**：new AbortController 加进 `abortControllers`；`dispatch(setBpcUiState('generating'))`；`await loop.bpcGenerate(conversationId, snapshot.compressedSegment, controller.signal)`（复用 generateBatch 的 race 可中止链路）；成功 → `snapshot.recordMd = 结果.recordMd`，state→ready，`dispatch(setBpcUiState('ready'))`；失败/中止 → 进 δ 窗口 retry 逻辑（见 BPC-4 ④）或 discardCurrent。finally delete controller。**进度**：generateBatch 不流式无中间进度，progress 用「snapshotting=0.1 / generating=不确定（UI 显 indeterminate 环或脉冲）/ ready=1」三档即可（不强求百分比）。
  - ⑧ **`discardCurrent()`**：abort 全部 `abortControllers` + clear；`snapshot=null`；state→idle。供 BPC-4 边界② 用（撞硬阈值丢弃在途 BPC）。
  - ⑨ **`abort()`（用户手动中止）**：discardCurrent + 设 `cooldownUntil = Date.now() + cooldownMin*60000`；state→cooldown；`dispatch(setBpcUiState('cooldown', cooldownUntil))`。
  - ⑩ **`restart()`（熔断后手动重启）**：清 circuitBroken + cooldown，state→idle。
  - ⑪ **`takeReadyPrefix(currentStepCursor): { recordMd, snapshot } | null`**：供 run() 进入时取——若 `state==='ready' && snapshot`，返回 recordMd 供替换（替换组装在 BPC-4），state→replacing→（替换完）idle，记 `lastReplaceStepCursor=currentStepCursor`，并跑熔断检查（BPC-5 边界⑤）。
- **risks**: ① **snapshotStepCursor 现算 vs 持久游标**：当前无持久 step 游标（见 BPC-0），用 `identifyRounds(过滤tool的store.messages).totalSteps` 现算——但 store.messages 在 snapshot→generating 期间会增长，`snapshotStepCursor` 必须在 triggerSnapshot 瞬间锁定（值拷贝），不能后续重算。② scheduler 持有 `loop` 引用，AgentLoop 重建（切模型/MCP refresh，AgentPanel:364 useEffect 重跑）时要 `attachLoop` 重新注入 + 把在途 BPC discardCurrent（旧 loop 已 stop）。③ 深拷贝 compressedSegment 含 contentParts/attachments（sha256 引用态，无 base64，体积可控）——`structuredClone` 对纯数据 OK。④ scheduler 是模块单例，但对话切换时 `snapshot.conversationId` 要校验（takeReadyPrefix/evaluateWater 都比对当前 conversationId，切换则 discardCurrent，防张冠李戴）。⑤ generateBatch 后台跑时主对话也可能触发 compactNow（90% 硬阻塞）→ 两路对同 conversationId 的 appendBatch 竞争：靠 appendBatch 幂等水位门（stepStart==末批 stepEnd）兜底，但 BPC 边界②（撞硬阈值 discardCurrent）应在 90% 真压缩前先丢掉 BPC，避免双写（见 BPC-4/5）。
- **deps**: BPC-1（配置 + override）、BPC-2（generateAndAppend / bpcGenerate）。被 BPC-4/5/6 依赖。

### BPC-4 接线进 `agentLoop.run()` + δ 替换（effort=large）
- **files**: `synapse-app/src/services/agentLoop.ts`、`synapse-app/src/components/layout/AgentPanel.tsx`
- **changes**:
  - ① **step 收尾钩子**：在 run() while 循环每轮末（:1311 `continue` 前 + :1316 `break` 前，即工具轮末与自然完成末）调 `bpcScheduler.evaluateWater({ triggerTokens, modelContextWindow, conversationId, currentStepCursor })`。triggerTokens/modelContextWindow 用本轮已算好的值（:688/:709）——但 while 内每轮会变，**简化**：在 while 循环【末尾】重算一次本轮 assembled（或直接复用进入时的 triggerTokens 做近似，因为 BPC 是预压、稍早稍晚一轮不致命）。**倾向**：循环末用轻量 `countConversationTokens(当前 store.messages)` 估算 ratio 即可（BPC 是「提前预压」，估算粒度够）。fire-and-forget，不 await（evaluateWater 内部 async 触发后台生成，绝不阻塞 run）。
  - ② **run() 进入时优先用 ready 的 BPC**：在 :742 `let apiHistory` 之前加前置：`const bpcReady = bpcScheduler.takeReadyPrefix(currentStepCursor)`；若 `bpcReady && !(ratio >= compactThreshold)`（未撞硬阈值）→ **用 BPC 前缀组装 apiHistory，跳过 wasCompressed 阻塞压缩**：`apiHistory = [{role:'system', content: RECORD_INJECTION_PREFIX + enforceRecordTokenCap(record, bpcReady.recordMd, recordTokenCap, layering)}, ...requestHistory.slice(keepFromIdx)]`（keepFromIdx 按 BPC 快照的保留轮 / 现算 floorStepToRoundStart(totalSteps)），并插 BPC 分隔线标记（source='bpc' 已在 generateAndAppend 落库的批上，UI 自动识别）。
  - ③ **硬阈值改读配置**：run() 的 compressContext 调用（:713）与 overLimitWithoutCompression 阈值（:783）的 `COMPRESSION_THRESHOLD` 改为 `effectiveCompactThreshold = conversation.compactThresholdOverride ?? agentSettings.bpc.compactThreshold ?? COMPRESSION_THRESHOLD`。compressContext 签名已支持传 maxTokens，阈值比例改传 effectiveCompactThreshold（注意 compressContext 内部 `maxTokens * COMPRESSION_THRESHOLD` 是写死的 —— 需把 compressContext 改为接受 threshold 比例参，或在调用方先算 `modelContextWindow * effectiveCompactThreshold` 传 maxTokens 并把内部比例设 1.0。**倾向**：给 compressContext 加可选 `thresholdRatio` 参，默认 COMPRESSION_THRESHOLD，run 传 effectiveCompactThreshold）。
  - ④ **δ 窗口自动 retry**（规范 §8.2④，δ=「最晚上限」非「必须等到」）：takeReadyPrefix 正常路径 = ready 即用（不等 targetReplaceStep）。δ 的兜底逻辑在 scheduler：generating 失败/中止后，若 `currentStepCursor < snapshot.targetReplaceStep`（还在窗口内）→ 自动重试 runGeneration（重新生成）；`currentStepCursor >= targetReplaceStep` 仍无 ready → discardCurrent（越过上限放弃 BPC，下次撞 90% 走硬阻塞兜底）。retry 次数上限（如 1 次）防无限重试。
  - ⑤ **替换无阻塞**：替换只换 apiHistory 前缀（局部变量），不卡当前 step、不动 store.messages。成功后 `dispatch(setBpcUiState('idle'))`。
- **risks**: ① **while 循环内每轮 evaluateWater 的 ratio 口径**：严格按 run 进入时的 triggerTokens 公式重算成本高；近似用 `countConversationTokens(store.messages)` 够用（BPC 容忍误差）。但 footer 显示的 ratio（BPC-6）要与触发口径一致，否则「环显示 65% 但已触发」割裂——**统一**：footer 与 evaluateWater 都用同一个 ratio 来源（倾向 AgentPanel:1640 的 tokenRatio，BPC-6 让 scheduler 也读它）。② **compactThreshold 比例下推 compressContext**：compressContext 内部 `maxTokens*COMPRESSION_THRESHOLD` 写死（systemPrompt.ts:241），必须改造签名加 thresholdRatio 参（小改，默认值兼容）。③ takeReadyPrefix 与 wasCompressed 分支**互斥**：BPC ready 用了就 return / 跳过 wasCompressed，不能两路都注入。④ currentStepCursor 在 run 进入时算一次（`identifyRounds(requestHistory).totalSteps`），与 snapshotStepCursor 同口径。⑤ BPC 替换后 store.messages 的保留段 keepFromIdx 要按轮取整（复用 floorStepToRoundStart），与 else 分支 :809 同款。
- **deps**: BPC-3（scheduler API）。被 BPC-5/6/7 依赖。

### BPC-5 五边界落地（effort=medium）
- **files**: `synapse-app/src/services/agentLoop.ts`、`synapse-app/src/services/bpcScheduler.ts`
- **changes**（边界 ③④ 在 BPC-6/7 UI/设置侧，这里落 ①②⑤）：
  - **边界①（超大单条输入硬阻塞兜底）**：run() 进入时若 `ratio >= effectiveCompactThreshold`（单 step 直接撞硬阈值甚至超窗）→ **不等 BPC**，先 `bpcScheduler.discardCurrent()`（丢掉可能在途的 BPC），走现有 `wasCompressed`（compressContext）或 `overLimitWithoutCompression`（truncateOverLongHistory :784）路径。即 takeReadyPrefix 的前置条件 `!(ratio >= compactThreshold)` 天然覆盖——撞硬阈值就不取 BPC、转硬阻塞。复用现有 :629-635 / :779 危险态路径，零新逻辑。
  - **边界②（BPC 未真替换前撞压缩阈值）**：run() 进入时 `if (ratio >= effectiveCompactThreshold && bpcScheduler.state !== 'idle')` → `bpcScheduler.discardCurrent()`（abort 在途 BPC + 丢快照），转硬阻塞同步压缩。判据 =「只要没真替换（state 不是已替换完的 idle）就扔掉这轮 BPC」。**与边界① 合并实现**：撞硬阈值 → 无条件 discardCurrent + 走硬阻塞。
  - **边界⑤（无限循环熔断）**：scheduler 记 `lastReplaceStepCursor`；`takeReadyPrefix` 替换成功后，下一次 `evaluateWater` 若 `ratio >= bpcThreshold` 且 `currentStepCursor - lastReplaceStepCursor <= circuitBreakGapSteps`（默认 1，即替换后几乎没推进就又触发）→ 计数 `consecutiveImmediateRetrigger++`；连续 2 次 → `circuitBroken=true`，state→circuit-broken，`dispatch(setBpcUiState('circuit-broken'))` + 弹窗通知「BPC 循环已停止，请手动重启」（addNotification type:'warning' + 持久，或专用弹窗）。停 BPC 直到 `restart()`。**与 R-L4/R-L5 互补**：分层保证「压完有上界」是结构性预防，熔断是兜底。
- **risks**: ① 边界①② 的「撞硬阈值」判据用 `ratio >= effectiveCompactThreshold` 统一，discardCurrent 必须在 90% 真压缩【之前】调用（防 BPC 后台 appendBatch 与硬阻塞 appendBatch 双写竞争）。② 熔断计数 `circuitBreakGapSteps` 默认 1 是 §8.4 待拍板项——UI 暴露可调（BPC-7）。③ 熔断弹窗要可操作（带「重启 BPC」按钮 → bpcScheduler.restart()），不能只是 toast 一闪而过。④ discardCurrent 的 abort 要确保 generateBatch 的 race 真的中断（signal 透传链路 BPC-3 已建）。
- **deps**: BPC-3、BPC-4。

### BPC-6 UI 压缩环 CompressionRing（effort=large）
- **files**: `synapse-app/src/components/layout/CompressionRing.tsx`（新建）、`synapse-app/src/components/layout/AgentPanel.tsx`、`synapse-app/src/components/layout/StatusBar.tsx`、对应 CSS
- **changes**:
  - ① 新建 `CompressionRing` 组件：订阅 `bpc` slice（`useAppSelector(s=>s.bpc)`）+ 接收 `tokenCount/effectiveContextWindow/tokenRatio` props。**三态渲染**：(a) `idle` → 常规 token% 文本（**保留现有 >0.8 红 / >0.5 黄 / 否则灰分级**，AgentPanel:2387-2389 的逻辑搬进来）；(b) `generating`/`snapshotting` → 环形进度（SVG circle indeterminate 旋转或脉冲）+「后台压缩中」+ 中止按钮 ×（onClick→`bpcScheduler.abort()`）；(c) `replacing` → 短暂「替换中」；(d) 硬阻塞压缩（run 走 wasCompressed 路径时）→「压缩中」阻塞态（需 BPC-4 在硬压缩时也 dispatch 一个 UI 态，或复用 isCompactingRef）；(e) `cooldown` → 灰色「冷却中 Nm」；(f) `circuit-broken` → 红色「BPC 已停」+ 重启按钮（→`bpcScheduler.restart()`）。**不再单独显示限额**，限额区改显 BPC/硬压进度（§8.1③/§9.1）。
  - ② **替换 footer 主入口**：AgentPanel:2384-2392 的 `.token-counter` span 换成 `<CompressionRing tokenCount={tokenCount} effectiveContextWindow={effectiveContextWindow} tokenRatio={tokenRatio} />`。
  - ③ **同步 context tab**（AgentPanel:2214-2220）：context tab 的 Token 使用区也用 CompressionRing 的精简变体（或至少在 generating 时显「后台压缩中」），保持三处一致。
  - ④ **同步 StatusBar**（StatusBar.tsx:74-83）：StatusBar 订阅 `bpc` slice，generating 时 token 区改显「压缩中●」状态色，复用 :34 分级。
  - ⑤ **scheduler→UI 桥**：scheduler 的状态变化全部 `dispatch(setBpcUiState/...)`（BPC-3 已埋点），CompressionRing 纯订阅 slice，不直接调 scheduler（除按钮 abort/restart）。**ratio 口径统一**：CompressionRing 的 idle 文本用 AgentPanel 传入的 tokenRatio，evaluateWater（BPC-4）也用同源 ratio，避免「环显示 % 与触发判定割裂」（见 BPC-4 risk①）。
- **risks**: ① 三处（footer/context tab/StatusBar）订阅同一 `bpc` slice 保证一致，但各自的 tokenRatio 来源不同（AgentPanel:1640 vs StatusBar:24-31）——idle 文本用各自原有口径即可（本就略有差异，现状如此），关键是 generating/中止态三处同步。② 环形进度 generating 无真百分比（generateBatch 不流式）→ 用 indeterminate 动画，不要假进度条。③ 中止按钮 × 的命中区要够大（footer 空间小），hover 提示「中止后台压缩」。④ 硬阻塞压缩态（边界①②走的同步压缩）也要在环上体现「压缩中」阻塞——BPC-4 硬压缩分支加 `dispatch(setBpcUiState('replacing'))` 或新增 'hard-compacting' 态。
- **deps**: BPC-1（bpc slice，实际 slice 在 BPC-3 建）、BPC-3、BPC-4、BPC-5。

### BPC-7 分隔线 CompactDivider + 设置面板（effort=medium）
- **files**: `synapse-app/src/components/layout/CompactDivider.tsx`（新建）、`synapse-app/src/components/layout/AgentPanel.tsx`、`synapse-app/src/components/settings/SettingsPanel.tsx`、对应 CSS
- **changes**:
  - ① **CompactDivider 组件**（替代内联 div AgentPanel:2122-2128）：参考 Codex 风格（渐变细线 + 居中标签 + 图标），按 `source` 区分三态——'manual'（手动 /compact）/'auto'（自动阻塞）/'bpc'（BPC 专属图标 + 渐变 + 「BPC 自动压缩 · 已压 N 轮」）。
  - ② **batchDividerByIdx 带 source**：`recordBatchStepEnds`（AgentPanel:248-261）改为同时取 `source`（`rec.batches.filter(!meta).map(b=>({stepEnd:b.stepEnd, source:b.source??'auto', roundEnd:b.roundEnd}))`）；`batchDividerByIdx`（:265-287）map value 带 source；渲染处（:2122）`<CompactDivider source={...} batchIndexes={...} rounds={...} />`。
  - ③ **SettingsPanel 压缩设置区**（conversation tab，替换 :1111-1119 写死占位的「📝 压缩策略」）：新建两个分组 section——
    - **「🔄 后台预压缩 (BPC)」**：4 个滑杆/数字（仿 Temperature :1099-1103 / MaxTokens :1104-1109 范本）：`bpcThreshold`（range 40-90%，step 1，显示 %）、`compactThreshold`（range 50-95%）、`deltaSteps`（number 1-10）、`abortCooldownMin`（number 0-30）、`circuitBreakGapSteps`（number 0-5）。读 `agentSettings.bpc`，dispatch `setBpc({...})`（仿 `setBackgroundSettings` 浅合并范式）。
    - **「📚 Record 分层」**（顺手补 R-L2 欠的 UI）：`headFull`/`tailFull`/`titleThreshold`/`maxRatio`/`foldThreshold`/`foldBatchK`（number 输入），读 `agentSettings.recordLayering`，dispatch `setRecordLayering`。
    - **边界④ 风险校验**（§8.2④）：在 BPC 区下方 inline `<span className="setting-hint" style={{color: 风险?'var(--syn-warning)':...}}>`：`(compactThreshold − bpcThreshold) < 0.2 || bpcThreshold < 0.4` → 黄色文案「⚠️ BPC 阈值与压缩阈值距离过近 / BPC 阈值过低，可能频繁压缩」（**纯 UI 校验，不阻止保存**）。范本见 SettingsPanel:974-976 条件 hint。
    - **本对话覆盖入口**（边界③）：BPC 区加「本对话覆盖」小节，读 `conversation.bpcThresholdOverride/compactThresholdOverride`，dispatch `setBpcThresholdOverride/setCompactThresholdOverride`（留空=用全局默认）。或 /命令入口（可选）。
  - ④ CSS：CompactDivider 渐变细线 + 三态配色（manual 灰 / auto 蓝 / bpc 紫渐变 + 专属图标）。SettingsPanel 沿用 `.setting-item` 现有类，零新组件。
- **risks**: ① batchDividerByIdx 数据源加 source 要确认 `RecordBatch.source` 已落库（BPC-1 ⑥）+ 旧批 source 缺省 'auto'（normalizeBatch 兜底）。② 「已压 N 轮」的 N = 该批 `roundEnd - roundStart + 1` 或累计，从 batch 取。③ 风险校验是纯前端、不阻止保存（§8.2④ 明确）。④ recordLayering UI 是顺手补的（R-L2 备注「UI 留到 BPC-7」），别漏。⑤ deltaSteps/circuitBreakGapSteps 是 step 单位，UI 文案要说清「step = 一次 user 消息或一次模型往返」（§1）。
- **deps**: BPC-1（配置 + source + override）、BPC-3（bpc slice）。

### BPC-8 双编译验证 + 自检（effort=medium）
- **files**: 无（验证）
- **changes**: `npm run build` + `npm run electron:build` 双编译通过（项目无测试 runner，沿用历史 stage 验证约定）。手动自检脚本：① 渐进对话触达 bpcThreshold(0.68) → 观察 footer CompressionRing 转「后台压缩中」环 → 后台生成完 ready → 下一轮 run 发请求无缝替换（看 BPC 分隔线插入 + footer 回 idle）；② δ 窗口：ready 早于 targetReplaceStep 即用；生成失败在 δ 窗口内 retry；越上限退硬阻塞；③ 超大单条输入一瞬撞 0.9 → 直接硬阻塞（不等 BPC，discardCurrent）；④ 手动中止 → cooldown Nmin，冷却期不触发；⑤ 连续循环（构造压完仍高位）→ 熔断弹窗 + 重启按钮；⑥ 设置面板改 bpcThreshold/compactThreshold 触发风险校验黄字；⑦ 本对话 override 生效 + 持久化（重启后 override 还在）；⑧ /compact 手动压缩分隔线 source='manual'、自动 'auto'、BPC 'bpc' 三态视觉区分正确。
- **risks**: 无测试 runner（同 M5-RL），靠双编译 + 手动自检。BPC 涉及异步时序（后台生成/替换/中止/熔断），手动自检要覆盖时序边界，建议配合 console 日志埋点观察 scheduler 状态机迁移。
- **deps**: BPC-1~BPC-7 全部。

---

## M5-6 增量生成 δ（§2 第 4 点，effort=medium）

> 与 BPC 的 δ【不同概念】：M5-6 的 δ = record 增量生成时的「前后文连贯性参考轮」（≤1 轮）；BPC 的 δ = 替换时机的「最晚上限 step 窗口」。同名不同义，勿混。

- **files**: `synapse-app/src/services/recordGenerator.ts`、`synapse-app/src/services/agentLoop.ts`
- **changes**:
  - ① `GenerateBatchInput`（recordGenerator.ts:318-330）加可选 `contextBefore?: string` / `contextAfter?: string`（δ 轮原文的占位文本，只读参考）。
  - ② `buildBatchPrompt`（:164-193）加「## 前文参考（只读，勿写入输出）」「## 后文参考（只读，勿写入输出）」分区（仿现有 priorSkeleton skeletonSection :171-177 的「只读」措辞），拼在 body 前/后。
  - ③ `compactNow`/`generateAndAppend`（agentLoop.ts:1457 调 generateBatch 处）算 δ 参考：`contextBefore` = 被压段起点【前】δ 轮原文（`batchSlice` 之前的 coveredEligible 末 δ 轮）；`contextAfter` = 被压段止点【后】δ 轮原文（保留段的前 δ 轮，即 requestHistory.slice(keepFromIdx) 的头 δ 轮）。δ 按轮取（≤1 轮）或按 token 上限截断。
  - ④ **δ 参考不计入 step/round 水位**：contextBefore/After 仅进 prompt 帮助模型理解上下文连贯，**不改 stepStart/stepEnd/roundStart/roundEnd**（本批 record 只覆盖目标段本身，规范 §2 第 4 点）。
- **risks**: ① δ 参考是「只读」，prompt 措辞要强调「勿把它写进输出」（仿 priorSkeleton），否则模型会把参考内容揉进本批日志造成重复。② contextBefore 取「被压段之前」——首批压缩时无前文（priorSteps=0），contextBefore 空。③ δ 取轮要用 identifyRounds 按轮边界取（不轮中间切）。④ 参考文本要用 `chatContentToTextWithPlaceholder`（同 batchSlice :1462，图片转占位不带 base64）。
- **deps**: M5-2（轮边界，已就位）。独立于 BPC，可与 BPC 并行（但都改 generateBatch/compactNow，注意改动不冲突——M5-6 加参，BPC-2 拆函数，建议 BPC-2 先做或同人做）。

---

### openQuestions（需主工程师拍板）

1. **【熔断 step 间距阈值默认值】**（§8.4 待拍板）：`circuitBreakGapSteps` 默认 1（替换后 1 step 内又触发即算「立即重触发」）。是否合适？连续几次熔断（默认 2）也需确认。已进设置面板可调（BPC-7），但默认值要定。
2. **【scheduler 状态承载】**（§8.4 倾向不持久化 slice）：本蓝图取「scheduler 内存持数据（BpcSnapshot）+ 极薄 bpc slice 持 UI 投影」混合方案。是否接受？纯 EventEmitter（不建 slice）会让三处 UI 订阅更绕，故倾向 slice。
3. **【无持久 step 游标】**：当前 conversation 无显式 step 游标，BPC 的 snapshotStepCursor/currentStepCursor 全用 `identifyRounds(过滤tool的store.messages).totalSteps` 现算。是否需要在 conversation slice 加持久 step/round 游标（更稳但增持久化面）？倾向现算（口径与 compactNow/run 一致、零持久化）。
4. **【generateAndAppend 暴露方式】**：BPC scheduler 调 AgentLoop 的纯生成。是把 `generateAndAppend` 改 public，还是加 public 包装 `bpcGenerate`？倾向后者（封装更干净）。
5. **【while 循环内 evaluateWater 的 ratio 口径】**：每轮末重算 run 进入时同款 triggerTokens 成本高，倾向用 `countConversationTokens(store.messages)` 轻量近似（BPC 容忍误差）。需确认近似是否可接受（影响触发时机精度 ±半轮）。
6. **【compactThreshold 下推 compressContext】**：compressContext 内部 `maxTokens*COMPRESSION_THRESHOLD` 写死（systemPrompt.ts:241），需加 `thresholdRatio` 参（默认兼容）。确认改 compressContext 签名 OK（小改、向后兼容）。
7. **【硬阻塞压缩态的 UI 表达】**：CompressionRing 的「硬压缩阻塞中」态需 BPC-4 在 wasCompressed 分支也 dispatch 一个 UI 态（新增 'hard-compacting'）。确认是否要这一态，还是复用 isCompactingRef + generating。
8. **【BPC 替换后 store 保留段口径】**：BPC 替换时 keepFromIdx 用「BPC 快照锁定的保留轮」还是「run 进入时现算 floorStepToRoundStart(totalSteps)」？倾向现算（与 else 分支 :809 同款，避免快照期与替换期保留段漂移）。
9. **【R-L6 是否做】**（§4 决策默认「可选」）：R-L4+R-L5 已让「压完有上界」，R-L6（BPC 预测驱动折叠）是否还需要？倾向 BPC 稳定后再评估（若熔断从不触发说明 R-L4/5 够，R-L6 可不做）。

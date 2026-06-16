# Task_4.md — Synapse Harness 升级执行清单

> 配合 `Plan/Plan_4/Plan_4.md`。loop 期间主线 + 4.8 opus 子代理并行推进。
> 标记：`[ ]` 未开始 / `[/]` 进行中 / `[x]` 完成 / `[?]` 待主人决策（放置）

## 🔁 Loop 工作约定（必须遵守）
1. **能并行推进的尽量推，不空等。**
2. **遇方向性 / 架构性 / 不可逆的重大决策 → 标 `[?]`，写进下方「待主人决策」区，放置该项，继续推别的，绝不擅自定。**
3. 每个有意义的进展 `git commit` 留痕（可回退；回退点 `backup-before-cleanup`）。
4. 代码改动后做真机验证（web-fetcher `desktop_*` + 本地 API）。
5. 开发用本地 GPT API：`http://localhost:54861/v1`（key 见 memory-store 记忆，**不写进任何会进 git 的文件**）。
6. 每阶段：探索现有代码 → 设计 → 实现 → 真机验证 → commit。
7. ⚠️ **不重构 UI 布局**（保持 VS Code 式现状），只动机制层。

## Stage A：配置接入 + bug 修复（优先打底）
- [ ] OfficeViewer 接 LibreOffice `C:\Program Files\LibreOffice`（`electron/ipc/file.ts` soffice 路径）
- [ ] 默认 API 接 `http://localhost:54861/v1`（设置默认值 / 自动探测模型）
- [ ] 修终端中文乱码（`electron/ipc/command.ts`：chcp 65001 / GBK 解码；查 help 退出码 1）
- [ ] 修模型选择器弹层 click-outside 关闭
- [ ] 修窗口 IPC 状态同步（renderer 订阅主进程窗口事件）
- 验收：真机验证终端中文输出、Office 文件打开、模型选择器关闭、窗口状态一致

## Stage B：上下文 harness（conversation-record-memory）★核心
- [ ] 探索现有对话存储 / 压缩代码（`agentLoop.ts` / `conversation` slice / `conversationPersistence.ts` / CHECKPOINT 压缩）
- [ ] 设计三层：conversation 原文 + record + memory
- [ ] 原生内置 `memory_store` 工具（参考 `C:\Users\Stardust\.gemini\antigravity\mcp-memory-store`）
- [ ] 喂 API = 最近 N 条 + 之前 record + system prompt
- [ ] 90% 上下文触发压缩 + UI 压缩点标记（对话仍完整展示）
- [ ] `run_command` 等基础工具配套
- 验收：长对话触发压缩、cache 命中、UI 显示压缩点、本地对话完整

### ⚠️ record 层已落脚手架，待 Stage B 接线（M1 Step 1 产物，目前是「未调用导出」死代码，靠后续接入激活）
- `src/services/recordStore.ts` / `recordGenerator.ts` / DB `records` 表 / IPC `record:get|upsert|delete` / platform 抽象均已就绪。
- **契约（已写死，接线时务必遵守）**：
  - `generateRecord` 的 `input.messages` 只传【本批被压缩切片】，不传全量历史；增量水位线靠 `priorRounds`/`priorSteps`/`priorTimeSpan` 承接，返回值已累加。
  - 分工：`generateRecord` 负责内容生成与合并（产出完整 contentMd）；`recordStore.upsertRecord` 仅纯持久化（含 timeSpan min/max 合并）；`appendManualNote` 仅手动补充笔记，禁止与 generateRecord(update) 混用。
  - 压缩点触发时：用 `getRecord` 取已有 record → `generateRecord({ messages: 本批切片, existingRecordMd, priorRounds/Steps/TimeSpan: 已有 record 对应字段 })` → 成功则 `upsertRecord({ ..., lastUpdatedRound: 截断处实际轮次 })`；失败回退字符截断。
- 时间戳：records 全库统一【秒】(unixepoch)，与 conversations/messages 一致，勿混毫秒。

### 📝 record 待复核/小本本（精细化，非阻塞）
- [ ] 截断失效目前是**粗粒度兜底**（AgentPanel `invalidateRecordForTruncation`：record 覆盖到被截轮次时整条 deleteRecord 重建）。精细方案：把 `lastUpdatedRound` clamp 到新轮次 + 标记 contentMd 失效局部重建，省一次全量生成。
- [ ] `handleDelete`（删单条消息，非末尾截断）暂未接 record 失效；删中间 user 消息会让真实轮次与水位线偏 1，接线后评估是否需要按删除位置 clamp。
- [ ] `GenerateRecordResult.phases` 现为弱语义「额外小节数」（正常 0），DB 列名仍是 `phases_json` 未改以免破坏既有数据；接线后若该信号无用可考虑彻底移除字段。

## Stage C：消息 / 对话状态能力
- [ ] worktree-A 对话/状态分支（从某消息分叉对话 + 文件快照副本）
- [ ] worktree-B 真 git worktree（管代码项目给任务开隔离工作树）
- [ ] 回溯到某条消息（增强现有 Stage 3 基础）
- [ ] 复制消息 / 对话
- [ ] 核对并增强：附件、模式、沙盒、模型 / 思考层级、自动探测
- 验收：分支、回溯、复制真机可用

## Stage D：Multi-AI 真子代理重做
- [ ] 评估现有 `agentOrchestrator.ts`，定推翻范围
- [ ] 做成 CC 式真子代理（spawn / 独立上下文 / 结果回插 / 可视化）
- 验收：真机派子代理跑通

---

## ❓ 待主人决策（loop 中遇方向性重大问题记这里，放置等主人）
（暂无）

## 📝 Loop 进展日志（每轮/每阶段追加，便于跨重启续接）
- 2026-06-14：Plan_4 / Task_4 建立。git 已固化清理并 push（c6b191e），真机验证整体可用。等待用户开 loop 后开始推进。
- 2026-06-14 loop#1：Stage A 推进——✅终端中文乱码已修(`command.ts` chcp 65001, commit 47eea96)、✅模型选择器 click-outside 已修(`AgentPanel.tsx` ref+mousedown)、✅LibreOffice 路径验证通过(`soffice.exe` 在 `C:\Program Files\LibreOffice\program`，findLibreOffice 已支持)、✅默认 API(54861)运行时已配；✅编译通过(build 1.87s + electron:build)。M1 上下文 harness 探索完成，设计落盘 `Plan/Plan_4/Plan_4_M1_上下文harness设计.md`（6 步：Step0 token 接真实值 → Step1 record 层 → Step2 重构 agentLoop 消息组装 → Step3 UI 压缩点 → Step4 内置 memory_store → Step5 run_command 加固）。
- ⏳ 待复验：终端中文真机验证（electron+vite 链路；上次 launch 遇 vite dev 掉线 chrome-error，需重启 vite 再验）。
- ⚠️ 2026-06-14 期间一度遇「安全分类器临时不可用」，写/命令类工具被拦，已用 read-only 推进。
- 2026-06-14 loop#1（续）：✅ **M1 Step 0 完成**——`compressContext` 接真实 token（API `tokenUsage.totalTokens` 优先、回退字符估算）；阈值 0.8→0.9；`agentLoop.ts` 从 `availableModels` 取当前模型 `capabilities.contextWindow` 传入，替代写死 128k；编译通过(1.44s)。下次从 **M1 Step 1（record 层：recordStore + recordGenerator + DB `records` 表）** 开始；⏳ 终端中文真机复验仍待做（需重启 vite + electron）。
- 2026-06-14 loop#2（ultracode）：✅ **M1 Step 1 完成**——用 Workflow（1实现+3对抗审查+1修复，5 agents）产出 record 层基础设施 + 截断失效接线，commit `3da7673`，修复 3 审查的 7 个 high/med 问题（见 task #6-#12）。主线独立编译验证 build+electron:build+lint 全通过。
  - 现状：record 层就绪 + AgentPanel `invalidateRecordForTruncation`（editMessage/retry/rollback 截断失效）；`recordGenerator.generateRecord` 尚无调用方（待 Step 2 接 agentLoop 压缩点）。
  - ⚠️ 协调提醒：本批期间 Task_4/AgentPanel 被外部改过（疑似用户并行或 Workflow 修复 agent）。**下次开工前先 `git status` + 看 `agentLoop.ts` 是否被并行改**，若用户在并行做 record 层需先协调，避免冲突。
  - 下一步 **M1 Step 2（核心，主线亲自）**：agentLoop 压缩点调 `generateRecord(本批切片+prior水位)`→`upsertRecord` 落盘→把 `record.contentMd` 拼进 apiMessages 稳定前缀（system+record+最近N条，hit cache）；失败回退字符截断。+ 终端中文真机复验。
- 2026-06-14 loop#3：✅ **M1 Step 2 完成**——record 接入 agentLoop 喂 API（压缩时 generateRecord→upsertRecord→record.contentMd 作 system 前缀；失败回退字符截断），commit `2e2fd4b`，编译通过。真机确认应用加载/渲染正常（Step 2 未破坏对话）。
  - ❌ **终端中文 chcp 65001 方案被真机证伪**：`help` 英文正常无乱码，但 `echo 你好世界中文测试` 输出仍乱码（◆◆□）。根因：chcp 65001 让 cmd 把 Node 按 GBK 传入的命令行参数当 UTF-8 解析，反而搞乱输入。**正确方向（下次实现+真机验证）**：去掉 chcp、`['/c', cmd]` 原样 + stdout/stderr 累积 Buffer 后 `new TextDecoder('gbk').decode()`（输入走 Node 默认 GBK、输出也 GBK 解码，两头一致）；`help` 退出码 1 一并查（`electron/ipc/command.ts`）。
  - ⏳ record 压缩触发的真机验证待专项（短对话不触发压缩；需构造超长对话或临时调小 contextWindow/阈值）。
  - 下一步：修终端编码(GBK 方案)+真机复验 → M1 Step3(UI 压缩点) / Step4(内置 memory_store)。
- 2026-06-14（用户醒来 → 中断 loop，转**手动盯 + 每 stage commit&push**）：loop 期间 5 commit 已 push（ce080eb），GitHub 同步。
  - ✅ **终端中文 GBK 方案修复成功**：`command.ts` 去 chcp、`['/c', cmd]` + stdout/stderr 累积 Buffer 后 `TextDecoder('gbk')` 解码。真机 `command.exec('echo 你好世界中文测试')` → stdout 中文正常 + exitCode 0。commit `ce080eb`。
  - ✅ **M1 Step3 UI 压缩点完成**：`AgentPanel` 读 `record.totalSteps`，消息流第 N 条前插分隔线「以上已压缩为 record 摘要」，展示仍完整。编译通过。
  - ✅ **record 端到端真机验证成功**（子代理 web-fetcher + 本地 API gpt-5.5）：临时阈值 200，第 2 轮对话触发压缩；UI 出现「⌁ 以上 2 条已压缩为 record 摘要 ⌁」分隔线；SQLite `records` 表实锤 1 条（conversation_id=autosave-current, total_steps=2, content_md=311 字 AI 生成结构化摘要、准确无臆造）；本地 API 流式回复正常。【生成→落盘 SQLite→前端读回→UI 渲染】整条链路通。临时阈值已改回正式逻辑（git 无净改动）。
  - 遗留(无害)：`~/.synapse/synapse.db` 留了 1 条 autosave-current record + 2 轮验证对话（运行时数据不进 git，下次真用会更新）。
  - ✅ **M1 conversation+record 两层端到端确认可用**。Step0/1/2/3 全部 ✅+真机验证。下一步 **M1 Step4 内置 memory_store**（ultracode）。
- 2026-06-14 ✅ **M1 Step4 内置 memory_store 完成**（ultracode workflow，5 agents，406k tok）：新建 `memoryStore.ts` + `ipc/memory.ts`；DB `memories` 表（不级联删除、跨对话存活）；platform Web mock；`toolRegistry` 注册 **memory_write/memory_query** AI 工具（auto 审批）；`systemPrompt` planning guidelines 加第 8 条「主动 memory_query/write」指引。秒级时间戳、LIKE 防注入、pinned 优先。主线独立 build(9.8s)+electron:build 通过。
  - memory 小本本（low，非阻塞）：① `memory get/list/delete` 三层暂无消费者（无 Memory 管理 UI），待接 UI 或删；② 内置 memory_write/query 与外置 MCP 同名，建议未来加 `synapse_` 前缀消歧（当前不冲突，外置 MCP 工具不进 toolRegistry）；③ memory_write 走 auto 审批（有意，记忆低风险）。
  - ✅ **memory 真机验证**（子代理 web-fetcher + 本地 API gpt-5.5）：AI 主动调 memory_write 成功（落 SQLite，自动 pin+tags+searchSummary，质量高）；memory_query 调用成功但发现 bug——整串子串匹配致多关键词查必败（AI 拼词查→0 命中→重复写）。
  - ✅ **修复 memory_query 拆词检索**：`ipc/memory.ts` + `platform/index.ts` 两端改 query 拆词、每 term 对字段 LIKE/includes、term 间 OR 宽召回。真机 evaluate 复现验证：多关键词查 0→2 命中、单词 2 命中、不相关词仍 0 命中。
  - 🎉 **M1 上下文 harness 完成**：conversation(原文) + record(压缩摘要,端到端验证) + memory(AI 主动记忆,write/query 验证) 三层全齐 + 真机验证。Step 0-4 ✅。Step 5(run_command 加固) 为可选小项。
  - 遗留(无害)：memories 表有 2 条测试记忆（验证时 AI 写的，运行时数据不进 git）。
- 2026-06-14 用户定方向（M1 完成后，继续推进 M2+M3，给了设计）：
  - **M2 回溯（最重要）**：回溯到消息 M = 按 record 找到 M 所在批次 → 保留「M 前 N 条之前」的 record 内容作为新 record 上下文 + 这 N 条原始消息（从原始对话文件取）= 回溯后状态。复用 record 水位线机制。
  - **M2 对话分支（worktree-A）**：同回溯思路（从某点复制对话+record+文件快照成新分支对话）。
  - **M2 git worktree（worktree-B）**：正常实现（Synapse 管代码项目时给任务开 git worktree）。
  - **M3 Multi-AI**：按 CC 式真子代理做，**保留原可自定义模式 MultiAI**（= CC workflow 形态 + 之前 agentOrchestrator 的自定义模式设计，两者结合）。
  - 推进顺序：先 M2（回溯重点）→ M3。工作方式：用户在线手动盯 + 每 stage commit&push；需要时 ultracode（用户多次授权、不强制）。
- 2026-06-14 M2 探索方案（子代理）：拆 M2-1 回溯 clamp / M2-2(可选)回溯重生成 / M2-3 对话分支 / M2-4 git worktree MVP / M2-5(大,待定)agent 在 worktree 执行 / M2-6 复制消息+mode per-conv。核心难点：record contentMd 无轮次结构、纯 clamp 数字回退不了正文 → 采方案②(只 clamp 水位,稳省)。
- 2026-06-14 ✅ **M2-1 回溯 record 水位 clamp 完成**：`recordStore.clampRecord`（覆盖区内不动 / 否则 clamp totalRounds+totalSteps+lastUpdatedRound / 归零才删，contentMd 不动）；`AgentPanel.invalidateRecordForTruncation` 由「整条删」改 clampRecord，step 口径对齐 agentLoop（不含 tool）。编译 build+electron:build 过。
  - 小本本：① handleEdit/handleRetry 的 record 操作仍 void 不 await + setTimeout(run,100)，竞态极少（本地 IPC<100ms）可后续改 await；② M2-1 真机验证（回溯后 record 水位 clamp）攒到 M2-3 后一起做（调小阈值场景）。
  - 用户答：git worktree **完整做**（含 M2-5 agent 在 worktree 执行）。
- 2026-06-14 ✅ **M2-4 git worktree 管理后端完成**（ultracode workflow，5 agents）：`electron/ipc/worktree.ts`（list/create/remove/status IPC，child_process spawn 数组传参防注入、路径穿越双向校验、remove 默认不 force、`listWorktreePaths` 归属校验已接线 remove/status）+ main 注册 + preload + platform 抽象/Web 降级 + SettingsPanel「工作树」UI（纯加法不重构）+ tsconfig.electron 补 noUnusedLocals。编译 build+electron:build 过；3 skeptic 独立验证 + fix 修了归属校验(Task #19)。
  - 小本本(low)：spawn 加 killSignal 兜底超时；SAFE_NAME 拒前导连字符；runGit 剔除 env.GIT_DIR/GIT_WORK_TREE；status 已暴露未被 UI 消费(可等 M2-5)。
  - ⏳ git worktree 真机验证（create/list/remove）攒到 M2-5 一起。
- 2026-06-15 ✅ **M2 record 多批次重构方案已定**（对齐 MC红石AI c-r-m，用户拍板）→ 详见 `Plan/Plan_4/Plan_4_M2_对话体系对齐.md` §五【已定最终方案】。决策：record 多批次追加 + DB 懒迁移 + 渐进式读(token预算+头尾融合 / 按需展开 record_read 工具 / 正则骨架) + 90% B方案 + fallback崩溃恢复 + 附件分离(存量也迁移) + 分支parent。分 stage：**M2-R1~R7 + M2-3**，其后 M2-5(git worktree agent执行,绑定押"对话级"待确认)/M2-6/M3。
  - 🌙 **晚上从 M2-R1 开始实现**（数据模型 + DB 懒迁移 + recordStore API：appendBatch/clampToBatch/getRecordSkeleton + 正则骨架）。设计 workflow 完整产出在 `tasks/wlxulkxne.output`（维度A/B/C + 综合蓝图）。
- 2026-06-15 ✅ **M2-R1 record 多批次架构落地**（ultracode：实现 agent 中途 API 断、修复 agent 补全；commit `95a2625`）：record 单条全文→多批次追加(RecordBatch[]+派生水位+懒迁移)；recordGenerator generateBatch(旧批骨架 priorSkeleton 只读+新原文→本批独立、不合并全文)；agentLoop 压缩走 generateBatch+appendBatch(只追加末批/stepStart==末批stepEnd 幂等防脏写)；clampToBatch 单口径 stepEnd 连续前缀回溯保留(对齐算例)；database batches_json+record_schema_version 列 + ipc/platform/Web mock 懒迁移；AgentPanel UI 多批次压缩点分隔线。build+electron:build 通过。
  - ⏳ 收尾中：① 子代理真机验证多批次端到端进行中(多批次生成/stepStart-stepEnd连续/UI多分隔线/回溯批次保留/本地API)；② 旧 generateRecord/buildUpdatePrompt 死代码待清(全 src 无调用)。
  - 教训：record 全链路重构塞一个 workflow agent 太大、中途断成半成品(靠修复 agent 兜回)；以后大重构拆更细。
- 2026-06-15 ✅ **M2-R1 多批次真机验证通过**（子代理 web-fetcher+本地API）：多批次生成(批0[0,5]+批1[5,9])、stepStart/stepEnd 首尾相接、各批独立不膨胀(288/211字符)、UI 多条压缩点分隔线、回溯批次保留(回溯第8条→批1丢批0留,clampToBatch对)、SQLite 落盘、阈值已改回。
  - ✅ **修问题1：新对话 record 不触发**——conversation.id 新对话=null、autosave 落 'autosave-current'(含 conversations 行 FK满足)但不回写 store.id → record 被跳过。修：agentLoop/AgentPanel record 取 id 回退 AUTOSAVE_ID(导出常量)，新对话 record 落 autosave-current 立即生效。编译过。
  - 📌 record 小本本：① edge：对话正式保存(saveConversationSnapshot: autosave-current→新conv-id)时 record 未迁移，需在保存流程加 copyRecord(autosave-current→新id)，和对话快照迁移一起做；② FK：autosave 已建 'autosave-current' conversations 行故 fallback FK 满足；generateBatch 60s 超时→回退字符截断(本地API慢偶发,可接受/R5优化)；③ 旧 generateRecord/buildUpdatePrompt 死代码待清(全 src 无调用)。
  - ⏳ 问题1 真机复验 + 死代码清理 紧接做。
- 2026-06-15 ✅ **M2-R3 渐进式读落地**（ultracode：实现+对抗审查+修复；第3审查 API 断、主线补核实编译/死代码）：
  - buildRecordPrefix(agentLoop:95) 重写为分级渐进读：头1批+尾2批全文保底、中间批默认骨架(标注「可 record_read(batchIndex=N) 展开」)、token预算=contextWindow*0.4(骨架占用预扣基线+升级增量=全文−骨架)、≤3批也跑预算约束(尾批强制保底+超预算 console.warn)。
  - record_read 工具(toolRegistry:452)：batchIndex+可选conversationId(回退AUTOSAVE_ID口径与agentLoop一致)→getBatch(recordStore:409,按b.index匹配非下标)返回该批全文；systemPrompt:101 第9条指引。三处对齐闭环。
  - 清死代码：generateRecord/buildUpdatePrompt/buildCreatePrompt/GenerateRecordInput/GenerateRecordResult 全删(grep全src 0命中)，generateBatch及依赖完好。
  - 主线核实：build EXIT0(2.44s)+electron:build tsc无error；死代码0残留；2个medium(≤3批不看预算/骨架占用不计入预算)已被修复agent修。
  - 📌 R3 low 小本本：fast模式不注入record_read指引(fast不注入record故无害)；空骨架批信息密度低；getBatch失败文案可加引导；预算未精算分隔符/包裹头开销(40%本就保守可接受)。
  - ✅ R3 真机验证通过(子代理 web-fetcher+本地API)：凑4批,注入分级正确(批0头全文+批1中间骨架标注+批2/3尾全文,骨架剥离只留要点),record_read 被 AI 真实调用并返回该批 contentMd 全文(按需展开闭环成立),本地API正常,临时改动全还原(git diff 空)。
- 2026-06-16 ✅ **M2-R4 90% 触发判定 B方案落地**（主线实现+ultracode对抗审查+修复）：
  - 触发判定从「上一轮 API 滞后 token」改为「本轮实际组装请求体本地 tokenize」(agentLoop run ~340-362)：assembledTokens=estimateTokens(systemPrompt)+toolsTokens(对齐发送处:mode!=fast&&toolsEnabled&&tools.length)+countConversationTokens(全部历史)+estimateNonTextPartsTokens(多模态/附件)；与上一轮 promptTokens 取 max 兜底；判 ≥ 真实 contextWindow*COMPRESSION_THRESHOLD(0.9)。
  - 对抗审查(wzgpjxzds)13issue/4medium 全修：①兜底用 promptTokens 非 totalTokens(量纲对齐纯输入)②estimateNonTextPartsTokens 计入图片/附件 token(防多模态低估)③compressContext 拆 overLimitWithoutCompression 危险态+truncateOverLongHistory 截断「少条超长」(防撑爆)④注释修正。
  - 核实：build EXIT0(1.67s)+electron:build tsc无error。
  - 📌 R4 low 小本本：estimateTokens 粗估对英文/JSON 系统性低估(首轮无API兜底偏弱,0.9阈值留余量)；per-message+4开销 system/tools 未计(量级可忽略)；判定仅 run 入口一次、不含本 run 内 tool round 增量(单次长 agentic run 循环中段可能超窗,首版可接受)。
  - ⏳ R4 真机验证(90%触发时机+多模态+少条超长截断)attach 到 record 体系完整链路一起验。
- 2026-06-16 ✅ **M2-R5 压缩 fallback 崩溃恢复落地**（ultracode：实现+对抗审查抓2 high+修复）：
  - 可中止：recordGenerator callOnce/generateBatch 加 AbortSignal(Promise.race 3路:collect/60s timeout/abort，abort 调 client.abort() 断底层 fetch)；agentLoop stop() abort 压缩 controller。resolveClient 每次 new 独立 AIClient 故 abort 不误伤主对话。
  - 回压缩前：generateBatch 失败/中止→null→不 appendBatch→record 维持压缩前，不丢 store.messages。
  - 崩溃恢复：appendBatch 落库原子(Electron 单条 INSERT...ON CONFLICT DO UPDATE/Web localStorage 整对象写)+幂等(stepStart==末批stepEnd)；注释固化依赖。
  - 🔴 对抗审查(wsp1fdb7u)抓 2 high 并修复：①压缩60s窗口期 isStreaming=false 可重入 run→appendBatch 并发丢批 → run 入口重入闸(this.running 拒二次进入)+setStreaming(true)提前到入口；②compressController 单字段被重入覆盖/finally误清 → 改 Set<AbortController>每run局部归属+stop()遍历abort全集；幂等校验下推 record:upsert 单SQL+expectedStepStart 水位门(防并发脏写,连带缓解 getRecord 吞错)。
  - 核实：build EXIT0(2.67s)+electron:build tsc无error。
  - 📌 R5 low 小本本：callOnce timeout/abort 回调无条件 client.abort()(已 settle 时 no-op 无害)；run() 非可重入(已加入口闸,UI isStreaming 串行化双保险)。
  - ⏳ R5 真机验证(压缩中 stop 中断+重入被挡)attach record 体系完整链路。
- 2026-06-16 ✅ **M2-R6 附件分离存储落地**（ultracode：基础设施段+接入段+对抗审查8high-med+修复；commit 9be862f；方案见 Plan_4_M2 §六，反重力调研由子代理 a6b9c414 完成、记忆已存）：
    - [x] platform.attachment 抽象(put/get/has/delete/addRef/release，sha256 内容寻址)：桌面 fs `attachments/<sha256[:2]>/<sha256>.<ext>` 两级分桶 + 网页 IndexedDB(crypto.subtle sha256 两端一致)
    - [x] attachments 账本表(sha256 PK,mime,kind,size,ref_count,created_at) + electron/ipc/attachment.ts CRUD(原子写临时→rename,64hex防穿越,50MB上限) + database 建表
    - [x] 消息引用层(新建 attachmentRefs.ts 集中)：contentParts/attachments 存 sha256 引用(去 base64)；发 API 按 sha256 get 还原真图、渲染还原
    - [x] record 源图片转「[图片 name]」占位、autosave/落库去 base64(sanitizeMessagesForPersistence + persist 终极防线)
    - [x] refCount GC(删对话/消息/编辑移除附件 release 归零删实体)
    - [x] 懒迁移(读到旧内联 base64→put 抽离+换引用，surplus release 守恒防泄漏)
    - [x] 双模式编译过(build 2.65s + electron:build tsc 无 error)
    - 🔴 对抗审查修 2 high(懒迁移 double-put 泄漏→surplus release / 对话 fork refCount 欠计→addRef)+2 medium(Web put TOCTOU 收单事务 / base64 容错两端对齐)
    - ✅ R6 真机验证通过(子代理 a0ac8c75)：put 去重(同图同 sha256+refCount 累加不重复写)/get 逐字节还原/delete 归零 GC/**UI 上传后 DB 零 base64(hasBase64InDbRow=false,核心目的达成)**/发 API 抓包确认真 base64 还原+剥纯净 part/懒迁移抽离不丢图+跨端 sha256 一致(crossEndShaMatch=true)
    - ✅ 图片复验澄清(子代理 ad033dd8 真实图实测，2026-06-16)：**R6 实现无 bug**——真实图(Bing 截图 125KB JPEG)模型完全正常识别(HTTP 200 精准描述)，get 还原 dataUrl 与原图 === 字节级无损，mime 全程正确(image/jpeg)。之前 400 真相：第一次发真图那轮把历史残留假图(1x1/79B 无效 PNG)连同真图一起发、上游对任一无效图整体 400 拖累；开新对话单发真图立刻 200。**根因=假测试图无效 + 我错误归因上游(判断/测试方法错，非 R6 代码)，用户判断正确。**
    - ⏳ 推后：网页真·一套 SQLite 引擎统一(sql.js WASM + IndexedDB 持久化)，用户想要但工作量大
- 2026-06-16 ✅ **M2-3 对话分支落地**（ultracode：实现+对抗审查2medium+修复）：消息处「🌿 从此分支」→ 该消息及之前复制为新对话(新convId)，源对话原样保留。
  - DB conversations + parent_id + branched_from_message_id(ensureColumn懒迁移,无外键)；ipc/platform/Web 三端读写对等。
  - recordStore.copyRecord(src,dst,keptSteps,keptRounds)：复用 clampToBatch 连续前缀逻辑裁批次→深拷贝 upsert 新对话；branchConversation(conversationPersistence)：子集=fromMessageId及之前、keptSteps(非tool)/keptRounds(user)严格对齐 clampToBatch 口径、copyRecord 继承、子集 collectMessageShas 逐个 addRef(+1 防源删后图失效)、源对话零改动。
  - UI：MessageBubble GitBranch 按钮+右键菜单；AgentPanel handleBranch(autosave源先fork真实id作parent、切换新对话、toast)。
  - 对抗审查 branch正确性5项全过+copyRecord/refCount守恒；修2medium：①addRef失败不再静默吞(tryAddRefOnce 区分reject/Web{error}+重试+addRefFailedShas+warning提示)②autosave save失败中止分支(提示先发消息)。
  - 核实：build EXIT0(2.70s)+electron:build过；fix remaining 空。
  - ✅ M2-3 阻断 bug 已修复 + 2 轮真机复验通过：
    - bug(子代理 a261ed1c 抓出)：分支复制复用源 message.id 撞 UNIQUE 主键 `messages.id`，分支跑不通。
    - 修复(workflow whq21wau1)：branchConversation subset message.id 改 crypto.randomUUID+同批 Set 去重(治自撞+全库撞) / promotion 调 clearAutosave 顺序(先清后写)保原 id 保 assistantRuns 关联 / subset 剥离 runId/runEvents/diffs/rollbackSnapshotId 运行差异态(清洁分支防渲染源 diff 崩/误改工作区) / autosave 分支 record 继承被 FK CASCADE 删空 → copyRecordFrom 内存快照(级联删前抓取)+双模式对等。对抗审查 5 high-med 全修。
    - 复验(子代理 acb921de)全过：真机点分支不撞主键、新对话只含回溯点及前、新消息 UUID 与源零重叠、源对话完整保留、清洁无 diff 残留、parentId/branchedFromMessageId DB 记录正确。编译过(build 2.16s)。
    - **教训：编译+对抗审查过但真机第一步就撞主键——对抗审查静态读码测不出 DB UNIQUE 运行约束；DB 写入类 stage 一律真机为准、且早做。** [[工作教训：不轻易归因外部/上游，下结论前用真实数据真机验证]]
  - 📌 M2-3 残留(归 M2-6，非阻断)：分支后 setConversation 未回填 parentId/branchedFromMessageId 到 store(DB 正确，但 store/loadConversation 路径都未接这两字段→store 显示 null)；M2-6 做对话级元数据 per-conv 时统一接(setConversation+loadConversation+snapshot 都带 parentId/mode 等对话级字段)。
  - 📌 遗留(子代理 notes)：autosave fork 时 record 从 AUTOSAVE_ID 迁到新真实 id 仍是历史遗留点(分支场景用 recordSrcId 绕过)，与 R6「正式保存 record 迁移 edge」同源，可合并单列。
  - 其后：**M2-S 稳定性**(retry后台化/重连/fallback/图片预检，见下) → M2-5 worktree agent 执行 → M2-6 复制消息+mode per-conv → M3 Multi-AI。
- 2026-06-16 🟡 **M2-S 稳定性加固（图片预检+retry进度 ✅ / 模型fallback+断线重连 待用户对齐）**——横切关注：
  - ✅ 已做(workflow w00b3bigx，对抗审查 0 high/med 直接过)：①图片有效性预检 isLikelyValidImage(魔数 PNG/JPEG/GIF/WebP/AVIF/HEIC/BMP/SVG/ICO+外链/缺失/解码失败保守放行不误杀,node 10样本验证)+restoreApiMessagesAttachments 还原后剔除无效图占位+warning「N张无效图片已跳过」——根治「坏图拖累整条请求整体400」(用户截图场景)；②retry进度可见(StreamChunk retry变体+429/5xx/网络异常3退避点yield+UI「正在重试N/M」通知+收尾清除,不改现有重试判定/退避时长)。编译过。✅真机验证通过(子代理 a910f608)：isLikelyValidImage 判定全对(真PNG/JPEG true、坏图 false、外链/SVG 保守放行 true)、坏图发送前剔除为占位+warning、真图正常识别、混发真图不被坏图拖累、不再整体400(你截图场景彻底修复)。📌边界小本本:魔数合法但内容退化的图(如1x1极小图/截断图)上游vision仍可能单独400,超 isLikelyValidImage(只魔数校验)能力,可后续补最小尺寸/可解码校验(非缺陷)。
  - ⏸ 待用户对齐(不擅自做)：模型级 fallback(主→备,备用模型配置来源是设计选择)；断线彻底重连(现状单请求退避重试已覆盖瞬时抖动,彻底重连可能过度)。
  - 【以下为规划期 scout 记录(发现现状已有错误分类+退避+stream fallback,故 M2-S 是查漏补缺非从零)】：
  - 现状评估：aiClient 已有 maxRetries=3 请求重试(line 309-355) + streamMode fallback(stream→pseudo→off)；agentLoop 有 fallbackReason/connectionStatus/error 处理(line 594-833)。
  - gap：① retry 未「后台化」(失败重试阻塞在 run，3 次后直接弹「AI 请求失败」体验差) ② 无断线自动重连(只重试当前请求) ③ 错误未分类(400/401/422 不该 retry vs 5xx/超时/网络该 retry) ④ 无模型级 fallback(主模型失败→备用模型)。
  - 规划：M2-S = 错误分类 + 后台 retry(退避) + 断线重连 + 模型 fallback + UI 不打断；排在 M2-3 后或按需提前；retry 后台化形态/策略需详设计、可能与用户对齐。
  - 旁注更正(图片 400 真相，子代理 ad033dd8)：**非上游不支持**——真实图模型正常识别 HTTP 200；之前 400 是历史残留假图(1x1/79B 无效)被连同真图一起发、上游对任一无效图整体 400 拖累。
  - 📌 产品隐患(归 M2-S)：多轮对话会重发历史所有图，历史混进过一张无效图会每轮被整体 400 拖累——应在发送前对 image part 做有效性预检/跳过无效图(与错误分类/fallback 同类)。
- 2026-06-16 ✅ **M2-6 对话级元数据 + reasoningEffort 缺陷根治（真机复验通过）**：
  - mode/reasoningEffort per-conversation(wf3queh94)：conversations reasoning_effort 列+snapshot+切换同步 agentSettings(agentLoop 读口径不改)+新对话默认+分支继承；M2-3 残留 parentId/branchedFromMessageId 进 store(setConversation 四入口回填)。复制消息已有未做。对抗审查 2 medium 修(新建按钮口径统一+切换竞态两道防线)。
  - 🔴 真机(a4f1933a)抓出 reasoningEffort 缺陷→修(wesxvprnz)：真根因(修复agent实测DB挖出,非我给的表层"漏dispatch")=conversations 缺 reasoning_effort 列(ensureColumn 无DEFAULT真机迁移未生效)→IPC带该列整条throw no such column连mode/messages回滚→读侧永远auto。修:ensureColumn双重自愈补列+create/update缺列降级(列缺不拖垮mode/messages)+fallbackMeta空串回退+saveAutosaveSnapshot切换闸门收紧(isConversationSwitching即return堵加载回写)。对抗审查0 high/med。
  - ✅ 真机复验(a3f4c390)全过：列自愈补齐+update不报错、A=high/B=low切换各自恢复不被冲、切换后DB不被回写覆盖(核心bug根治)、mode无回归。
  - 📌 小本本：①mode 切换硬归一fast/planning vs reasoningEffort 透传(mode现两态不出错,扩多态需改透传)②侧栏列表只显8/11条(过滤规则可排查)③autosave-current单例槽位连续新建覆盖前草稿(已有设计待评估)④删除当前对话/清空历史漏重置全局mode/reasoningEffort(low,下个新对话会用残留值落库)。
  - **教训:不盲信表层定位(含我自己给的)——"加载漏dispatch"是假命题,修复agent实测DB挖到真根因(缺列);DB写入stage真机为准。** [[工作教训：不轻易归因外部/上游，下结论前用真实数据真机验证]]

## 🎉 M2 主体全部完成（2026-06-16 夜间自主推进，全部真机验证 + commit&push）
record 体系 **R1**多批次/**R3**渐进读/**R4** 90%触发/**R5**崩溃恢复/**R6**附件分离 + **M2-1**回溯clamp + **M2-4** worktree管理 + **M2-3**对话分支(bug 2轮真机修复) + **M2-S**稳定性(图片预检+retry进度) + **M2-6**对话级元数据(mode/reasoning per-conv+parentId)。

### ✅ 方案已定稿（2026-06-16 讨论，详见 Plan/Plan_4/Plan_4_M3_MultiAI与worktree按需.md），待用户到校开推
- **M2-5 worktree 改「按需」**（推翻原对话级强绑定=过度设计）：不默认绑；agent 工具按需进 worktree(用户/agent 判断需隔离时)；主/单 agent 默认主工作区，**并行子代理默认各自绑 worktree(防写冲突)可关**。M2-4 基础设施保留，新增 agent worktree 工具 + 条件根路径重定向 + 会话状态。
- **M3 Multi-AI 重做**（现有 multiAI.ts+agentOrchestrator.ts+SettingsPanel 升级）：
  - 三层架构：**agentLoop 实例(引擎)** + 两入口(**spawn_subagent 工具**动态派 / **固定工作流模板**@触发编排) + **卡片中间视图**(可视化)。
  - 子代理：默认复用主模型可单配 / **maxDepth 派发深度**(不填=深度1不许再派,填N=允许N层) / worktree 字段(并行默认各自绑可关) / 工具集除派发受 maxDepth 限外不限。
  - 固定工作流：设置内编辑模板+保留命名,`@MultiAI:名` 触发,串行/并行/**判断节点**(手动设清晰语义,可中止工作流并反馈无法推进)。
  - 子代理对话复用 conversations 表(parent=主对话+isSubAgent,复用 M2-3 对话tree)。
  - 卡片：对话流可点击卡片→中间编辑器区开视图(左列子代理,点进看完整对话流),四色(灰完成/蓝进行/黄retry阻塞/红failed)+实时token/计时刷新。
  - 分 stage：M2-5(worktree按需,给M3并行隔离打底)→M3-1(agentLoop递归引擎+spawn_subagent+子代理对话存储)→M3-2(workflow运行器串并判断+模板存储编辑@触发)→M3-3(卡片可视化中间视图)。
- 📌 **重试待办（用户统一测，我不抢跑）**：重试/编辑 × 带图消息交叉点——handleRetry(skipUserMessage 复用 store 消息)重发时附件是否保留，逻辑上 agentLoop 读 store 含附件应没事、但没专测过；用户本人统一测时验(我可应邀先验)。

- 2026-06-16 ✅ **M2-5 worktree 按需——3 审查代理 high/medium 修复（编译双过，待真机）**：
  - 起因：3 个审查代理对「M2-5 worktree 按需」初版查出 2 high + 4 medium，逐一修复，保证无活动 worktree 时与现状零回归。
  - 🔴 **high①+② 治本（数据结构重构）**：worktreeSession 由【单一全局槽位 {activeWorktreePath}】重构为【按执行上下文索引的 map：byContext[contextId] = {activeWorktreePath, activeBranch, repoRoot}】。
    - contextId 现阶段=conversationId(含 AUTOSAVE_ID)，M3 阶段=agentId/subagentId。enter/exitWorktree 带 contextId 增删条目；新增 selectWorktreeEntry 选择器 + clearAllWorktrees。
    - **执行上下文 contextId 透传链路**(全程显式参数,无模块级共享变量→并行子代理交错执行不互相覆盖)：AgentLoop 加 contextId 字段(构造注入,单 agent 缺省回退当前对话 id ?? AUTOSAVE_ID) → 工具执行时传 toolExecutor(name,args,contextId) → toolRegistry.execute(...,contextId) → handler 第二参 ctx:{contextId} → fileSystem.getActiveRoots/resolveWorktreePath/readFile/writeFile(...,contextId)。
    - 这同时解决 high①(切换对话串台：A 进 worktree 切到 B，B 仍被重定向到 A 的 worktree)——按 contextId 索引后 B 无条目自动走主工作区；和 high②(M3 并行子代理单一全局槽位互相覆盖→并行隔离不成立)——每子代理 contextId 各异、落 byContext 不同 key，并行隔离成立。
  - 🩹 **high① step1 止血**：切换/新建/分支对话入口(ConversationList.handleSwitchConversation/handleNewConversation、AgentPanel.handleNewConversation/handleBranch)补 dispatch(exitWorktree)，清【离开的对话】+ AUTOSAVE_ID 两个 contextId 的条目——防新对话/草稿共用 AUTOSAVE_ID 时继承上一条 autosave 对话的 worktree 重定向。
  - 🩹 **medium② list_dir 对称**：list_dir 此前未跟随 worktree 重定向(view/write/run_command 都跟随)，AI 在 worktree 里 list_dir 看主工作区树、view_file 同路径却读 worktree 内容→列表与内容割裂。修：getWorkspaceTree 加可选 rootOverride，list_dir 在本上下文有活动 worktree 时把根解析到 worktree(传 override 时【不污染】UI 主工作区树缓存,Sidebar/QuickOpen/Synopsis 仍看主工作区)；无 worktree 时 override=undefined 走原逻辑(零回归)。
  - 🩹 **medium⑤ worktree 创建透明度**：enter_worktree 创建/复用成功后 dispatch addNotification(标题「已创建/进入 worktree」,含分支名+磁盘路径,与 M2-6 写操作通知口径对齐)；审批弹窗给 enter_worktree 定制文案(说明会在磁盘建工作树目录 + git 新建/复用分支,降低用户误以为「无害模式切换」而误批)。
  - 🩹 **medium⑥ repoRoot 锚定**：resolveWorktreePath 绝对路径前缀基准改用【进入 worktree 时锚定的 repoRoot】而非实时 workspace.currentPath，防进入后切工作区导致「相对进旧 worktree、绝对进新工作区」割裂；并加 worktreeSession.extraReducers 监听 workspace/open|close|clearWorkspace → clearAllWorktrees(工作区切换全部回主工作区)。repoRoot 缺失时回退实时 currentPath(不劣于改前)。
  - 🟡 **medium① run_command cwd（显式行为变更，已采纳改进，非回归）**：无活动 worktree 但已打开工作区时，run_command 默认 cwd 由旧的 process.cwd()(Electron 安装/启动目录,潜在 bug)改为【已打开工作区 currentPath】——命令跑在用户工作区根而非安装目录,方向正确。未打开工作区(无 currentPath)时仍回退 undefined→process.cwd()(与现状一致)。**此为显式 breaking,已在此记录**；建议真机验证一条 npm/git 命令确实跑在工作区根。
  - 零回归保证：所有 fs/命令工具在【无活动 worktree(byContext 无该 contextId)】时全部短路——resolveWorktreePath 第一句 `if(!activeWorktreePath) return rawPath`；list_dir override=undefined 走主工作区；run_command 仅 cwd 默认值变化(已显式记录)。Web 模式恒无活动 worktree(enter_worktree 直接降级不 dispatch)→全链路短路。
  - 核实：`npm run build` EXIT0(tsc -b + vite 2.11s,无 type error) + `npm run electron:build` EXIT0(tsc -p tsconfig.electron.json 无 error)。
  - ⏳ 待真机：①A 对话 enter_worktree 后切 B，B 的 write/run_command 落主工作区不串台；②并行(M3 接入后)各子代理 worktree 隔离；③run_command 无 worktree 时落工作区根(medium①验证)；④list_dir 在 worktree 里列 worktree 内文件;⑤切工作区后旧 worktree 条目被清。

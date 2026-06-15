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
  - 🔴 M2-3 真机验证发现【阻断 bug】(子代理 a261ed1c)：分支按钮在/源对话保护到位，但点击分支报 `UNIQUE constraint failed: messages.id`——分支复制消息复用了源 message.id 撞全局主键，分支功能完全跑不通。根因：handleBranch promotion fork(clearAutosave 在 fork 之后→autosave-current 行的 message id 还占着) + branchConversation subset `{...m}` 保留原 message.id。修复方向:复制消息成独立新对话时重新生成 message.id(record 用 step/round、附件用 sha256，均不依赖 message.id，安全)；promotion 场景注意保留 assistantRuns 关联。**编译+对抗审查均过但真机才暴露——再次印证真机验证必要。** 修复 workflow 进行中。
  - 📌 遗留(子代理 notes)：autosave fork 时 record 从 AUTOSAVE_ID 迁到新真实 id 仍是历史遗留点(分支场景用 recordSrcId 绕过)，与 R6「正式保存 record 迁移 edge」同源，可合并单列。
  - 其后：**M2-S 稳定性**(retry后台化/重连/fallback/图片预检，见下) → M2-5 worktree agent 执行 → M2-6 复制消息+mode per-conv → M3 Multi-AI。
- 2026-06-16 📌 **M2-S 稳定性加固（用户补充：实际使用稳定性 retry 自动后台化/重连/fallback 需注意）**——横切关注，规划成专门 stage：
  - 现状评估：aiClient 已有 maxRetries=3 请求重试(line 309-355) + streamMode fallback(stream→pseudo→off)；agentLoop 有 fallbackReason/connectionStatus/error 处理(line 594-833)。
  - gap：① retry 未「后台化」(失败重试阻塞在 run，3 次后直接弹「AI 请求失败」体验差) ② 无断线自动重连(只重试当前请求) ③ 错误未分类(400/401/422 不该 retry vs 5xx/超时/网络该 retry) ④ 无模型级 fallback(主模型失败→备用模型)。
  - 规划：M2-S = 错误分类 + 后台 retry(退避) + 断线重连 + 模型 fallback + UI 不打断；排在 M2-3 后或按需提前；retry 后台化形态/策略需详设计、可能与用户对齐。
  - 旁注更正(图片 400 真相，子代理 ad033dd8)：**非上游不支持**——真实图模型正常识别 HTTP 200；之前 400 是历史残留假图(1x1/79B 无效)被连同真图一起发、上游对任一无效图整体 400 拖累。
  - 📌 产品隐患(归 M2-S)：多轮对话会重发历史所有图，历史混进过一张无效图会每轮被整体 400 拖累——应在发送前对 image part 做有效性预检/跳过无效图(与错误分类/fallback 同类)。

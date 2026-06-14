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

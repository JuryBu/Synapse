# Plan_4 M1 — 上下文 harness 改造设计

> 子代理（opus）深度探索现有代码后的设计（2026-06-14）。实现时按此推进。

## 现状摘要（意外发现）
- **conversation 完整原文已存好**：运行态 Redux `conversation` slice；Electron 落盘 SQLite `~/.synapse/synapse.db`（`conversations`+`messages` 表，连 `tool`/`system`/`thinking`/`runEvents`/`diffs` 都进库），Web 落 localStorage。UI 按完整 `messages` 渲染。→ **M1 第一层天然满足，不动这条主线**。
- **压缩是玩具级**：`systemPrompt.ts` 的 `compressContext()` 按字符数估算 token，超 **写死 128k×0.8** 就把旧消息**字符截断**（AI 留前 500 字）塞进一条临时 `[CHECKPOINT]` system 消息。**有损、不落盘、UI 无标记、不用真实 token/contextWindow**。
- **record 层不存在**：只有 raw messages + 偏 UI 回放的 `AssistantRun`（非给模型读的结构化日志）。
- **memory 层不存在**：toolRegistry 11 个工具无记忆工具；`run_command` 已实装（Electron 真执行/Web mock），`search_web`/`read_course_material` 等是 mock 占位。
- **喂 API 已准对**：`[system, ...压缩后历史]`，system 已置顶（利于 cache），但旧消息是「全量 or 字符截断」二选一，缺「最近 N 条 + record」分层。

## 改造目标（对齐 Plan_4 M1）
喂 API = `system prompt`（稳定）+ `record`（稳定前缀，hit cache 关键）+ `最近 N 条完整消息`（尾部动态）；达模型 contextWindow 90% 触发；压缩=生成 record（真摘要）而非截断；UI 标压缩点但展示完整；内置 memory_store 工具。

## 实现步骤
- **Step 0（低风险先做）**：`compressContext` 的 maxTokens 改用当前模型真实 `contextWindow`（`modelCapabilities`/`agentSettings.currentCapabilities`，AgentPanel:142 已有）；阈值 0.8→0.9；触发优先用 `conversation.tokenUsage.totalTokens`（API 真实值，已在 agentLoop:313 捕获但没用），回退 `estimateTokens`；SettingsPanel 假的「压缩策略」文字换真 slider 接 agentSettings。
- **Step 1 record 层**：新 `src/services/recordStore.ts`（数据模型+读写）+ `src/services/recordGenerator.ts`（输入被压缩的 messages，调一次 LLM 生成结构化 md 过程日志）；DB 加 `records` 表；`ipc/conversation.ts` 加 `record:get/upsert`；`platform/index.ts` 加抽象+Web mock。失败要降级回字符截断，不阻塞对话。
- **Step 2 重构 agentLoop 消息组装（核心）**：`agentLoop.ts:124-153` 把 compressContext 换成 `buildApiContext()` → `[system, record段, ...最近N条(含tool轮次)]`；N 按 token 预算动态算（≤90% contextWindow），不写死 4；触发压缩时生成/增量更新 record 落盘 + store 打压缩点标记。注意 record 内容在下个压缩点前固定以命中 cache。
- **Step 3 UI 压缩点标记**：`conversation.ts` 加 `compactionMarker`/`compactionPoints` 字段+action；消息流渲染分隔线「以上已压缩为 record」；展示仍读完整 store。
- **Step 4 内置 memory_store**：新 `src/services/memoryStore.ts` + DB `memories` 表（对齐参考实现 `MemoryFrontmatter`，复用 FTS5）；toolRegistry 注册 `memory_write`/`memory_query`（审批 auto）；`ipc/memory.ts` + platform Web mock；可选注入 pinned memory 到 system prompt。⚠️ 与外置 MCP memory-store 同名工具冲突，命名区分或文档说明。
- **Step 5（可选）**：`run_command` 加固（超时/输出截断/默认 cwd）。

## 关键风险
1. **prompt cache**：record 前缀必须稳定，增量更新（参考 `lastUpdatedRound`）而非每轮全量重写。
2. **截断/编辑路径**：`editMessage`/`truncateAt`/retry(`skipUserMessage`) 时已生成 record 要失效或回滚到对应轮次。
3. **record 生成失败降级**：LLM 调用 try/catch，回退字符截断，绝不阻塞主对话。
4. **Web 模式对等**：所有新 DB 能力在 `platform/index.ts` 补 localStorage mock。
5. **token 精度**：触发判断优先 API 真实 `tokenUsage`，首轮无 usage 才回退估算。

## 参考
- 外置实现机制：`C:\Users\Stardust\.gemini\antigravity\mcp-memory-store`（record 是每对话 .md+索引；memory 是 YAML frontmatter+md，按 workspaceHash 分目录）。Synapse 沿用 SQLite 更自然，不必照搬文件方案。

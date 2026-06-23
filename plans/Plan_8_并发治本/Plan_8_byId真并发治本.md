# Plan_8 — #8 byId 真并发对话隔离（治本）设计弹药库

> 来源：子代理深度侦察（workflow wpvbej01x，2026-06-24）+ 第二批反馈 B + 主人轮 325 选「A 后台继续写 A、切回看到」。
> 状态：**设计已固化，待新上下文执行**（本批过夜上下文已满，硬上风险高，故先固化再开工——符合主人「治本前先固化 Plan」要求）。
> ⚠️ 执行前先重读本文件 + `../../M8_真机交接/Task_第三批反馈.md` #8/#9 + 第二批 A/B（对话状态色/真并发）。

---

## 一、要解决什么（#8 串线 + #9 卡 UI + 第二批 B 真并发 + A 状态色基础）

- **#8 串线（HIGH）**：A 对话生成中切到 B，A 的 agentLoop run 仍在跑，它的所有流式写入 dispatch 此刻写的是已被换成 B 的 slice → A 的 token/工具卡/diff 串进 B、污染 B。主人原话「跟那个被追杀一样追到切换之后的对话继续」。
- **主人选的治本方向**：A 生成中切 B → **A 后台继续写 A 自己**、B 干净不被污染、切回 A 看到完整结果。
- **#9 卡 UI（HIGH）**：`AgentPanel.tsx:157 useAppSelector(s=>s.conversation)` 全量订阅整个 slice → 流式每帧（appendMessageContent 改 messages）让选择器返回新引用 → 整个 AgentPanel（2700+ 行巨组件）重渲。byId 改造顺带把订阅拆细粒度治掉。
- **第二批 A 对话状态色**：🔵生成中 对【非当前对话】才有意义，依赖本治本（byId 后才能判别非当前对话是否在跑）。本治本是 A 状态色的地基。

## 二、根因（机制层，path:line 实锤）

**①【串台写】conversation slice 是「单当前对话」扁平模型**：`ConversationState`（conversation.ts:273-317）只有 `state.id` 单值 + `state.messages` 扁平数组；所有流式写入 reducer 形如 `const msg = state.messages.find(m => m.id === payload.id)`（addMessage:637 / appendMessageContent:651 / setMessageStreamState:680 / updateToolCallStatus:1005 / addMessageDiff:707 …），**完全不校验消息属于哪个对话，无脑写当前那一份 messages**。`agentLoop.ts` 经模块级 `import { store }`(7) 直接 `store.dispatch(...)`，写的永远是 store 此刻的 slice。切对话入口（AgentPanel.tsx:1072 `handleSwitchConversationFromMenu` 的 `setConversation(B)`）把 slice 整体换成 B，但 **A 的 run 还在事件循环里跑（切对话只 `loopRunner.stop()` 停 /loop，不停 agentLoop）** → A 后续每次 appendMessageContent/updateToolCallStatus 都落进已是 B 的 messages = 串台。`execContextId` 虽已在 run 入口快照（agentLoop.ts:1173 = `this.contextId || conversation.id || AUTOSAVE_ID`），但**只喂给 worktree/fileChangeTracker(1621) 做隔离，从未参与 store 写入路由**。

**②【#9 卡】** AgentPanel.tsx:157 全量订阅 → 流式每帧整组件重渲。

## 三、治本方案（分 6 步，子代理设计）

### 步1 — state 改造（conversation.ts:273-317）
把 `ConversationState` 拆两层：
- 定义 `PerConversation` 桶接口 = 现 ConversationState 里【对话私有】字段子集：`messages / assistantRuns / fileSnapshots / pendingDiffs / isStreaming / streamingContent / queuedMessages / interruptMessages / taskBoundaries / taskHeadline / goal / parentId / branchedFromMessageId / workspacePath / bpcThresholdOverride / compactThresholdOverride / title / model / tokenCount / tokenUsage`。
- 顶层 `ConversationState` 改为 `{ schemaVersion; activeId: string|null; byId: Record<string, PerConversation>; isCompacting; pendingMessage }`（isCompacting/pendingMessage 是全局 UI 态，保留顶层）。
- helper：`ensureBucket(state, id)`（缺桶按 emptyBucket() 建）、`getActive(state)`（取 byId[activeId]）。
- **AUTOSAVE_ID 作为合法 bucket key**（新对话 id=null 时统一用 AUTOSAVE_ID 当桶键，与 execContextId 回退口径一致）。
- initialState（conversation.ts:451-477）改 `{activeId:null, byId:{}}`。
- `clampTaskBoundariesAfterTruncation`(330) 改接收 bucket。

### 步2 — 写入路由（conversation.ts 所有写入 reducer）
给每个写入 reducer 的 payload 加 `conversationId?: string`，reducer 内：
```
const bucket = action.payload.conversationId ? state.byId[action.payload.conversationId] : getActive(state);
if (!bucket) return;
// 再在 bucket 上做原有 find/push
```
受影响 reducer（行号）：addMessage:636 / updateMessage:639 / updateMessageMeta:646 / appendMessageContent:650 / setMessageAttachments:664 / appendMessageThinking:668 / setMessageStreamState:679 / setMessageReconnect:696 / addMessageDiff:706 / addMessageArtifact:717 / updateDiffStatus:723 / updateHunkStatus:751 / updateDiffBlockStatus:784 / addAssistantRun:809 / addRunEvent:812 / recordFileSnapshot:834 / setStreaming:837 / updateToolCallStatus:1004 / enqueue系列(845-899) / beginTaskBoundary / setTaskHeadline / appendTaskStep / endTaskBoundary。`setCompacting`(841) 注意是全局态保留顶层。
- **conversationId 可选 + 缺省回退 getActive**：保证用户手动操作（编辑/接受 diff）等不带 convId 的 dispatch 仍写当前活跃桶，向后兼容。
- ⚠️ 本批已改的 `addMessageDiff` 合并逻辑（#6/#10，e4e9085）要一并迁进桶：合并查 `bucket.pendingDiffs`、读 `bucket.fileSnapshots`。

### 步3 — agentLoop 写入带 convId（agentLoop.ts）
execContextId 已在 1173 快照——作为唯一权威 conversationId 传进 run 内每一次 store.dispatch 写入：addMessage(785,1204,1277,1645) / appendMessageContent(1342) / setMessageStreamState(1343,1417,1507,1555,1578,1588) / updateToolCallStatus(1610,1653,1670) / addMessageDiff(1625) / addMessageArtifact(1641) / addAssistantRun(1262) / addRunEvent / appendMessageThinking / setStreaming(761,1239) 全部 `dispatch(xxx({ ...payload, conversationId: execContextId }))`。这样无论用户切到哪个对话，A 的 run 永远写 byId[A]。drainInterruptMessages(1184) 的 addMessage 同样带 execContextId（此时 liveId!==execContextId 守卫不再必需但保留无害）。

### 步4 — 切对话只改 activeId（AgentPanel.tsx + ConversationList.tsx）
新增 reducer `setActiveConversation(state, id)` = 仅 `state.activeId = id`（桶不存在则 ensureBucket）。切对话流程改为：`loadConversationSnapshot(B)` → 若 byId[B] 不存在/需刷新则 `hydrateConversation({id:B, ...snapshot})`（建/覆盖 B 桶）→ `setActiveConversation(B)`。
- **关键：不再清空 A 桶、不停 A 的 run**。saveConversationSnapshot(切走 A) 仍保留落库，但 A 桶留内存继续被 run 写。切回 A 时 setActiveConversation(A) 直接看到后台已写好的完整内容。
- `setConversation`(483) 保留为 hydrateConversation 别名（建桶+设 active）；`clearConversation`(916) 改清当前活跃桶（+可选 newId）。
- 入口：AgentPanel.tsx:1072 handleSwitchConversationFromMenu / 949 handleNewConversation；ConversationList.tsx:276/246/291/326/531。

### 步5 — 订阅细粒度化（治 #9）
拆掉 `AgentPanel.tsx:157 useAppSelector(s=>s.conversation)`，改字段级选择器：`useAppSelector(s => s.conversation.byId[s.conversation.activeId ?? AUTOSAVE_ID]?.messages)` 等，逐字段订阅（messages/title/taskBoundaries/pendingDiffs 分开，可 createSelector memo 化）。流式只改 messages → 只有依赖 messages 的子树重渲。StatusBar(15-18)/EditorArea(32) 同步改读 activeId 桶。

### 步6 — 持久化按桶（conversationPersistence.ts + autosave effect）
autosave effect(AgentPanel:813-878) 依赖从 `conversation.*` 改成 `activeBucket.*`。**新增关键**：后台桶也要 autosave——A 在后台被 run 写时，run 的 finally（agentLoop:1713）追加一次按 execContextId 的 `saveConversationSnapshot(A)`，保证后台 A 写完即使没切回也落库。`isConversationSwitching` 闸门(persistence:182)语义不变。branchConversation(399) 按对话独立桶深拷贝逻辑不变。

## 四、风险（务必逐条防）
1. **路由 key 一致性**：execContextId 口径 = `this.contextId || conversation.id || AUTOSAVE_ID`；reducer 路由必须同口径，新对话 id=null 统一 AUTOSAVE_ID 桶，否则首条 run 写丢。
2. **依赖单对话假设的链路全要迁**：autosave / worktree(已按 contextId) / 分支回溯(branchConversation/truncateAt) / record 水位线 / 附件 refCount / clampTaskBoundariesAfterTruncation — 逐个改成按桶。
3. **后台桶内存增长**：长期不切回的后台桶占内存；可在 run 收尾落库后按策略保留 N 个活跃桶、其余只留 activeId+落库（暂可不做，记小本本）。
4. **持久化兼容**：byId 是 schema 大改，旧扁平快照 loadConversationSnapshot 要能 hydrate 成桶（schemaVersion 升 + 迁移）。
5. **#6/#10 合并已迁桶**（步2 注）；**#4 openTabSync** 不受影响（按 path 不按对话）。

## 五、CDP 双对话验证（8 步，执行后必做）
1. 启动 app + connect CDP。
2. 对话 A 发长 run（多轮工具/连改文件），确认 A 流式。
3. run 中切到/新建 B。
4. 截 B → **B 必须干净**，无 A 的 token/工具卡/diff（串台断）。`window.__SYNAPSE_AGENTLOOPS__.size>=1` 确认 A loop 仍 running。
5. evaluate `store.getState().conversation.byId`：byId[A].messages 后台持续增长（隔几秒读两次比长度），byId[B].messages 不含 A 内容。
6. A run 跑完，切回 A，截图 → A 完整结果（后台写的全在、无截断、无卡 streaming）。
7. #9：生成中切对话/连点操作不卡（对比改造前整组件重渲）。
8. CDP reload 后切回 A，确认后台增量已落库未丢。

## 六、必须主人拍板的点 / 可默认点
- **可默认**（已定）：后台并发上限默认值（建议 3，做成设置项 `settings.maxConcurrentRuns`，遵循「可调参数暴露面板」）；「已读」判定 = activeId 切到该对话即标已读；AUTOSAVE_ID 作桶键。
- **可默认**：后台桶内存保留策略（先全留内存，超 N 个落库释放记小本本）。
- **要主人拍**（如执行中遇到）：若某依赖链（如 record 水位线跨桶、分支 fork 的桶继承）发现无法合理默认的语义分歧 → 停在安全 commit 点记此处留主人定。

## 七、关联：A 对话状态色（byId 落地后接着做）
byId 后每桶有独立 isStreaming/error 态 → 对话列表 + 顶部浮层 + 顶部标题渲染四态闪烁色点：🔵生成中(桶 isStreaming)/🟢完成未读(run 结束且未切回看)/🔴错(最后消息 error)/🟡其它异常(重连/429/工具重试)。固定绿蓝红黄不用主题色变量。详见第二批 A。
**双向工作区告知**：① UI 列表/浮层每项显示 workspace 标签 + 后台跑配蓝点；② run 组装请求体时，若同 workspace 下有别的对话活跃，注入提示告诉模型（不做锁，争抢交给 agent 判断）。

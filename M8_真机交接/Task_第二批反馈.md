# M8 真机第二批反馈 — 交接 Task（A/B/C/D）

> 来源：对话 9821e6b3 轮 286（主人「第8点完整版」+ Codex 右键菜单参考）+ 轮 325（#3 真并发选「A 后台继续」）。
> 图存 `images/r286-1~5`（这批 5 张含：Synapse 顶部对话栏切换器、Synapse 左侧对话列表、**Codex 右键菜单（关键，D 的实现参考）**、一个 +菜单、Context window 截图）。
> ⚠️ 我（主代理）这批**没逐张核对图序号**（序号易错），新对话实施 D 前**务必 Read `images/r286-1~5` 这 5 张**，认出 Codex 右键菜单那张，照它的菜单布局做。

---

## A【MEDIUM】对话状态色（= 主人厘清的「四色闪烁」）
- [ ] 状态：待做
- **主人原话**：用不同颜色表示不同对话状态——「没有查看是绿色，正在生成是蓝色，出错是红色，retry 等异常但是没有失败是黄色，而且它们是闪烁，不是一直是某个颜色避免主题色变化导致和某个颜色区分不了」
- **现状**：对话列表项 + 顶部对话栏没有状态色指示。代码里「四色」只有 @MultiAI 工作流子代理卡片那套（multiAI slice，灰/蓝/黄/红），不是对话级。
- **期望**：对话列表项 + 顶部对话栏，每个对话按状态显示一个**闪烁**的色点：🟢做完未查看 / 🔵生成中 / 🔴出错 / 🟡retry等异常未失败。闪烁（非常驻色，避免主题色变化时与某状态色撞色）。
- **怎么改**：① conversation/conversationHistory 加 status 派生（generating=该对话有 run 在跑【依赖 B 真并发才能判别非当前对话】；error=最后消息 error；retrying=reconnect 中；unread=有新 AI 回复但用户未查看→需「上次查看时间/已读标记」字段，与 D 的「标记未读」共用）② ConversationList 列表项 + 顶部切换器渲染状态色点 + CSS 闪烁 animation（用固定的绿蓝红黄，**不要用主题色变量**，否则主题切换会撞色）。
- **依赖**：🔵生成中 对【非当前对话】要有意义，依赖 **B 真并发**（否则只有当前对话能判生成中）。

## B【HIGH】真并发对话隔离（主人选「A 后台继续」）= 第三批 #8 的治本
- [ ] 状态：待做（最硬）
- **主人原话**（轮325 选项）：「A 后台继续生成、切回能看到（真隔离）」
- **现状**：`ConversationList.handleSwitchConversation` 只做 exitWorktree + setConversation，**不停原 run**；conversation 是单对话 slice → 原 run 继续 dispatch 写到当前 slice（已切成新对话）→ 串台（= 第三批 #8）。
- **期望**：对话 A 生成中切到 B → A 的 run 后台继续、写回 A 自己；切回 A 看到完整结果；B 不被污染。
- **怎么改**：run 的所有 dispatch（addMessage/appendMessageContent/setStreaming/setTokenUsage/addRunEvent…）按 `execContextId` 路由到【对应对话】，而非无脑写当前 slice。方案候选：① conversation slice 改为支持多对话运行态（byId map）② 或 run 写持久化层 + 当前对话才同步进 UI slice。中等偏大重构，需谨慎设计 + CDP 真机验证（开两对话实测 A 切 B 再切回）。

## C【LOW】对话 ID 直接注入 — 代码层已做，待主人验证
- [ ] 状态：已做待验证
- **主人原话**：「当前每个对话内 ID 还需要模型手动查而不是直接注入告诉模型」
- **现状**：`systemPrompt.ts` 约 100-104 已注入高位段「当前对话 ID：<id>\n…无需调用工具查询」，gating 是 `injectContext`（默认开）。agentLoop.run 每轮从 store 取 conversationId 传入。
- **待验证**：图九里模型调 read_conversation 查 ID，大概率是模型在**演示工具**，不是没注入。验证：开新对话直接问「别查工具，当前对话 ID 是多少」→ 答得出=生效。若真答不出，查 injectContext 是否被关 / 那条是注入功能上线前的旧对话。

## D【MEDIUM】顶部对话栏右键菜单（学 Codex）
- [ ] 状态：待做
- **主人原话**：图九顶部显示对话的地方，也应和左边栏对话列表一样能做对话功能操作；考虑美观性，在顶部这里**右键展开功能列表**（参考图十一 Codex 那种）。借鉴 Codex 可用功能：复制ID / 复制工作目录 / 置顶对话(列表中) / 重命名(已做) / 标记为未读 / 标记为未完成 / 在新窗口中打开 / fork对话；图十一 Codex 完整菜单还有：归档对话 / 在资源管理器中打开 / 复制会话ID / 复制深度链接 / 派生到本地 / 派生到新工作树。
- **图**：实施前 Read `images/r286-1~5`，认出 Codex 右键菜单那张（菜单项：置顶对话/重命名对话/归档对话/标记为未读 ── 在资源管理器中打开/复制工作目录/复制会话ID/复制深度链接 ── 派生到本地/派生到新工作树 ── 在新窗口中打开），照它分组布局。
- **现状**：顶部对话栏（紧凑切换器，AgentPanel/ConversationSwitcher）无右键菜单；左侧 ConversationList 列表项有部分 hover 操作（编辑/归档等）。
- **期望**：顶部对话栏对话项右键 → 弹出功能菜单，含上述操作；与左侧列表功能对齐。
- **怎么改**：① 顶部切换器对话项加 onContextMenu → 弹 portal 菜单（复用/对齐左侧列表已有操作）② 补缺的操作：复制ID(navigator.clipboard) / 复制工作目录 / 复制深度链接(synapse:// 协议？需查是否有底座) / 置顶(conversationHistory 加 pinned 字段 + 排序) / 标记未读/未完成(状态字段，喂 A 状态色) / 在新窗口打开(Electron 多窗口，需查底座) / 派生本地(=fork 已有 branchConversation) / 派生新工作树(fork + enter_worktree 组合，新底座)。
- **需先查底座**：复制深度链接(深链协议)、在新窗口打开(多窗口)、派生到新工作树——这几个 Synapse 可能没现成底座，要先确认再做。

---

## 优先级（与第三批合并看）
- B 真并发 = 第三批 #8 治本，且 A 的🔵依赖它 → B 应早做。
- A+D 强耦合（状态色 ↔ 标记未读/未完成）→ 一起设计「对话状态模型」再动手。
- C 仅待主人验证。

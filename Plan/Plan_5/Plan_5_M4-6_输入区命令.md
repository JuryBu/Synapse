# Plan_5_M4-6 — 输入区 @ 艾特 + / 斜杠命令体系

> 子代理（opus）逐文件读代码后的设计（2026-06-16）。本里程碑在 AgentPanel 输入区叠一层「输入区命令层」：@ 艾特三类数据源（历史对话 / 固定工作流 / 设置项）内联补全 + / 斜杠命令注册表与执行分发。已按主人最终决策修正（详见 §7 openQuestions 决议、§8 技术决策小结）。

---

## 一、目标

在 AgentPanel 的单受控 textarea 之上，叠一个不侵入既有发送链路的「输入区命令层」，由三部分构成：

1. **触发检测器**：解析光标前文本，判定当前处于 `@`（艾特）还是 `/`（斜杠命令）上下文，并取出 query 片段与 token 起点。
2. **内联补全浮层 `InlineCompletionMenu`**：跟随输入框上方的相对浮层，候选渲染 + 键盘/鼠标选择，复用 CommandPalette 的 selectedIdx / ArrowUp-Down / Enter / Esc 交互习惯。
3. **两套数据 / 分发层**：
   - `@` 数据源 provider（三类源合并、模糊过滤、分组限量、各自插入语义）；
   - `/` 命令注册表 + 执行器（SlashCommand 接口、register/filter、parseAndDispatch 分发、SlashRunContext helpers 注入）。

落地原则：**新增文件集中在 `services/inputCommands/` 与 `components/chat/`，AgentPanel 只接线不堆逻辑**。

---

## 二、覆盖问题（对应用户问题编号）

本里程碑覆盖以下既有问题（coveredIssues）：

1. **@ 艾特三类数据源的内联补全与插入语义未定义** —— 历史对话 / 固定工作流 / 设置项三源，补全交互与「选中后插入什么」此前完全没有定义，本里程碑定义并实装。
2. **/ 斜杠命令体系缺失** —— 无命令注册表、无执行分发层、输入框对 `/` 零识别，本里程碑新建整套。
3. **内置命令 /loop /goal /compact 全局零实现** —— 本里程碑定义语义并实装命令壳。其中 `/compact` 走 M4-7 的手动 record 压缩接口；**M4-7 未落地前 /compact 接 stub**。
4. **extensionManager 的 slashCommand（/review //collect）是展示型死代码** —— `matchWorkflow` 无任何调用方，本里程碑把 `/review` `//collect` 迁入新命令注册表，使其可真正执行。
5. **输入框 placeholder 与可发现性差** —— 当前仅提示 `@MultiAI`，用户不知道有 `@` `/` 能力，本里程碑加触发提示文案。

---

## 三、确认现状 / 真根因（currentStateVerified）

逐文件读代码后确认（含对 brief 诊断的两处纠正）：

1. **AgentPanel 输入框是单受控 textarea，对 @// 零特殊处理**。
   `src/components/layout/AgentPanel.tsx:1349-1357` 的 textarea，`onChange` 只 `setInput`，`onKeyDown=handleKeyDown` 仅处理 Ctrl+Enter 发送。`handleSend`（L563）里唯一的前缀分流是 `parseMultiAITrigger(text)`（L597）走 `runWorkflowFromInput`，其余全走 `agentLoopRef.current.run`。

2. **@MultiAI 样板是发送期前缀解析，不是实时补全**。
   `services/multiAITrigger.ts` 的 `parseMultiAITrigger` 是「整条输入去前导空白后以 `@MultiAI:` 开头」的纯字符串前缀解析，返回 `{modeName, taskInput}` 或 `null`。**它只在 handleSend 发送瞬间解析，不是输入中实时补全**——可作 `@` 的发送期解析样板，但内联补全菜单是全新交互层。

3. **extensionManager.matchWorkflow 是死代码**。
   `extensionManager.ts:188` 的 `matchWorkflow(input)` 用 `input.startsWith(w.slashCommand)` 匹配 `/review` `//collect`，但 Grep 全仓确认 **matchWorkflow 没有任何调用方**。`BUILT_IN_WORKFLOWS` 的 `slashCommand` 仅经 `buildExtensionPrompt`（L255，被 `systemPrompt.ts:76` 调用）注入系统提示文字给模型看，**输入框完全不识别这些斜杠命令**。`matchSkills` 同理仅被 `buildExtensionPrompt` 间接用于注入。

4. **★ 对 brief「CommandPalette 是死代码」的纠正**：
   CommandPalette **并非死代码**——`AppLayout.tsx:142` 实际挂载了它，Ctrl+Shift+P（`useShortcuts` L68）触发，commands 来自 `useDefaultCommands`（布局/主题/设置类，非 `/` 命令）。它确实是全屏 overlay（`cmd-palette-overlay`）、命令无参数、无内联/跟随光标定位、Enter 即执行无插入语义，故「不能直接复用到输入区」的结论成立，**但准确表述应为「已用于全局命令面板，需另建内联组件而非复用」**。其 `Command` 接口（id/label/category/shortcut/icon/action）可作命令注册表字段参考。

5. **三类 @ 数据源 store 形态**：
   - ① 历史对话 = `conversationHistory.conversations: ConversationSummary[]`，字段 `{id, title, lastMessage, timestamp, messageCount, model}`（`slices/conversationHistory.ts`）。
   - ② 固定工作流 = `multiAI.modes` 中 `workflow` 非空的 `MultiAIMode`（`slices/multiAI.ts`，`resolveWorkflowMode` 已有按名/id 匹配逻辑可复用）。
   - ③ 设置项 = **无单一数据源**：settings slice 是扁平字段（language/safety/promptInjection/apiKeys 等）+ SettingsPanel 是分区 UI。「@设置」候选需要本里程碑**手工建一份「可寻址设置项清单」**（label + 所属分区 sectionId），跳转复用 `AppLayout.openSettings` 思路（`dispatch setActiveView('settings') + setSidebarVisible(true)`）。

6. **/ 命令落地锚点**：
   普通发送走 `agentLoopRef.current.run(text, opts)`（`agentLoop.ts:334` `run(userMessage, opts?: {skipUserMessage, contentParts, attachments})`）。systemPrompt 在每次 run 内部由 `promptBuilder.build({workspaceName, mode, promptInjection})` 组装（`agentLoop.ts:387`）。`PromptContext` 已支持 `files/synopsis/userRules` 字段但 **agentLoop 当前未传 files**——这是「工作区感知 / @对话引用 / goal 注入」可接的现成扩展位，但需在 `PromptContext` 增 `goal` 字段并在 `build()` 输出 `<goal>` 段。

7. **/compact 对接点（★ 已按主人决策修正）**：
   record 自动压缩由 agentLoop 在约 90% 阈值时调 `recordGenerator.generateBatch`（`recordGenerator.ts:357` 唯一导出）写入 recordStore（`appendBatch`）。**当前无手动触发 record 生成的入口**——`/compact` 的手动压缩实现属于 M4-7。
   > **主人纠正（重要）**：Synapse 现有的「~90% 水位自动生成 record」**保持不变**。`/compact` 是**新增的手动压缩入口**，与自动压缩**并存**，复用同一套压缩逻辑（generateBatch → appendBatch）。本里程碑只建命令壳 + 调用约定，M4-7 未就绪时 `/compact` 给 notification 占位。原设计稿中「record 转手动 / 降级自动压缩」的措辞一律作废。

8. **goal/loop 完全无任何 store/服务/UI 痕迹**（Grep 仅命中一份无关 MCP 报告 md），全新建。

9. **消息可注入 system 段**：`Message.role` 支持 `'system'`（`conversation.ts:118`），`addMessage` 可插入 system 角色消息；但更干净的 @对话引用注入路径是经 `PromptContext` / run 的 opts 透传，**避免污染可见对话流**（设计取后者，见 §4）。

---

## 四、详细设计（design，已按主人决策修正）

总体架构：在 AgentPanel 输入区上叠「输入区命令层」（触发检测 + 内联浮层 + @数据源/分发 + /命令注册表/执行器）。AgentPanel 只接线。

### 4.1 触发检测（`services/inputCommands/triggerDetect.ts`）

```ts
detectTrigger(text: string, caretPos: number):
  { kind: 'at' | 'slash' | null; query: string; tokenStart: number } | null
```

规则：
- 从 caret 往前找最近的 `@` 或 `/`；命中需满足「该字符前是**行首或空白**」（避免 email、路径里的 `/` 误触，与 `parseMultiAITrigger`「仅整条开头」相比放宽到「token 边界」以支持句中艾特）。
- `@`/`/` 与 caret 之间不含空白才算 query。
- **`/` 命令额外约束：仅当 `/` 出现在【整条输入去前导空白后的开头】才弹命令菜单**（命令是整条指令语义，不在句中）；**`@` 则允许句中**（引用可嵌在话里）。
- 返回 `tokenStart` 供选中后做字符串替换。

> 按主人决策：`/` 仅整条开头触发、`@` 句中触发，此区分锁定（见 §7 决议 5）。

### 4.2 内联浮层组件（`components/chat/InlineCompletionMenu.tsx`）

```ts
props: { open; items: CompletionItem[]; activeIndex; onSelect(item); onClose; anchorRect? }
CompletionItem: { id; label; description?; icon?; group: '对话'|'工作流'|'设置'|'命令'; meta?: any }
```

- 渲染为 `position:absolute`，挂在 `.agent-input-container` 上方（`bottom:100%`），最大高度可滚动，带分组标题。
- 键盘交互由 **AgentPanel 的 onKeyDown 在浮层 open 时拦截**（ArrowUp/Down 改 activeIndex、Enter/Tab 选中、Esc 关闭），其余键照常输入并触发重新过滤。
- 鼠标 hover 改 activeIndex、click 选中。
- 样式复用既有 `cmd-item` / `cmd-list` 类（globals.css 已有），新增 `.inline-completion-menu` 定位类。

### 4.3 @ 数据源与插入语义（`services/inputCommands/atSources.ts`）

统一接口 `getAtCompletions(query): CompletionItem[]`，内部合并三类、按 query 模糊过滤、各组限量（每组 ≤ 8）：

**① @对话**（来源 `store.getState().conversationHistory.conversations`）
- label = title，description = lastMessage 截断 + 相对时间，meta = `{conversationId}`。
- 插入语义：在输入里替换为可见 token 文本「@对话:标题」，并在 AgentPanel 新增的隐藏「本轮引用表」`refs: {kind:'conversation'; id; title}[]` 记一条。
- **发送时（handleSend）注入**：把引用对话经 `loadConversationSnapshot(id)` 读回，抽取其内容（粒度见 §7 决议 2，**默认 record 摘要优先、无 record 回退最后 N 条**），作为一段 `<referenced_conversation>` 注入——经 `agentLoop.run` 的 opts 扩展（新增 `opts.injectedContext?: string`）透传到 `promptBuilder.build` 的新 `context.referencedContext` 字段，渲染成系统段。**不往可见对话流插 system 消息**（避免污染 UI + 重复落库）。
- token 在输入框可见、可整体删除（删 token 同步移除引用表项）。

**② @工作流**（来源 `multiAI.modes.filter(workflow 非空)`，复用 `resolveWorkflowMode` 命名口径）
- label = mode.name，description = mode.description。
- 插入语义 = **触发糖衣**：选中后直接把输入框内容替换成 `@MultiAI:模式名` 形态（复用既有 `runMultiAITrigger` 链路，**零新增执行路径**），光标停在模式名后让用户补任务描述。即「@工作流」是 `@MultiAI` 的可发现化糖衣，发送时仍由 `handleSend` 现有 `parseMultiAITrigger` 分流。

**③ @设置**（来源本里程碑新建静态清单 `SETTINGS_INDEX: {id; label; sectionId; keywords}[]`）
- 覆盖 AI / 安全 / 提示注入 / 外观 / 工作树等 SettingsPanel 现有分区可定位项。
- 插入语义 = **跳转**：选中时**不插 token**，直接执行 openSettings 动作（`dispatch setActiveView('settings') + setSidebarVisible(true)`），并发一个 window 事件 `synapse:settings-focus-section` 带 sectionId 供 SettingsPanel 滚动定位/高亮（SettingsPanel 侧加监听，属轻量扩展），输入框把 `@query` 片段删除。
- 理由：设置项不是「内容引用」，艾特它的自然意图是「去改它」。（见 §7 决议 3，已锁定纯跳转）

### 4.4 / 命令注册表 + 执行分发（`commandRegistry.ts` + `commandExecutor.ts`）

**SlashCommand 接口**：
```ts
{
  name: string;            // 不含斜杠，如 'compact'
  aliases?: string[];
  description: string;
  args?: { name; description; required?; rest?: boolean }[];  // rest=true 吞掉剩余整段为一个参数（如 /goal 的目标文本）
  run(ctx: SlashRunContext): Promise<void> | void;
}
```

**SlashRunContext**：
```ts
{
  rawArgs: string;
  parsedArgs: Record<string, string>;
  dispatch;
  getState;
  helpers: { runAgent(text, opts); notify(payload); openSettings() };
}
```
执行器统一注入 helpers，**命令体内不直接 import store 链路**，便于测试与隔离。

**commandExecutor.parseAndDispatch(inputText)**：
- 把整条输入按 `/name args` 解析；命中注册命令 → 调 run 并返回 `{handled:true}`；未命中（如 `/xxx` 不存在）→ `{handled:false, suggestion}`，让 handleSend 走原逻辑或提示。

**注册表初始化**：模块加载时把内置命令 register 进去，并把 extensionManager 的 `BUILT_IN_WORKFLOWS`（`/review` `//collect`）适配进来——每个 workflow 生成一个 SlashCommand，run 内拼出该 workflow 的 steps 作为一条 user 指令交给 `runAgent`，**替代死代码 matchWorkflow**。

### 4.5 内置命令语义（实装壳 + 已可落地逻辑）

**`/goal <文本>`：设定/查看当前对话目标**
- 存储：挂 conversation slice 字段 `goal?: string`（随对话持久化，见 §7 决议 4）。
- run：写入 goal；空参 = 显示当前 goal。
- 落地：`promptBuilder.build` 增 `context.goal` → 输出 `<current_goal>` 段；`agentLoop.run` 读 `conversation.goal` 传入。即设目标后**每轮自动注入**。给 notification 反馈。

**`/compact`：手动触发 record 压缩（★ 已按主人决策修正）**
- **语义**：新增的**手动**压缩入口，**与既有自动压缩并存**，复用同一套压缩逻辑（generateBatch → appendBatch）。手动触发即对当前对话立即做一次 record 压缩，而非改动 90% 水位自动触发。
- run：调用约定 = 触发当前对话的 record 全量压缩并提示「已压缩至批次 N」。
- **M4-7 未实现前 run 走 stub**：notify「手动压缩将在 M4-7 接入」+ 预留 `helpers.compactNow()` 钩子（占位函数，M4-7 替换为真实现）。本里程碑只保证命令壳、解析、菜单项就绪，不重复实现压缩。
> 说明：原设计稿「/compact = record 自动转手动」表述作废。自动压缩**保留不动**，/compact 是额外的手动入口。

**`/loop <次数?> <指令>`：循环任务（参考 CC /loop，★ 主人决策取最小版）**
- 语义定义 = 让 AI 对同一指令推进 N 轮。
- **本里程碑落地范围（主人拍板，见 §7 决议 1）= 最小版**：只做命令注册 + 解析 + 一个「**串行重复发送 N 次同指令、每次等上一轮 isStreaming 结束**」的最小循环驱动器 `loopRunner`，**带硬上限**。复杂的自终止/收敛判定（CC 式「AI 自判是否完成、未完成则带上轮结果继续」）标注为**后续里程碑**。
- run：notify 启动 + 调 `loopRunner.start(times, instruction)`；必须可被 `handleStop` 中断。

**`/clear`（低风险样例命令）**
- 复用 `handleNewConversation` / `clearConversation`，作为验证执行链路的样例命令。

### 4.6 AgentPanel 接线（最小侵入）

- `onChange` 后调 `detectTrigger` → `setMenuState({open, kind, query, tokenStart})`；query 变 → 取 items（at → `getAtCompletions` / slash → `commandRegistry.filter(query)`）。
- `onKeyDown` 在 `menu.open` 时优先处理 上/下/Enter/Tab/Esc。
- **handleSend 改造顺序**：先 `commandExecutor.parseAndDispatch(text)`（handled 则 return）→ 再保留现有 `parseMultiAITrigger` 分流（@工作流糖衣最终也走这里）→ 最后普通 `run`（带 `injectedContext` + `goal`）。
- placeholder 文案补「@ 引用 / 命令」。
- 引用表 `refs` state 在发送后清空。

---

## 五、Stage 拆分（5 个 stage，逐个列）

### M4-6-S1 — 触发检测 + 内联浮层组件骨架（不接数据）

- **做什么**：
  - 新建 `triggerDetect.ts`：`detectTrigger` 纯函数 + 单测级边界（行首/空白前才触发、@句中 vs / 仅开头、取 query 与 tokenStart）。
  - 新建 `InlineCompletionMenu.tsx`：受控浮层，复用 `cmd-item` 样式 + activeIndex 键盘/鼠标选择。
  - AgentPanel 接 `onChange`/`onKeyDown`，让浮层能用**假数据**弹出/选择/插入文本。
- **改动文件**：
  - `src/services/inputCommands/triggerDetect.ts`
  - `src/components/chat/InlineCompletionMenu.tsx`
  - `src/components/layout/AgentPanel.tsx`
  - `src/styles/globals.css`
- **验收**：输入 `@` 或行首 `/` 能弹浮层并正确定位；上下键移动、Enter 把候选 label 插回输入框替换 token，Esc 关闭；句中打 `/` 不弹、`@` 在 email/路径场景不误触；`npm run build` 通过。
- **工作量**：medium

### M4-6-S2 — 实装 @ 三类数据源与插入语义

- **做什么**：
  - 新建 `atSources.ts`：`getAtCompletions` 合并 conversationHistory / 工作流 / 设置三组 + 分组 + 模糊过滤 + 每组限量。
  - 新建 `settingsIndex.ts`：@设置可寻址清单（label + sectionId + keywords）。
  - AgentPanel 加引用表 `refs` state；三类插入语义落地：
    - @对话 = 插可见 token + 记引用；
    - @工作流 = 替换成 `@MultiAI:名` 糖衣；
    - @设置 = 执行 openSettings 并发 `synapse:settings-focus-section` 事件（SettingsPanel 加监听滚动定位）。
- **改动文件**：
  - `src/services/inputCommands/atSources.ts`
  - `src/services/inputCommands/settingsIndex.ts`
  - `src/components/layout/AgentPanel.tsx`
  - `src/components/settings/SettingsPanel.tsx`
- **验收**：三类候选可搜可选；@对话留 token + 删 token 同步删引用；@工作流糖衣可继续编辑任务；@设置跳转到对应分区；引用表随 token 增删一致；build 通过。
- **工作量**：medium

### M4-6-S3 — / 命令注册表 + 执行分发层 + 迁移 extensionManager 工作流

- **做什么**：
  - 新建 `commandRegistry.ts`：`SlashCommand` 接口 + `register`/`filter`。
  - 新建 `commandExecutor.ts`：`parseAndDispatch` 解析 `/name args` + rest 参数 + 注入 `SlashRunContext` helpers。
  - 把 `BUILT_IN_WORKFLOWS`（`/review` `//collect`）适配为 SlashCommand（run 拼 steps 交 `runAgent`），`matchWorkflow` 标注废弃。
  - AgentPanel 的 `handleSend` 接入：先 `parseAndDispatch`（handled 则 return）再走既有分流；`/` 菜单候选来自 `commandRegistry.filter(query)`。
- **改动文件**：
  - `src/services/inputCommands/commandRegistry.ts`
  - `src/services/inputCommands/commandExecutor.ts`
  - `src/services/extensionManager.ts`
  - `src/components/layout/AgentPanel.tsx`
- **验收**：输入框打 `/` 弹命令菜单含内置命令；未知命令给出提示且不误吞；`/review` `//collect` 经注册表真正执行（不再死代码）；handleSend 命令分流与既有 @MultiAI/普通对话分流互不干扰；build 通过。
- **工作量**：medium

### M4-6-S4 — 实装内置命令 /goal /compact /loop（+ /clear 样例）

- **做什么**：
  - conversation slice 加 `goal` 字段 + `setGoal` reducer + 随 autosave/落库持久化。
  - `promptBuilder.build` 增 `context.goal` → `<current_goal>` 段；`PromptContext` 增 `referencedContext` → `<referenced_conversation>` 段。
  - `agentLoop.run` 读 `conversation.goal` 与 `opts.injectedContext` 传入 `build`；把 @对话引用表在 handleSend 组装成 `injectedContext`（**默认 record 摘要优先、无 record 回退最后 N 条**）。
  - `/goal` 设/查目标；`/compact` 接 M4-7 stub（notify 占位 + `helpers.compactNow` 钩子，**与自动压缩并存、不改自动逻辑**）；`/loop` 建最小 `loopRunner`（串行重复发送 N 次、每次等 isStreaming 结束、**带硬上限**）。
- **改动文件**：
  - `src/store/slices/conversation.ts`
  - `src/services/systemPrompt.ts`
  - `src/services/agentLoop.ts`
  - `src/services/inputCommands/commandRegistry.ts`
  - `src/services/inputCommands/loopRunner.ts`
  - `src/components/layout/AgentPanel.tsx`
- **验收**：`/goal` 设置后 goal 随对话持久化且注入系统提示（AI 行为可见效果 / 可在 Context tab 展示 goal）；@对话引用内容进入本轮请求（非污染可见流）；`/loop` 串行迭代 N 轮正确；`/compact` stub 提示且 M4-7 钩子就位；build 通过。
- **工作量**：large

### M4-6-S5 — 对抗式自检 + 真机回归 + 边界加固

- **做什么**（边界清单）：
  - 浮层与 IME 中文输入法 composition 事件不冲突（`onCompositionStart`/`End` 在 composing 期间抑制触发检测）。
  - Ctrl+Enter 发送时浮层若 open 的优先级处理。
  - 引用表与 token 文本不一致的修复（用户手改 token 文本 → 以引用表为准做一致性校验，token 被破坏则丢弃该引用并提示）。
  - 命令解析对多空格 / 全角空格 / 引号参数的鲁棒。
  - @设置事件在 SettingsPanel 未挂载时安全 no-op。
  - `/loop` 中途 Stop 能中断循环。
- **改动文件**：
  - `src/services/inputCommands/triggerDetect.ts`
  - `src/services/inputCommands/commandExecutor.ts`
  - `src/components/chat/InlineCompletionMenu.tsx`
  - `src/components/layout/AgentPanel.tsx`
  - `src/services/inputCommands/loopRunner.ts`
- **验收**：IME 不误触、Stop 能断 loop、token/引用一致性、命令参数鲁棒等边界全部通过；真机走一遍三类 @（@对话/@工作流/@设置）+ 三条 /（/goal //loop //compact）行为符合语义；`npm run build` + `electron:build` 通过。
- **工作量**：medium

---

## 六、风险

1. **IME 中文输入法 composition 误触（高频路径）**：composition 期间 onChange 会触发 `detectTrigger`，可能在拼音未上屏时误弹菜单。**必须监听 `onCompositionStart`/`End` 并在 composing 期间抑制检测**——这是中文用户的高频路径，漏了会很烦。

2. **@对话引用注入撑爆上下文**：引用一个长对话可能把本轮请求体 token 顶到压缩阈值甚至撑爆。需限制注入量（**取最后 N 条或 record 摘要而非全文**），并在 token 计数（estimateTokens 链）里计入，否则与既有压缩阈值判定打架。

3. **/loop 失控连发**：本项目最小实现是固定 N 轮串行重发。若做成无终止条件的自我迭代，配合 agentLoop 单例重入闸（`run()` 的 `this.running` 守卫）与 Stop 中断，容易出现循环卡死或失控连发——**必须可被 handleStop 中断且有硬上限**。

4. **/compact 强依赖 M4-7**：当前 record 压缩只有 agentLoop 自动触发 generateBatch、无手动入口。本里程碑只能做 stub + 钩子；若 M4-7 排期晚于 M4-6，`/compact` 会是空壳，需向用户说明这是预期的分阶段交付。（注：自动压缩本身保留不变，不受影响）

5. **@设置跳转定位依赖 SettingsPanel 对齐**：跳转定位依赖 SettingsPanel 新增事件监听 + 分区可滚动定位。SettingsPanel 是大文件（已知有横向滚动 / 侧栏改造在其他里程碑），本里程碑的 `settingsIndex` 与其分区 id 必须对齐，否则跳转到设置但定位不到具体项。

6. **句中 @ 放宽后误触面增大**：触发检测放宽到「token 边界」（支持句中 @）后，误触面比 @MultiAI「仅整条开头」大。路径含 @（如 scoped npm 包 `@org/pkg`）、邮箱、代码片段里的 `/` 都需排除规则，规则不严会频繁误弹打断输入。

7. **引用 token 文本可被用户破坏**：引用 token 是输入框里的普通文本，用户可手动编辑/部分删除导致 token 文本与隐藏引用表不一致。需在发送前**以引用表为准做一致性校验**（token 被破坏则丢弃该引用并提示），不能盲信文本。

---

## 七、openQuestions 决议（已采纳主人/子代理倾向默认值）

1. **/loop 落地深度** → **已决：本里程碑只做最小版**——「固定 N 轮串行重发同指令」最小驱动器 + 硬上限。CC 式「AI 自判是否完成、未完成则带上轮结果继续」的收敛循环复杂度高、涉及终止判定，**拆到后续里程碑**。（主人明确：/loop 先最小版，N 轮串行 + 硬上限）

2. **@对话引用注入粒度** → **已决：默认 record 摘要优先、无 record 回退最后 N 条**。即优先注入目标对话的 record 摘要（token 友好），该对话无 record 时回退取其最后 N 条原文（截断到 token 预算内）。（主人明确：@对话引用默认 record 摘要优先）

3. **@设置选中后是「纯跳转」还是「插 token 引用」** → **已决：纯跳转**。选中即打开设置并定位到对应分区，不插 token、不作为可引用对象。设置项的自然意图是「去改它」。（主人明确：@设置走跳转）

4. **/goal 目标存储位置** → **已决：挂 conversation slice 字段 `goal?:string`，随对话持久化**（符合「对话带工作区归属 / 目标随对话」语义），不另建独立 goal slice。goal 在 Context tab / 输入区可视化展示当前目标。（主人明确：/goal 挂 conversation slice）

5. **/ 命令是否支持句中触发** → **已决：`/` 仅整条开头触发**（命令是整条指令语义），`@` 才允许句中。（主人明确：/ 仅整条开头触发、@ 句中触发）

6. **BUILT_IN_WORKFLOWS 迁入注册表后，buildExtensionPrompt 里给模型看的「可用工作流」提示如何处理** → **已决：由命令注册表统一生成「可用工作流/命令」提示**，避免两处定义漂移。迁入命令注册表后，`buildExtensionPrompt` 改为读注册表生成提示文字（单一数据源），不再各自维护一份 slashCommand 列表。

---

## 八、该里程碑技术决策小结

1. **架构**：输入区命令层 = 触发检测（纯函数）+ 内联浮层（受控组件）+ @数据源 provider + /命令注册表/执行器。新增文件集中在 `services/inputCommands/` 与 `components/chat/`，**AgentPanel 只接线不堆逻辑**。

2. **触发边界**：`/` 仅整条开头触发（命令语义），`@` 句中触发（引用语义）；检测放宽到「行首或空白前」的 token 边界，需对 scoped npm 包 / 邮箱 / 代码片段做排除。

3. **@ 三种插入语义各不相同**：@对话 = 插可见 token + 记隐藏引用表（发送时经 `opts.injectedContext` → `<referenced_conversation>` 注入，**不污染可见对话流**）；@工作流 = 糖衣替换成 `@MultiAI:名`（复用既有链路，零新增执行路径）；@设置 = 纯跳转（不插 token，发 `synapse:settings-focus-section` 事件）。

4. **/ 命令执行隔离**：命令体经 `SlashRunContext.helpers`（runAgent/notify/openSettings）拿能力，**不直接 import store 链路**，便于测试与隔离；`parseAndDispatch` 命中即 handled、未命中不误吞。

5. **死代码迁移**：`extensionManager.matchWorkflow`（无调用方的死代码）废弃，`/review` `//collect` 迁入命令注册表真正可执行；`buildExtensionPrompt` 改为从注册表统一生成可用工作流提示，消除两处定义漂移。

6. **/compact 与自动压缩并存（★ 主人核心纠正）**：Synapse 既有的 ~90% 水位自动生成 record **保持不变**；`/compact` 是**新增手动入口**，复用同一套压缩逻辑（generateBatch → appendBatch），二者并存。本里程碑只建命令壳 + `helpers.compactNow()` 钩子，真实手动压缩实现在 M4-7。

7. **/goal 随对话持久化**：goal 挂 conversation slice，经 `promptBuilder.build` 的 `context.goal` 输出 `<current_goal>` 段，agentLoop 每轮自动注入。

8. **/loop 最小驱动器**：串行重发 N 次、每次等 isStreaming 结束、**带硬上限**、可被 handleStop 中断；收敛/自终止循环留后续里程碑。

9. **IME 安全**：composition 期间抑制触发检测，避免中文拼音未上屏时误弹菜单（中文用户高频路径，列为 S5 必过项）。

10. **引用一致性**：发送前以隐藏引用表为准校验 token，文本被破坏则丢弃该引用并提示，不盲信输入框文本。

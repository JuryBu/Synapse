# Plan_5_M4-2 — 对话体验修复 + 对话工作区归属

> 里程碑标识：**M4-2**　|　标题：对话体验修复 + 对话工作区归属
> 本卷覆盖 7 个 stage（M4-2-S1 ～ M4-2-S7），全部基于逐文件读码核实后的真根因，不丢任何文件:行/根因/修法细节。
> 与设计稿冲突处一律以「主人最终决策」为准，已在本卷各节就地修正并标注。

---

## 一、目标

修复三类「切换/保存期」的对话体验缺陷，并新增「对话工作区归属」特性：

1. **三类体验修复**
   - 问题9：切换对话后，被点中的对话不被高亮置中，反而「跳到列表第二位」。
   - 问题2b(1)：长对话快速连发时弹「自动保存失败」toast（运行态 message.id 弱熵同毫秒碰撞 + `replaceConversation` 纯 INSERT 撞 `messages.id` UNIQUE 导致整事务回滚）。
   - 运行态消息 id 弱熵碰撞（与 2b(1) 同源，统一收敛到 `crypto.randomUUID`）。

2. **对话工作区归属（新特性）**
   - 每个对话记录其所属工作区，**以工作区 path 为稳定身份键**（不用 DB `workspace_id`，原因见第三节真根因）。
   - 创建 / 恢复 / 分支三条链路全部带归属。
   - 左侧栏 `ConversationList` 与右侧栏 `AgentPanel` 顶部**共用同一数据源**（`conversationHistory` slice），都支持按「当前工作区 / Global / 全部」三态过滤。
   - 右侧 Chat 面板顶部提供一个**紧凑下拉浮层**用于打开 / 选择 / 管理历史对话（参考 Windsurf Cascade 形态）。

---

## 二、覆盖问题（对应用户问题编号）

| 编号 | 问题描述 | 对应 stage |
|---|---|---|
| 问题9 | 切换对话后选中项跳到列表第二位（`saveCurrentToHistory` 把切走对话的 `updated_at` 刷成当前时间→按时间降序时它跳第一、被点中的挤第二） | M4-2-S1 |
| 问题2b(1) | 自动保存失败 toast（运行态 `message.id` 弱熵同毫秒碰撞 + `replaceConversation` 纯 INSERT 撞 `messages.id` UNIQUE 整事务回滚） | M4-2-S2 |
| 历史恢复 + 工作区归属 | 右侧栏顶部对话管理区 + 对话带工作区归属 + 左右栏共用数据源按工作区过滤 | M4-2-S3 ～ S7 |

---

## 三、确认现状 / 真根因（逐文件读码核实）

> 本节是 brief 经逐文件读代码核实后的结论，对 brief 有三处实质纠正。所有行号均为读码时的实际定位。

### 纠正1 — 工作区归属的 DB 现状（最关键）

brief 原说「DB `conversations` 表加 `workspace` 字段（懒迁移 `ensureColumn`）」。**实测并非如此**：

- `conversations` 表**建表时就已有 `workspace_id` 列**（`database.ts:47`，带 `FOREIGN KEY → workspaces(id) ON DELETE SET NULL` + 索引 `idx_conversations_workspace`，见 `database.ts:138`）。
- IPC `conversation:create` 已写 `workspace_id`（`conversation.ts:144`，`data.workspaceId || null`）；`conversation:list` 已支持按 `workspaceId` 过滤（`conversation.ts:183-186`）；`mapConversation` 已映射 `workspaceId`（`conversation.ts:31`）。

但**这套基本是死字段**，无法直接用，原因有二：

- **(a) persistence 层从不传 workspaceId**：`saveConversationSnapshot` / `persistPlatformSnapshot` 链路从未把工作区写进去。
- **(b) 身份不一致（更致命）**：`workspaces` 表的 `id` 由主进程 `electron/ipc/workspace.ts` 自己生成（`ws_时间戳_随机`）；而渲染层 `fileSystem.ts` 维护**另一套内存 `workspaces[]`**（id = `ws_时间戳` 或 `'default'`）；而 Redux `workspace` slice **根本没有 id，只有 `currentPath` / `name`**（`workspace.ts:3-9`）。`openWorkspace` action 只存 `{path, name}`，DB 的 ws id 从未回流到 store。

**结论**：用 `workspace_id`（FK 到一个渲染层根本不持有 id 的表）做归属不可行。应改用**工作区 path 作为稳定身份键**——path 在 store、DB `workspaces` 表里都是 UNIQUE，跨主进程 / 渲染层 / Web / 重启都稳定。做法是**新增独立列 `workspace_path`**（不动既有 `workspace_id` FK，避免外键级联误删既有数据）。

### 纠正2 — 问题9 真根因不止排序，在 `updated_at` 被刷

brief 归因「`saveCurrentToHistory` 硬传当前毫秒时间戳 → 按 timestamp 降序使被切走对话跳第一」。方向对，但**落点要精确到 IPC**：

- `listConversationSummaries` 的 `timestamp` 取自 `updatedAt`（`conversationPersistence.ts:740` / `loadPlatformSnapshot:676` 的 `normalizeTimestamp(updatedAt)`）。
- 而 `conversation:update`（`conversation.ts:208`）**无条件 `sets.push('updated_at = unixepoch()')`**。

即：**即使把 `saveConversationSnapshot` 的 timestamp 去掉，IPC update 仍会刷新 `updated_at`**。所以修复**不能只在渲染层传 `touchUpdatedAt:false`**——必须让 IPC update（及 Web mock update）支持一个「系统 touch / 不刷 `updated_at`」开关。`message:replaceConversation`（`conversation.ts:362`）同理，它也无条件刷 `updated_at`。

### 纠正3 — `replaceConversation` 确为纯 INSERT

brief 说改 `INSERT OR REPLACE`，属实：

- `message:replaceConversation`（`conversation.ts:335`）是**纯 INSERT**（撞 `messages.id` 即整事务回滚）。
- 而 `message:add`（`conversation.ts:290`）**早已是 `INSERT OR REPLACE`**（说明这是已有的统一兜底口径）。
- 两个**弱熵 id 生成器**属实：`agentLoop.ts:44` 的 `generateId` 与 `AgentPanel.tsx:51` 的 `generateMessageId`，均为 `` `${prefix}_${Date.now()}_${base36(6)}` ``。
- persistence 层的 `createMessageId`（`conversationPersistence.ts:107`）**已是 `crypto.randomUUID`**，这是统一目标口径。

### 其它确认（实现前的现状摸底）

- **右侧栏 `AgentPanel` 顶部现有结构**：tab 行（Chat / Plan / Context）+ mode 行（新建对话 Plus 按钮 `:1082` / 导出 / 收起）+ Fast/Plan 切换；**无任何对话列表 / 下拉**（S7 要新增的就在这里）。
- **共享数据源**：`conversationHistory` slice（`conversationHistory.ts`）持有 `conversations[]` + `selectedId`，是左右栏**天然共享**的数据源。
- **四条会改对话身份的入口**（均需带 workspace 归属）：`ConversationList.handleSwitchConversation`（`:215`）、`ConversationList.handleNewConversation`（`:189`）、`AgentPanel.handleNewConversation`（`:401`）、`AgentPanel.handleBranch`（`:755`）。
- **systemPrompt 已注入 `workspaceName`**（`systemPrompt.ts:62`）；「注入当前打开文件」属别的里程碑（M4-1 工作区感知），**本里程碑不碰**。
- **Web mock 侧**：`conversation.update` / `conversation.list` / `filterWebConversationSummaries`（`platform/index.ts:334 / 332 / 631`）需对等加 workspace 过滤与 `systemTouch` 跳过 `updatedAt`。

---

## 四、详细设计（按主人决策修正后）

### 4.1 工作区归属 — 身份键与归属模型

- **身份键 = 工作区 path**（已决，见纠正1）。新增独立列 `workspace_path`，与既有 `workspace_id` FK 共存、互不干扰；`workspace_id` 在本里程碑**不动**（保持死字段现状，避免外键级联误删）。
- **三态归属/过滤语义**（统一贯穿 DB / persistence / store / UI）：
  - **具体 path** → 归属该工作区 / 只显该工作区对话。
  - **`IS NULL`（Global）** → 无归属 / 只显无归属对话（即「全局对话」）。
  - **不限（全部）** → 不加 workspace 条件 / 显示全部对话。
- **单当前工作区架构维持**（已决，不引入并发多开）：默认归属当前工作区（`state.workspace.currentPath`，`null` = global）；可经 UI 改归 Global 或 `recentPaths` 里的历史工作区。
- **改名/移动失联 = 已知限制**（已决接受，见第七节）：path 做键，工作区改名会让旧对话失联，本期不做 path 迁移/重绑机制。

### 4.2 三类体验修复 — 系统 touch 机制

- 引入贯穿三层的 **`systemTouch` 开关**：`true` 时保存**不刷 `updated_at`**（用于「切走对话的自动保存」这类系统性保存，不应改变用户感知的排序时间）。
- 三层落点：IPC（`conversation:update` / `message:replaceConversation`）+ platform（Web mock 对等）+ persistence（`save*` 链路透传）。
- 用户**主动行为**（发消息、手动改归属）仍正常刷 `updated_at`、正常置顶——只有「被切走对话的自动保存」走 `systemTouch:true`。

### 4.3 运行态 id 收敛

- 新建 `services/ids.ts` 共享 util，内部用 `crypto.randomUUID`（带回退，兼容无 crypto 的环境），保留 prefix 习惯。
- 替换 `agentLoop.ts:44` 的 `generateId` 与 `AgentPanel.tsx:51` 的 `generateMessageId`。
- `message:replaceConversation` 的 INSERT 改 `INSERT OR REPLACE` 作终极兜底（即便 id 仍碰撞也不再整事务回滚）。

### 4.4 左右栏共用数据源 + 过滤 UI

- 数据源统一为 `conversationHistory` slice（`conversations[]` + `selectedId`），左右栏共用 → 切换后两栏选中态天然同步。
- 抽 `useConversationManager` hook 承载 refresh / switch / new / 归属过滤，供左侧栏（S6）与右侧栏浮层（S7）复用。
  - **保守路线**（已决，见第七节）：hook 只抽**数据 / 过滤 / 基础 switch-new**；敏感的「切换竞态闸门」与「worktree exit」**暂留原处**，不动 M2-6 已稳定的竞态修复。
- 左侧栏：`conv-filter-row` 加「工作区范围」下拉（当前工作区 / Global / 全部，**默认当前工作区**）；条目加所属工作区小标记。
- 右侧栏：`AgentPanel` header 新增紧凑对话切换器（当前标题 + 下拉），点开**portal 浮层 + 点外关闭**（参照现有 `modelMenuOpen` 模式 `:103-112`），形态走**下拉浮层**（已决，参考 Windsurf）。

---

## 五、Stage 拆分（逐个，完整 7 个）

### M4-2-S1 — 问题9 系统 touch（保存不刷 updated_at）

- **做什么**：IPC + platform + persistence 三层支持「保存不刷 `updated_at`」，切走对话的自动保存不再改排序时间。
  - `conversation:update` 加 `systemTouch`（`true` 时不刷 `updated_at`；若 set 列表只剩这一项则空 set 直接 `return`，避免空 UPDATE）。
  - `message:replaceConversation` 加 `systemTouch`（不刷末尾 UPDATE 的 `updated_at`，即 `conversation.ts:362` 那处）。
  - Web mock `update` / `replaceMessages` 对等。
  - persistence `saveConversationSnapshot` / `saveAutosaveSnapshot` / `persistPlatformSnapshot` 透传 `systemTouch`。
  - `ConversationList.saveCurrentToHistory`（`:152`）与 `AgentPanel.handleNewConversation`（`:401`）的「切走保存」改 `systemTouch:true` 并**去掉 `timestamp:Date.now()`**。
- **改动文件**：
  - `synapse-app/electron/ipc/conversation.ts`
  - `synapse-app/src/platform/index.ts`
  - `synapse-app/src/services/conversationPersistence.ts`
  - `synapse-app/src/components/chat/ConversationList.tsx`
  - `synapse-app/src/components/layout/AgentPanel.tsx`
- **验收**：真机：左侧栏 ≥3 条对话，点中间一条切换，被点中条高亮且三条相对顺序不变（不再跳第二）；随后向该对话发一条新消息，它正常置顶（确认用户行为仍刷新排序）。Web 模式同样验证。`npm run build` + `electron:build` 通过。
- **工作量**：medium

### M4-2-S2 — 问题2b(1) 双修（id 收敛 + INSERT OR REPLACE）

- **做什么**：
  - 统一运行态 message id 到 `crypto.randomUUID`：新建 `services/ids.ts` 共享 util（带回退），替换 `agentLoop.ts:44` 的 `generateId` 与 `AgentPanel.tsx:51` 的 `generateMessageId`（保留 prefix）。
  - IPC `message:replaceConversation` 的 INSERT 改 `INSERT OR REPLACE` 作终极兜底。
- **改动文件**：
  - `synapse-app/src/services/ids.ts`（新建）
  - `synapse-app/src/services/agentLoop.ts`
  - `synapse-app/src/components/layout/AgentPanel.tsx`
  - `synapse-app/electron/ipc/conversation.ts`
- **验收**：脚本/单测同毫秒批量生成 1e5 个 id 无重复；真机长对话快速连发多轮不再弹「自动保存失败」toast；电编译通过。
- **工作量**：small

### M4-2-S3 — 工作区归属底座（DB + IPC + Web mock）

- **做什么**：
  - DB `ensureColumn` `conversations.workspace_path`（懒迁移，不写全表脚本）。
  - IPC `conversation.ts` 仿 `reasoning_effort` 三件套（自愈 `ensureColumn` + `hasColumn` 缺列降级）接 `workspace_path` 的 create / update / 读取。
  - `buildConversationFilters` 支持 `workspacePath` / `globalOnly`（三态：具体 path / `IS NULL` / 不限）。
  - `mapConversation` 映射 `workspacePath`。
  - Web mock `create` / `update` / `filterWebConversationSummaries` 对等。
- **改动文件**：
  - `synapse-app/electron/database.ts`
  - `synapse-app/electron/ipc/conversation.ts`
  - `synapse-app/src/platform/index.ts`
- **验收**：手动经 `platform.conversation.create({workspacePath})` 落库后，`list({workspacePath})` 只返回该工作区对话、`list({globalOnly})` 只返回 `workspace_path` 为 NULL 的、不传返回全部；旧库（无该列）启动自愈加列不报错、旧对话表现为 global。Electron + Web 两端一致。编译通过。
- **工作量**：medium
- **样板提示**：缺列降级三件套的现成样板是同文件里 `reasoning_effort` / `is_subagent` 的处理（`keyFiles` 已点明），照搬其 `ensureColumn` + `hasColumn` 降级写法。

### M4-2-S4 — persistence + store 接归属

- **做什么**：
  - `ConversationSnapshot` / `ConversationSummary` / `ConversationListFilters` 加 `workspacePath`（+ `globalOnly`）。
  - `save*` / `load*` / `branchConversation` 透传与继承 `workspacePath`。
  - `conversation` slice 加 `workspacePath` 字段 + `setConversationWorkspace` reducer + `setConversation` 可选回填（沿用其 `undefined-不覆盖` 语义）。
  - `conversationHistory.ConversationSummary` 加 `workspacePath`。
- **改动文件**：
  - `synapse-app/src/services/conversationPersistence.ts`
  - `synapse-app/src/store/slices/conversation.ts`
  - `synapse-app/src/store/slices/conversationHistory.ts`
- **验收**：`saveConversationSnapshot` 带 `workspacePath` 后 `loadConversationSnapshot` 能回带；`listConversationSummaries({workspacePath})` 过滤正确（含 legacy 对话视为 global 的兜底）；分支出的新对话 `workspacePath` 继承源对话。编译通过。
- **工作量**：medium

### M4-2-S5 — 创建 / 恢复 / 分支链路带归属

- **做什么**：
  - 新对话默认归 `state.workspace.currentPath`（`null` = global）。
  - `handleNewConversation`（`ConversationList` + `AgentPanel` 两入口）`clearConversation` 后置当前 `workspacePath`。
  - 恢复（autosave / load → `setConversation`）回填 `workspacePath`。
  - `handleBranch` 传 `meta.workspacePath` 继承源对话。
  - 首次保存把 `workspacePath` 落库。
- **改动文件**：
  - `synapse-app/src/components/chat/ConversationList.tsx`
  - `synapse-app/src/components/layout/AgentPanel.tsx`
  - `synapse-app/src/services/conversationPersistence.ts`
- **验收**：真机：打开工作区 W1 新建对话发消息 → 该对话 DB `workspace_path` = W1 path；切到 W2 新建对话 → 归 W2；未打开工作区时新建 → global；从某对话分支 → 新分支继承源 `workspacePath`。编译通过。
- **工作量**：medium

### M4-2-S6 — 左侧栏过滤 UI + 归属标记

- **做什么**：
  - `ConversationList` `conv-filter-row` 加「工作区范围」下拉（当前工作区 / Global / 全部，**默认当前工作区**）映射到 `activeFilters`。
  - 条目 `conv-item-meta` 加所属工作区小标记（path → basename；global 显示「全局」）。
  - 提供条目「移动到…」改归属（`updateConversationMetadata` 带 `workspacePath`）。
  - **建议抽 `useConversationManager` hook** 承载 refresh / switch / new / 归属过滤，供 S7 复用（保守路线：不抽切换竞态闸门与 worktree exit，见第七节决议）。
- **改动文件**：
  - `synapse-app/src/components/chat/ConversationList.tsx`
  - `synapse-app/src/hooks/useConversationManager.ts`（新建）
  - `synapse-app/src/services/conversationPersistence.ts`
  - `synapse-app/src/index.css`
- **验收**：真机：左侧栏默认只显当前工作区对话；切「全部」显示全部、切「Global」只显无归属；条目底部正确显示工作区名 / 全局；用「移动到…」把对话改到 Global 后过滤即时生效。编译通过。
- **工作量**：large

### M4-2-S7 — 右侧栏顶部对话管理区

- **做什么**：
  - `AgentPanel` header 新增**紧凑对话切换器**（当前标题 + 下拉）。
  - 点开**浮层**（portal + 点外关闭，参照 `modelMenuOpen` 模式 `:103-112`），复用 `useConversationManager`（同一 `conversationHistory` 数据源 + 同套工作区过滤）。
  - 浮层含：搜索、范围过滤、列表点选切换、新建、当前对话改归属。
  - 与左侧栏行为 / 数据一致。
- **改动文件**：
  - `synapse-app/src/components/layout/AgentPanel.tsx`
  - `synapse-app/src/hooks/useConversationManager.ts`
  - `synapse-app/src/index.css`
- **验收**：真机：右侧栏顶部下拉能列出与左侧栏一致的对话（同过滤口径），点选可切换、可新建、可改当前对话归属；切换后两栏选中态同步（共用 `selectedId`）；浮层点外部关闭。编译通过 + 完整回归（新建 / 切换 / 分支 / 删除 / 归档 / 搜索全过）。
- **工作量**：large

---

## 六、风险

> 设计 JSON 的 `risks` 字段为占位「（见上）」，下列风险据本里程碑真根因与 stage 内容提炼。

1. **外键级联误删**：`workspace_id` 带 `ON DELETE SET NULL` FK。若误把归属塞回 `workspace_id`，删工作区会把归属一并置空。**规避**：本里程碑只新增独立 `workspace_path` 列、绝不动 `workspace_id`（已在设计落实）。
2. **path 改名失联**：工作区改名 / 移动后，旧对话的 `workspace_path` 失配，对话表现为「不属于任何现有工作区」。**已知限制**（第七节已决接受），本期不做迁移；缓解是过滤器默认「当前工作区」但保留「全部」入口，用户随时能看到所有对话。
3. **老用户「对话不见了」恐慌**：左侧栏默认「当前工作区」会让升级后用户第一眼少看到对话（legacy 对话视为 global）。**缓解**：范围切换器要显著可见，且 legacy 对话明确归 Global 不丢；验收里专门校验「切全部能看到全部」。
4. **空 UPDATE 风险**：`systemTouch` 把 `updated_at` 从 set 列表移除后可能产生空 set。**规避**：S1 明确「空 set 直接 return」，避免发出无意义 / 报错的 UPDATE。
5. **缺列降级一致性**：旧库无 `workspace_path` 列时，IPC 必须缺列降级（`hasColumn` 判断），否则读写直接抛错。**规避**：仿 `reasoning_effort` 三件套，Electron 与 Web 两端都要对等处理。
6. **hook 抽取动到竞态修复**：`useConversationManager` 若把切换竞态闸门 / worktree exit 一起抽走，可能破坏 M2-6 已稳定的竞态修复。**规避**：走保守抽取路线（第七节已决），敏感逻辑留原处。
7. **左右栏数据不同步**：S7 浮层若另起一套数据源会与左侧栏脱节。**规避**：强制共用 `conversationHistory` slice 的 `selectedId`，验收里专门校验「切换后两栏选中态同步」。

---

## 七、openQuestions 决议（已决）

> 采纳子代理给出的倾向 / 建议默认值，并对齐主人最终决策，逐条固化为「已决」。

1. **归属身份键最终用工作区 path（而非 DB `workspace_id`）**
   **已决**：用工作区 path 作稳定身份键。这是绕开「渲染层不持有 ws id」的最稳方案。**工作区改名 / 移动导致旧对话失联属已知限制、本期接受**；**本期不做** path 迁移 / 重绑机制（可记入后续 Task 待复核，但不进 M4-2）。

2. **「多工作区时要求选择」 vs 真正并发多开**
   **已决**：维持**单当前工作区架构**（无并发多开，仅 `recentPaths` 历史）。本设计落地为「**默认归当前工作区 + 可选切到 Global / `recentPaths` 里其它工作区**」。**不引入真正并发多开多工作区**。

3. **左侧栏工作区范围过滤的默认值**
   **已决**：默认 **「当前工作区」**（凸显归属感）。同时**保留显著的范围切换器**（当前工作区 / Global / 全部）作为对冲，避免老用户「对话不见了」恐慌；legacy 对话明确归 Global 不丢。

4. **右侧栏顶部对话管理区形态：下拉浮层 vs 内嵌迷你列表**
   **已决**：走**紧凑下拉浮层**（省空间，参考 Windsurf Cascade），portal + 点外关闭，参照现有 `modelMenuOpen` 模式。

5. **`useConversationManager` hook 抽取深度**
   **已决**：走**保守路线**——只抽**数据 / 过滤 / 基础 switch-new**；敏感的「切换竞态闸门」与「worktree exit」**暂留原处**，以免动到 M2-6 已稳定的竞态修复。

---

## 八、该里程碑技术决策小结

| 决策点 | 结论 | 关键依据（文件:行） |
|---|---|---|
| 归属身份键 | 工作区 **path**（新增独立 `workspace_path` 列），不用 `workspace_id` FK | `database.ts:47/138`、`workspace.ts:3-9`、`fileSystem.ts`、`workspace.ts(ipc)` |
| `workspace_id` 处置 | 本里程碑**不动**（保持死字段，避免 `ON DELETE SET NULL` 级联误删） | `database.ts:47` |
| 三态过滤语义 | 具体 path / `IS NULL`(Global) / 不限(全部) | `conversation.ts:183-186`、`platform/index.ts:631` |
| 问题9 真根因 | `updated_at` 被无条件刷，须 IPC 层 `systemTouch` 开关，不能只在渲染层传参 | `conversation.ts:208/362`、`conversationPersistence.ts:740`、`loadPlatformSnapshot:676` |
| 问题2b(1) 真根因 | 弱熵 id 同毫秒碰撞 + 纯 INSERT 撞 UNIQUE 整事务回滚 | `agentLoop.ts:44`、`AgentPanel.tsx:51`、`conversation.ts:335`（vs `:290` 已是 OR REPLACE） |
| id 统一口径 | `crypto.randomUUID`（新建 `services/ids.ts`，对齐 `createMessageId`） | `conversationPersistence.ts:107` |
| 缺列降级样板 | 仿 `reasoning_effort` / `is_subagent` 三件套（`ensureColumn` + `hasColumn` 降级） | `conversation.ts`（`keyFiles` 已点明） |
| 左右栏数据源 | 共用 `conversationHistory` slice（`conversations[]` + `selectedId`） | `conversationHistory.ts` |
| hook 抽取深度 | 保守：只抽数据/过滤/基础 switch-new，竞态闸门与 worktree exit 留原处 | M2-6 竞态修复约束 |
| 右侧栏形态 | 紧凑下拉浮层（portal + 点外关闭，仿 `modelMenuOpen`） | `AgentPanel.tsx:103-112/1075-1132` |
| 默认过滤 | 当前工作区 + 显著范围切换器对冲 | S6 验收 |
| 边界不碰 | 「注入当前打开文件」属 M4-1，本里程碑不碰；systemPrompt 已注入 `workspaceName` | `systemPrompt.ts:62` |

**Web 端对等清单**（每个写库 stage 都要带）：`platform/index.ts` 的 `conversation.create` / `conversation.update` / `conversation.list` / `filterWebConversationSummaries`（`:302/334/332/631`）须与 Electron 同步实现 `systemTouch` 跳过 `updatedAt` 与 `workspacePath` 三态过滤——验收均含「Electron + Web 两端一致」。

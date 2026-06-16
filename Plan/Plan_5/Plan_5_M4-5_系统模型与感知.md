# Plan_5_M4-5 — 系统模型 + 自动标题 + 工作区感知 + prompt cache 稳定化

> 子代理（opus）逐文件读现有代码核对后的设计。本里程碑**只读 + 设计阶段已完成现状核对**，实现阶段不引入新架构，复用既有 slice / AIClient / 持久化范式。
> 本分卷已并入主人（用户）最终决策修正，凡与原设计稿冲突处一律以决策为准（见文末「技术决策小结」）。

---

## 一、目标

让 Synapse 的后台 LLM 任务（record 压缩摘要、自动标题、未来 `/compact` 手动压缩）使用一个**可独立配置的「系统模型」**（可选「跟随主模型」），并完成四件互相关联的事：

1. 给后台任务一条独立的模型通路（系统模型），与主对话模型解耦。
2. 把现在「纯字符截断」的对话标题，升级为**系统模型异步生成的语义标题**（带占位 + retry + 降级，全程不阻塞首轮流式）。
3. 给主对话注入「当前打开文件」的**工作区感知**（轻量、cache 友好，正文走工具按需读）。
4. **消除压缩摘要插入造成的 prompt-cache 前缀漂移**，使 system prompt 段保持 cache 友好。

依赖排序：**A 系统模型**（标题生成依赖它）→ **B prompt cache 稳定化**（独立，先做可降低 D 的回归面）→ **C 工作区感知** → **D 自动标题**。

---

## 二、覆盖问题（对应用户问题编号）

| 块 | 来源 | 说明 |
|---|---|---|
| A 系统模型 | 主人决策新增 | `agentSettings` 加独立 `systemModel` 字段 + SettingsPanel 系统模型下拉（含「跟随默认模型」空选项）；`recordGenerator` 与标题生成统一读 `systemModel \|\| currentModel`。后台任务（record 压缩摘要 / 自动标题）走系统模型。 |
| D 自动标题 | 主人明确策略 | 首条消息截断占位 `setTitle` → 系统模型异步生成 ≤15 字标题 → 成功更新 / 失败 retry 1 次 / 最终降级保留截断；非流式、低成本。 |
| C 工作区感知 | 问题 10① | `systemPrompt` 加 `<open_files>` 段，注入**当前活动文件路径 + 文件名 + 类型**（轻量、cache 友好），文件正文走工具按需读；workspace 文件树概要标记为**二期**。 |
| B prompt cache | 问题 10② | 消除压缩摘要插入导致的 `messages[1]` 前缀漂移：record 注入对**已落批**用确定性固定渲染（不做骨架↔全文动态升降级）稳定前缀；本地端点 caching 能力标注待验证、不强做。 |

> 主人决策对齐说明：本里程碑的「系统模型」即主人决策「新增独立『系统模型』配置（留『跟随主模型』空选项），后台任务（record 压缩摘要 / 自动标题）用它」的落地。自动标题策略「截断占位 + 异步系统模型生成 ≤15 字 + 失败 retry 1 次 + 降级保留截断」与主人决策逐字一致。工作区感知按主人决策「轻量（工作区信息 + 当前打开文件概要：路径 / 名 / 类型，不含文件正文）；工作区文件树概要列二期」执行。

---

## 三、确认现状 / 真根因（已逐文件读代码核对）

子代理已逐文件读代码核对，brief 转述基本准确，纠正 / 补充如下（**实现时以本节为准**）：

1. **持久化是自动的（brief 未提）**：`agentSettings` 整个 slice 经 `store/index.ts:168` 的 `persistMiddleware` 写入 `AGENT_SETTINGS_KEY`，且 `loadPersistedState`（`index.ts:227`）直接 spread `agentSettings`、**无字段白名单**。故新增 `systemModel` 字段 = **免费持久化 + 免费加载**，无需改任何持久化代码。

2. **自动标题行号实为 `agentLoop.ts:593-597`**（brief 写 593-596），条件：
   `!opts?.skipUserMessage && conversation.messages.length <= 1`，逻辑无误。**关键坑**：该段在 `while` 循环【之前同步】执行；异步标题生成必须 fire-and-forget，**绝不能 await**（否则阻塞首轮回复流式）。

3. **cache 破坏点精确定位 `agentLoop.ts:543-545`**：压缩分支里 `apiHistory` 首元素是
   `{ role: 'system', content: '[对话历史摘要]\n\n' + recordMd }`；`line 569` 它被拼成 `apiMessages` 的 **index 1**（index 0 是真 `systemPrompt`）。brief 说「插 messages[1]」准确。
   `recordMd` 来自 `buildRecordPrefix`（`agentLoop.ts:225`），已是只追加（`appendBatch` 永不重写旧批），**但** `buildRecordPrefix` 当前【会按 `contextWindow` 预算动态决定中间批骨架↔全文】（`line 274-282`）。故同一 record 在窗口 / 批数变化时渲染会变——**这正是 cache 漂移真因**；要稳定需给它一个「已落批确定性渲染」路径。

4. **系统模型 resolve 范式可照抄**：`agentOrchestrator.ts:282`
   `task.config.model || multiAI.subagentDefaultModel || agentSettings.currentModel`；
   子代理下拉范式 `SettingsPanel.tsx:1407-1414`（空 `option = '跟随主 Agent 模型'` + `availableModels.map`）。

5. **AIClient 非流式范式见 `recordGenerator.ts:212` `resolveClient`**（`temperature 0.2`、`stream:false`、`outputStrategy:'off'`）+ `callOnce`（`line 232`）用 `for await chunk of client.streamChat` 收集 content。标题生成应**复用此范式**。

6. **`currentModel` 在 `fetchModels` 后会做失效校验** `SettingsPanel.tsx:316`
   `if (!models.some(m => m.id === currentModel)) setCurrentModel('')`。`systemModel` **必须同样补失效回退**，否则保存了下线模型会让后台任务报错。

7. **`editorTabs` slice 有 `activeTabId` + `tabs[]{ id, filePath, fileName, type }`**（`type` 含 `welcome / settings / workflow` 等**非文件视图**，注入时需过滤）。`workspace` slice 确实**无文件树数据结构**（仅 `currentPath / name / recentPaths / synopsisReady / indexingProgress`），故文件树概要标记二期合理。

8. **`systemPrompt.PromptContext` 已有 `files?: string[]` 字段**且 `<workspace>` 段已渲染「已索引文件」，**但** `agentLoop.build()` 调用处（`387-391`）**从不传 files**。故 `<open_files>` 用**新段**而非复用 `files` 更清晰（`files` 语义是「已索引」，`open_files` 是「当前打开」）。

---

## 四、详细设计（含主人决策修正）

> 分四块，按依赖排序：**A 系统模型** → **B prompt cache 稳定化** → **C 工作区感知** → **D 自动标题**。

### 【A 系统模型】

1. **`agentSettings.ts`**：`AgentSettingsState` 加 `systemModel: string`（`initialState` 设 `''`，空 = 跟随 `currentModel`）；新增 reducer `setSystemModel(state, action: PayloadAction<string>)`；导出 `setSystemModel`。无需碰持久化（自动，见现状第 1 条）。

2. **新增统一 resolver**：在 `agentSettings.ts` 末尾或新建 `services/modelResolution.ts` 加纯函数
   `resolveSystemModel(state): string { return state.agentSettings.systemModel || state.agentSettings.currentModel || ''; }`。
   避免散落多处 `||` 表达式口径不一致。

3. **`recordGenerator.ts:209` `resolveClient`**：`const model = agentSettings?.systemModel || agentSettings?.currentModel || ''`（或调 `resolveSystemModel`）。其余不变。

4. **`SettingsPanel.tsx`**：在「默认模型」`setting-item`（`956-971`）之后插入「系统模型（后台任务用）」`setting-item`，照抄子代理下拉范式（`1407-1414`）：`select value={agentSettings.systemModel ?? ''} onChange dispatch(setSystemModel)`，首 `option value='' > '跟随默认模型'`，再 `availableModels.map`。加一行 `setting-hint` 说明「用于历史压缩、自动标题等后台任务，留空则跟随默认模型」。

5. **`systemModel` 失效校验**：`SettingsPanel.tsx:316` `fetchModels` 成功后那段，`currentModel` 失效已处理；**并列**补
   `if (agentSettings.systemModel && !models.some(m => m.id === agentSettings.systemModel)) dispatch(setSystemModel(''))`。

> **主人决策修正**：系统模型保留「跟随主模型」空选项（`value=''`）作为缺省，与决策「新增独立『系统模型』配置（留『跟随主模型』空选项）」一致。

### 【B prompt cache 稳定化】

**核心**：让压缩注入的前缀（`apiMessages` index 1）在「record 批集合不变」时**逐字不变**。

1. **`buildRecordPrefix`（`agentLoop.ts:225`）加一个「稳定渲染」语义**：对【已落批】（除最新一批外的所有批，或全部已落批）一律用其确定性形态渲染，**不随 `contextWindow` 预算在骨架↔全文间动态切换**。
   最小改法：新增 `buildStableRecordPrefix(record)`——所有已落批用固定策略，**不接受 `contextWindow` 参数、不跑 `RECORD_BUDGET_RATIO`**。`agentLoop` 压缩注入（`line 473 / 511`）改调 `buildStableRecordPrefix`。原 `buildRecordPrefix` 若别处仍用按需展开可保留，但**压缩稳定前缀路径必须走确定性版本**。
   固定策略采用**已决方案 B**（见下「openQuestions 决议」）：**头 N 批全文 + 其余骨架的固定规则**（cache 稳且可控，骨架批仍带 `record_read` 可展开标注，功能不回退）。

2. **注入文案常量化**：`line 544` `'[对话历史摘要]\n\n' + recordMd` 抽成模块常量前缀，确保前缀字符串本身不漂移。

3. **验证待办（不强做，标注）**：本地端点 `http://127.0.0.1:54861/v1` 是否支持 prompt caching（OpenAI cache 自动按前缀命中、Anthropic 需 `cache_control`）未知；本里程碑只保证「前缀稳定」这一 cache 友好前提，是否真命中由端点决定，列入 openQuestions（已记为待真机验证）。

> **主人决策对齐（record / compact）**：Synapse 现有「~90% 水位自动生成 record」的自动压缩**保持不变，不改成手动**。本块 B 优化的是「压缩注入前缀稳定」，与「自动 vs 手动」无关，自动压缩链路照旧。`/compact` 是 **M4-6 / M4-7 引入的新增手动压缩入口，与自动压缩并存、复用同一套压缩逻辑**；本里程碑的 `buildStableRecordPrefix` 同时服务自动压缩与未来 `/compact` 手动压缩。原设计稿若有「降级自动压缩 / 90% 水位改提示不压缩」措辞，一律以「保留自动压缩 + 新增 `/compact` 手动入口并存」为准。

### 【C 工作区感知 `<open_files>`】

1. **`systemPrompt.ts`**：`PromptContext` 加 `openFiles?: Array<{ path: string; name: string; type: string }>` 与 `activeFilePath?: string`。`SystemPromptBuilder.build` 在 `<workspace>` 段之后、**受 `injectContext` 开关控制**，渲染 `<open_files>` 段：列出每个打开文件（标注 active），**明确告知模型「文件正文未注入，需要时用读文件工具按需读取」**。

2. **`agentLoop.run`（`387-391` build 调用处）**：从 `rootState.editorTabs` 读 `tabs + activeTabId`，**过滤掉非文件视图 type**（`welcome / settings / workflow / review / showcase / unsupported`，即 `filePath` 为空的）后映射为 `openFiles`，找 `activeTabId` 对应 `filePath` 作 `activeFilePath`，传入 `promptBuilder.build`。

3. **cache 友好**：`<open_files>` 段在切换 tab 时会变，但它位于 system prompt 内、且打开文件集合通常一轮内稳定；**放在 system prompt 末尾**（identity / skills / rules 之后）使前面的大段静态前缀仍可 cache。

4. **打开文件数上限**：设 **20 个**（已决，见 openQuestions），超出标注「等 N 个」，避免几十个 tab 时 prompt 膨胀。**只注路径 / 名 / 类型，不注正文**（已决，正文走读文件工具）。

5. **文件树概要二期**：`workspace` slice 无文件树结构，需新建扫描（递归列目录 + 落库 / 缓存）才能注入「工作区文件树概要」，**本里程碑不做**，二期范围已决（见 openQuestions）。

> **主人决策对齐（工作区感知）**：轻量（工作区信息 + 当前打开文件概要：路径 / 名 / 类型，**不含文件正文**）；工作区文件树概要列二期。本块 C 完全按此执行。

### 【D 自动标题】

1. **抽共享非流式调用 helper**：在 `recordGenerator.ts` 或新 `services/systemModelClient.ts` 暴露
   `runSystemModelOnce(prompt: string, opts?): Promise<string | null>`，内部复用 `resolveClient`（已读 `systemModel`）+ `callOnce` 范式，失败 / 超时返回 `null`。**标题与 record 共用一条系统模型通路。**

2. **`agentLoop.ts:593-597`**：保留**截断占位** `setTitle`（首条消息立即可见）。其后【fire-and-forget】（不 await，包在 `void (async () => { ... })()` 内）调标题生成：
   - 构造 prompt：「用 ≤15 字中文概括这轮对话主题，仅输出标题，不要标点 / 引号 / 前缀」，喂首条 `userMessage` 文本（首轮发起时还没有 assistant 回复，**故只喂 user 文本即可**）；
   - 调 `runSystemModelOnce`；
   - 成功且非空则 `setTitle`（清洗：trim、去引号、截断到硬上限）；
   - 失败 **retry 1 次**（已决，间隔 ~800ms）；
   - 最终全失败**保留已设的截断占位**（不再 dispatch）。

3. **竞态守卫**：异步标题回来时若 `conversation.id` 已切换 / 对话已清空 / 标题已被用户手动改过，则**不覆盖**——回写前比对 `store.getState().conversation` 的 `id` 与发起时快照一致再 `setTitle`。

4. **成本**：非流式、`maxTokens` 极小（如 32）、`temperature` 低，单次调用，retry 上限受控。

5. **纯图片 / 附件降级**（来自风险第 6 条）：标题 prompt 喂的是首条 user 文本；若首条是纯图片 / 附件（`contentParts` 无文本），无可概括内容时**降级保留截断占位**，S4 须处理 `contentParts` 无文本的情况。

> **主人决策对齐（自动标题 + 系统模型）**：自动标题 = 截断占位 + 异步系统模型生成 ≤15 字 + 失败 retry 1 次 + 降级保留截断（逐字对齐）。后台任务（record 压缩摘要 / 自动标题）走「系统模型」配置；系统模型留「跟随主模型」空选项。

---

## 五、Stage 拆分（逐个列，完整覆盖 4 个 stage）

### M4-5-S1 — 系统模型字段与配置 UI（工作量：small）

- **做什么**：
  - `agentSettings` 加 `systemModel` + `setSystemModel`；
  - 新增 `resolveSystemModel` 纯函数；
  - `recordGenerator.resolveClient` 改读 `systemModel || currentModel`；
  - `SettingsPanel` 加「系统模型（后台任务用）」下拉（照抄子代理范式，含「跟随默认模型」空选项）+ `setting-hint`；
  - `fetchModels` 成功后补 `systemModel` 失效回退空。
- **改动文件**：
  - `src/store/slices/agentSettings.ts`
  - `src/services/recordGenerator.ts`
  - `src/components/settings/SettingsPanel.tsx`
  - `src/services/modelResolution.ts`（新建，可选）
- **验收**：
  - 编译过；
  - SettingsPanel 出现系统模型下拉，选中后刷新应用仍保留（持久化生效）；
  - 选「跟随默认模型」后下拉值为空且后台任务回退用 `currentModel`；
  - 获取模型列表后若已存系统模型不在列表则自动回退为空；
  - 手测：设一个系统模型，触发一次 record 压缩，确认 `resolveClient` 用的是系统模型（可临时 log 或看请求模型名）。

### M4-5-S2 — prompt cache 稳定化（工作量：medium）

- **做什么**：
  - 新增 `buildStableRecordPrefix(record)`（已落批确定性渲染、不依赖 `contextWindow`、不做骨架↔全文动态升降级，采用**已决方案 B：头 N 批全文 + 其余骨架固定规则**，骨架批保留 `record_read` 可展开标注）；
  - `agentLoop` 压缩注入路径（`line 473 / 511` 的 `recordMd` 计算）改用稳定版；
  - 注入文案前缀常量化（`line 544`）。
- **改动文件**：
  - `src/services/agentLoop.ts`
- **验收**：
  - 编译过；
  - 对同一 record（批集合不变）连续两次进入压缩分支，注入的 `apiMessages[1].content` **逐字一致**（可加临时断言或 log 比对）；
  - 功能回归：压缩仍能注入 record 摘要、`record_read` 按需展开提示仍有效（骨架批仍标注可展开）。

### M4-5-S3 — 工作区感知 `<open_files>`（工作量：medium）

- **做什么**：
  - `PromptContext` 加 `openFiles / activeFilePath`；
  - `SystemPromptBuilder.build` 渲染 `<open_files>` 段（受 `injectContext` 控制，注明正文需按需读取，置于 system prompt 末尾）；
  - `agentLoop.run` 从 `editorTabs` 读 `tabs + activeTabId`，过滤非文件视图后传入 `build`（上限 20，超出标注「等 N 个」）。
- **改动文件**：
  - `src/services/systemPrompt.ts`
  - `src/services/agentLoop.ts`
- **验收**：
  - 编译过；
  - 打开 2 个真实文件、激活其一后发消息，系统提示含 `<open_files>` 段并正确标注 active 文件；
  - 关闭全部文件 / 仅 welcome tab 时不渲染该段（或渲染「无打开文件」但不报错）；
  - 非文件视图 tab（设置 / 工作流）不被误列；
  - 手测：在请求体里确认 `<open_files>` 内容与当前 tab 状态一致。

### M4-5-S4 — 自动标题异步化（工作量：medium）

- **做什么**：
  - 抽 `runSystemModelOnce` 共享非流式 helper；
  - `agentLoop` 首条消息保留截断占位后 **fire-and-forget** 调系统模型生成 ≤15 字标题，成功清洗后 `setTitle`、失败 **retry 1 次**、最终降级保留截断；
  - 加对话 id / 标题未被手改的竞态守卫；
  - 处理首条纯图片 / 附件（无文本）的降级。
- **改动文件**：
  - `src/services/agentLoop.ts`
  - `src/services/recordGenerator.ts`（或新建 `systemModelClient.ts`）
- **验收**：
  - 编译过；
  - 发首条消息时标题立即显示截断占位、不卡首轮流式（异步不 await）；
  - 约 1-2 秒后标题被系统模型语义标题替换（≤15 字、无引号标点前缀）；
  - 断网 / 无 Key / 系统模型未配置时标题保持截断占位不报错；
  - 生成期间切换到别的对话不会把标题错写到新对话。

---

## 六、风险

1. **自动标题误用 await 会阻塞首轮流式回复**——必须 fire-and-forget，并加对话 id 竞态守卫防止把标题写到已切换的新对话（S4 验收专门覆盖）。
2. **`buildStableRecordPrefix` 策略选择**：若选「全部全文」，老对话批次多时注入量可能偏大撑预算；故**已决选方案 B「头 N 批全文 + 其余骨架」固定规则**更安全，但要**确保骨架批仍带 `record_read` 可展开标注**（功能不回退）。S2 须明确固定策略并跑回归。
3. **`systemModel` 持久化是自动的**（`agentSettings` 整 slice 入 localStorage），但若用户保存了一个后续从端点下线的模型，未做失效回退会让所有后台任务**静默失败**——S1 必须接 `fetchModels` 后的失效校验（与 `currentModel` 同款）。
4. **`<open_files>` 段在频繁切 tab 时变化**，虽放 system prompt 末尾保住前面静态前缀 cache，但若打开文件极多（几十个 tab）注入会偏长——**已决设条数上限 20**，超出标注「等 N 个」，避免 prompt 膨胀。
5. **本地端点是否真支持 prompt caching 未验证**，S2 只保证「前缀稳定」这一前提，真实命中率不可控（已列 openQuestion，待真机验证）。
6. **标题生成 prompt 喂的是首条 user 文本**（首轮发起时还没有 assistant 回复），若首条是纯图片 / 附件（无文本）需**降级保留截断占位**，S4 要处理 `contentParts` 无文本的情况。

---

## 七、openQuestions 决议（已采纳子代理倾向 / 主人决策默认值）

1. **工作区文件树概要（问题 10① 后段）是否纳入本里程碑还是二期？**
   **已决：列二期。** 本里程碑只做轻量 `<open_files>`（路径 / 名 / 类型，不含正文）。文件树概要需新建递归扫描 + 落库 / 缓存（`workspace` slice 当前无文件树结构），二期再拍板扫描深度、忽略规则（`node_modules / .git` 等）、刷新时机（打开工作区时 / 手动 / watch）、注入是全树还是顶层概要。与主人决策「工作区文件树概要列二期」一致。

2. **`buildStableRecordPrefix` 的固定策略选哪种？**
   **已决：方案 B —— 头 N 批全文 + 其余骨架固定规则。** cache 稳且可控，骨架批保留 `record_read` 可展开（功能不回退）；不选「全部全文」以免老对话批次多时撑预算。

3. **`<open_files>` 打开文件数上限 + 是否注入活动文件正文？**
   **已决：上限 20 个，只注路径 / 名 / 类型、不注正文。** 活动文件正文也不轻量注入，正文一律走读文件工具按需读取。与主人决策「工作区感知轻量、不含文件正文」一致。

4. **自动标题 retry 次数与间隔 + 标题字数硬上限？**
   **已决：retry 1 次、间隔 ~800ms；生成目标 ≤15 字，清洗时硬截留少量余量（到 ~20 字硬上限再裁）防截断丢字。** 与主人决策「失败 retry 1 次」一致。

5. **本地端点 `http://127.0.0.1:54861/v1` 是否支持 prompt caching？**
   **已决：本里程碑只保证「前缀稳定」这一 cache 友好前提，真实命中由端点决定，实际收益留真机验证。** 不在本里程碑强做 caching 适配（OpenAI 式自动前缀命中 / 额外字段）；前缀稳定化（S2）先行落地，真机验证 cache 是否命中后再决定是否补端点侧适配。

---

## 八、该里程碑技术决策小结

- **依赖与顺序**：A 系统模型 → B prompt cache 稳定化 → C 工作区感知 → D 自动标题。B 先于 D 做以降低标题异步化的回归面。
- **系统模型（A）**：新增独立 `systemModel` 字段（空 = 跟随 `currentModel`），靠 `agentSettings` 整 slice 的自动持久化「免费」入库 / 加载，无需改持久化代码；统一 `resolveSystemModel` 纯函数避免散落口径；UI 照抄子代理下拉范式 + 「跟随默认模型」空选项；**必须**补 `fetchModels` 后的失效回退（与 `currentModel` 同款），防下线模型静默拖垮后台任务。
- **record / compact 并存（B 的对齐重点）**：现有 ~90% 水位**自动**生成 record 的自动压缩**保持不变**；`/compact` 是后续里程碑新增的**手动**压缩入口，与自动压缩**并存、复用同一套压缩逻辑**。`buildStableRecordPrefix` 同时服务自动压缩与未来手动 `/compact`，不改自动 vs 手动的语义。
- **prompt cache 真因与修法（B）**：漂移真因是 `buildRecordPrefix`（`agentLoop.ts:225`，`line 274-282`）按 `contextWindow` 预算在骨架↔全文间动态切换，导致同一 record 在窗口 / 批数变化时渲染不同、`apiMessages[1]`（破坏点 `agentLoop.ts:543-545`、`line 569` 拼入 index 1）前缀漂移。修法 = 新增 `buildStableRecordPrefix`（已落批确定性渲染，方案 B：头 N 批全文 + 其余骨架固定规则，不依赖 `contextWindow`），压缩注入路径（`line 473 / 511`）改走稳定版 + 注入文案常量化（`line 544`）。骨架批保留 `record_read` 可展开标注，功能不回退。
- **工作区感知（C）**：新增 `<open_files>` 段而非复用已有 `files`（`files` = 已索引，`open_files` = 当前打开，语义分离更清晰）；从 `editorTabs`（`activeTabId` + `tabs[]{ id, filePath, fileName, type }`）取，过滤非文件视图 type（`welcome / settings / workflow / review / showcase / unsupported`，`filePath` 空的）；上限 20、只注路径 / 名 / 类型、正文走工具；段放 system prompt 末尾保住前面静态前缀 cache；文件树概要二期。
- **自动标题（D）**：截断占位（首条消息立即可见）+ fire-and-forget（绝不 await，`void (async()=>{})()`）系统模型生成 ≤15 字 + 失败 retry 1 次（间隔 ~800ms）+ 降级保留截断；竞态守卫（回写前比对 `conversation.id` 快照、标题未被用户手改）；纯图片 / 附件无文本时降级；非流式、`maxTokens` 极小、低 temperature，与 record 共用 `runSystemModelOnce` 系统模型通路。
- **复用范式**：模型 resolve 照抄 `agentOrchestrator.ts:282`；下拉 UI 照抄 `SettingsPanel.tsx:1407-1414`；非流式调用照抄 `recordGenerator.ts:212 resolveClient` + `callOnce`（`line 232`）。全程不引入新架构、不动主对话流式路径。

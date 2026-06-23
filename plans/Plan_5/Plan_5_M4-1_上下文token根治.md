# Plan_5 M4-1 — 上下文/token 机制根治

> 上下文窗口/token 口径三件套修复：图片附件 token 口径修正 + contextWindow 统一选择器 + 截断兜底护栏。
> 本里程碑产出 5 个 stage、改动 5 个文件（含 1 新建）。实现按本卷推进。
> 与设计稿对照：本里程碑全程不涉及 record/compact 机制，主人关于「保留自动压缩 + 新增 /compact 手动入口并存」的决策对本卷无冲突点，设计无需修正；openQuestions 已逐条按子代理倾向定案为「已决」。

---

## ① 目标

让「新对话带图发消息即触发上下文过长截断」的误判彻底消失，并把全应用对模型上下文窗口的认知统一到真实 `capabilities`。核心是三件事：

1. **修正 token 高估口径（治本）**：`agentLoop.ts` 里 `estimateNonTextPartsTokens` 把 base64 传输字节当 token 高估约 11 倍（甚至上千倍），图片改用视觉 token 固定值、文件改用「解码后内容字符」估算。
2. **统一 contextWindow 读取（治源）**：抽一个 `getModelContextWindow` 选择器，让 StatusBar / AgentPanel / agentLoop 三处统一读 `capabilities.contextWindow`，消除 StatusBar 的硬编码模型名→窗口映射。
3. **截断兜底护栏（防御加固）**：给 `compressContext` 与 `truncateOverLongHistory` 加护栏，保证纯历史 token 远低于上限时绝不截断当前消息、budget 有最小保底。

三项都**不依赖**给 `contextWindow` 加下限保护——实测网关无 context 字段、`findContextWindow` 名字推断已正确返回 128000，上限本身没问题（与主人决策「不给 contextWindow 加下限保护」一致）。

---

## ② 覆盖问题（对应用户问题编号）

- **问题4★（high）**：新对话带图即触发「上下文过长无法压缩，截断」。真根因为 `estimateNonTextPartsTokens` 把 base64 内联图/文件按传输字符长度 × 0.25 当 token 高估约 11 倍，撑爆阈值后落 `overLimitWithoutCompression` 弹截断 toast。
- **问题2a**：StatusBar 底部「Token:X/128.0k」的 128k 来自自带模型名→窗口硬编码映射，与真实 `capabilities.contextWindow` 脱节。
- **截断兜底加固（非编号问题，防御性）**：`compressContext` + `truncateOverLongHistory` 加护栏，纯历史 token 远低于上限时绝不截当前消息，budget 最小保底。

---

## ③ 确认现状 / 真根因（currentStateVerified）

> 已逐行读 `agentLoop.ts`(1-230,380-580)、`systemPrompt.ts`(全)、`modelCapabilities.ts`(全)、`StatusBar.tsx`(全)、`AgentPanel.tsx`(160-180,895-930,460-470)、`attachmentRefs.ts`(全)、`conversation.ts`(MessageContentPart 类型)。

### 问题4 真根因 100% 坐实（与诊断 brief 一致）

`agentLoop.ts:101-119` 的 `estimateNonTextPartsTokens`：

- **`image_url` 且 `url.startsWith('data:')` 分支（行 103-105）**：`total += Math.ceil(url.length * 0.25)`。data URI 长度 ≈ 原始字节 × 4/3，3.9MB 图 → base64 ≈ 520 万字符 × 0.25 ≈ **130 万 token**，远超阈值 128000 × 0.9 = 115200。
- **`image_url` 引用态（行 106-108）**：`part.size > 0` 时 `estimateBytesAsBase64Tokens(size) = ceil(size/3)`，3.9MB → 约 130 万 token，同样按字节当 token，对图片是错的。
- **`file` 分支（行 113-118）**：`data`（file_data / data base64）存在时 `Math.ceil(data.length * 0.25)`，把 base64 字符当 token，同样高估；其次 `size` 走 `ceil(size/3)`；都无走 `FILE_ID_PLACEHOLDER_TOKENS = 256`。
- **仅 `image_url` 的 else 分支（行 109-111，外链 http url 无 size 时）** 才用 `IMAGE_TOKENS_LOW(85)` / `IMAGE_TOKENS_HIGH(1100)` 这两个已存在但闲置的视觉 token 常量。修复就是让 `data:` / `size` 两条图片分支也走这俩常量。

### 触发链确认

`agentLoop.ts:414` `nonTextTokens = requestHistory.reduce(estimateNonTextPartsTokens)` → 行 415 `assembledTokens` 累加 → 行 422 `triggerTokens = max(assembledTokens, apiRealTokens)` → 行 423 `compressContext(modelContextWindow=128000, triggerTokens)`。

新对话 `messages.length < 6`，`compressContext`（`systemPrompt.ts:167-174`）返回 `overLimitWithoutCompression = true` → `agentLoop:552-563` 走 `truncateOverLongHistory` + 弹 warning toast「单条消息过长且无法压缩，已截断部分内容」。这正是用户看到的现象。

### 关键纠正 / 补充诊断 brief 的点

1. **brief 说「图片用现有 IMAGE_TOKENS_LOW/HIGH 常量」** —— 这俩常量（行 89-90）确实已存在，但当前只服务于外链 url 的 else 分支；`data:` / `size` 两条主路径（即真正高估的路径）反而没用它们。所以修复**不是「新增常量」而是「让已有常量覆盖 data: / size 分支」**。
2. **detail 取值的现实约束（brief 未提）**：`AgentPanel.tsx:466` 上传图写死 `image_url.detail = 'auto'`，且 `conversation.ts:9` 类型 `detail?: 'auto' | 'low' | 'high'`。所以实战中用户上传图几乎全是 `'auto'`。OpenAI 口径里 `auto` 等价 `high` 量级，故「无 detail / auto」应取 `IMAGE_TOKENS_HIGH(1100)` 而非 LOW，这是贴近真实又保守的固定小值。当前 else 分支 `detail === 'low' ? 85 : 1100` 的口径本身正确，复用即可。
3. **file 的 token 本质（brief 方向对但需细化）**：`attachmentRefs.ts:289` file 还原后以 `{ type: 'file', file: { filename, file_data: dataUrl } }` 发送，`file_data` 是完整 base64。但网关对 file 会**解码后按内容算 token**，故 base64 长度（× 4/3 膨胀）和原始字节都不是真 token。合理口径：有 `file_data`(base64) 时先解出原始字节数（base64 长度 × 3/4），再按「原始字节 ≈ 字符数、混合文本 ~0.3 token/字符」折算，给一个比「base64 长度 × 0.25」低约 4 倍的估值；仅 `size` 时同法 `size × 0.3`；都无走占位常量。

### 三处 contextWindow 读取点现状

- **`StatusBar.tsx:27-34`**：唯一真正脱节的一处。它只从 store 取 model 字符串（行 14），没取 `availableModels` / `capabilities`，纯靠 `model.includes('gpt-4') → 128000` 等映射，`gpt-5.5` 不含 `'gpt-4'` 落 else = 128000。值碰巧对但**机制错**（换模型 / 真有 context 字段时会偏）。
- **`AgentPanel.tsx:924`**：`effectiveContextWindow = currentCapabilities?.contextWindow ?? MAX_CONTEXT_TOKENS`，已读 capabilities（行 172），仅 fallback 写法不统一。
- **`agentLoop.ts:401-403`**：`currentModelOption?.capabilities?.contextWindow || currentModelOption?.contextWindow || MAX_CONTEXT_TOKENS`，已读 capabilities。

三处只有 **StatusBar 需要补接 capabilities**；抽统一选择器可一并消除 fallback 不一致。

### 护栏现状

- `compressContext`（`systemPrompt.ts:158`）只比 `currentTokens <= threshold`；
- `truncateOverLongHistory`（`agentLoop.ts:139-196`）按 `fixedTokens`（含 `nonTextTokens`）算 `budget = threshold - fixedTokens`，`budget < 0` 时置 0。

问题4 修复后 `nonTextTokens` 大幅下降，绝大多数带图场景根本不会再进 `overLimitWithoutCompression`；护栏是防御最后兜底（极端超长纯文本粘贴 + 修复后仍偶发误判）。

---

## ④ 详细设计（design，已按主人决策核对）

> 主人决策核对结论：本里程碑设计纯属 token 口径与上下文窗口读取的工程修正，**不触碰 record / compact / 自动压缩水位机制**，故无任何与「保留自动压缩 + 新增 /compact 手动入口并存」「contextWindow 不加下限保护」冲突之处——后者恰好与设计稿「不给 contextWindow 加下限保护」一致。设计原样采纳。

分三块，互相解耦，可独立验收。

### ═══ 块一：图片/文件 token 估算口径修正（治本，修问题4） ═══

在 `agentLoop.ts` 改 `estimateNonTextPartsTokens`（行 96-122），核心原则：**图片永远用视觉 token 固定值（与 base64/字节体积完全解耦）；文件用「解码后内容字符数」折算而非传输 base64 字节**。

**图片（image_url）三条分支统一收敛成一个 detail 决策函数 `imageVisionTokens(detail)`：**

- `detail === 'low'` → `IMAGE_TOKENS_LOW(85)`
- `detail === 'high'` 或 `'auto'` 或 `undefined` → `IMAGE_TOKENS_HIGH(1100)`

三条分支（`data:` / `size` 引用态 / 外链 else）全部改为 `total += imageVisionTokens(part.image_url?.detail)`。即：

- `data:` 分支：删掉 `url.length * 0.25`，改 `imageVisionTokens(detail)`
- `size` 分支：删掉 `estimateBytesAsBase64Tokens(size)`，改 `imageVisionTokens(detail)`
- else 分支：本就是 `imageVisionTokens` 逻辑，统一

这样无论图多大、base64 多长，单图固定 ≈ 1100 token，130 万 → 1100，**约降 1100 倍**，根治高估。

**文件（file）分支改为按「解码后字符内容」估算 `estimateFileContentTokens`：**

- 有 `file_data` / `data`（base64 dataUrl）：解出 base64 payload 长度 `L_b64` → 原始字节 ≈ `L_b64 × 3/4` → token ≈ 原始字节 × `FILE_TOKENS_PER_BYTE(取 0.3，覆盖文本/混合，宁多勿少)` → `Math.ceil`。比旧的 `L_b64 × 0.25` 约低 4.4 倍。
  - 注意：`data` 可能是裸 base64 或带 `data:` 前缀，需先剥掉 `data:...;base64,` 头再算长度（与 `attachmentRefs.sniffDataUrlBytes` 的 comma 切法一致，但只取长度不解码，零开销）。
- 仅 `size`：`Math.ceil(size × FILE_TOKENS_PER_BYTE)`。
- 都无：`FILE_ID_PLACEHOLDER_TOKENS(256)` 保留。

`estimateBytesAsBase64Tokens`（行 93-95）在图片分支已不再被调用；file 分支也改用 `FILE_TOKENS_PER_BYTE`，该函数将成死代码——**直接删除**（连同其上方注释），避免误导后人。

**★token 口径常量集中**：新增 `const FILE_TOKENS_PER_BYTE = 0.3`，与 `IMAGE_TOKENS_LOW` / `HIGH` / `FILE_ID_PLACEHOLDER_TOKENS` 放一起，更新这组常量上方的注释块（行 74-95），明确写清「传输字节 ≠ token，图片走视觉固定值，文件走解码内容估算」的口径，删掉旧注释里「≈字节/3」「url.length * 0.25」等错误口径描述。

### ═══ 块二：getModelContextWindow 统一选择器（修问题2a） ═══

新建 `src/store/selectors/modelSelectors.ts`（项目无 selectors 目录则新建；若已有放置惯例则跟随），导出：

- **`getCurrentModelOption(state)`**：从 `agentSettings.availableModels.find(id === agentSettings.currentModel)`，与 `agentLoop:400`、`AgentPanel:168` 同逻辑，集中一处。
- **`getModelContextWindow(state)`**：返回 `getCurrentModelOption(state)?.capabilities?.contextWindow ?? getCurrentModelOption(state)?.contextWindow ?? MAX_CONTEXT_TOKENS`。fallback 链与 `agentLoop` 现状一致，统一为唯一真相源。
- **可选 `getModelContextWindowForOption(option)`**：纯函数版，供已持有 option 的组件复用。

**三处接入：**

- **`StatusBar.tsx`**：删掉 `useMemo` contextWindow 硬编码块（行 27-34），改 `useAppSelector(getModelContextWindow)`。tokenCount 两态标识沿用现有 `apiTokenCount || estimatedTokenCount`（行 24），title 里「估算已用/API 用量」区分保留。
- **`AgentPanel.tsx:924`**：`effectiveContextWindow` 改用 selector（或 `getModelContextWindowForOption(currentModelOption)`），删本地 `?? MAX_CONTEXT_TOKENS`。
- **`agentLoop.ts:401-403`**：`modelContextWindow` 改调 `getModelContextWindow(rootState)`（agentLoop 已能拿 `store.getState()` / `rootState`），删本地三元 fallback。

**★Redux Toolkit 项目优先用 reselect `createSelector` 缓存**（避免 StatusBar 每次 render 重算 find）；若项目已有 selector 风格则跟随。

**已用 token 两态**：`estimateTokens` 估算态（无 API 实测时） vs `tokenUsage.promptTokens` 实测态，StatusBar 现已用 title 区分（行 79-81），此次保留并确保 `promptTokens` 优先级正确（`apiTokenCount` 来源即 `conversation.tokenCount`，需确认其是否 = `promptTokens`；若不是，StatusBar 显示值应优先 `tokenUsage.promptTokens`）。

### ═══ 块三：截断兜底护栏（防御加固） ═══

1. **`compressContext`（`systemPrompt.ts:167-174`）的 `overLimitWithoutCompression` 护栏**：当前只要 `messages.length < 6` 且超阈值就标 true。加一道「纯历史文本 token 护栏」——若被压缩段之外、即不含当前最新 user 消息的历史文本 token 远低于阈值（如 `< threshold × 0.5`），说明超额几乎全来自当前消息的非文本 part 估算（修复块一后这种情况应几乎绝迹，但作最后防线），则不标 `overLimitWithoutCompression`、不触发 truncate。实现：给 `compressContext` 增一个可选入参 `historyOnlyTokens`（调用方传「除最后一条 user 外的历史文本 token」），仅当 `historyOnlyTokens` 也接近阈值时才认为是真·历史超长。保持向后兼容（不传则维持现行为）。
2. **`truncateOverLongHistory`（`agentLoop.ts:139-196`）budget 最小保底**：当前 `budget = threshold - fixedTokens`，`budget < 0 → 0`，`budget = 0` 会把最长文本截到 0 字符（仅留 `TRUNCATION_NOTICE`），等于丢光当前消息正文。加 `const MIN_TEXT_BUDGET`（如 1024 token）：`budget = Math.max(budget, MIN_TEXT_BUDGET)`，保证再极端也给当前消息留最小可读正文，宁可略超阈值也不发空消息。同时在函数入口加断言式护栏：若 messages 里最后一条（当前 user 消息）文本 token 本身 `< budget`，则绝不截它，只截更早的历史长文本（**保护「当前消息」是块三的核心诉求**）。
3. 块一修复后，truncate 触发条件（`overLimitWithoutCompression`）在带图场景几乎不再命中，块三主要是防御极端纯文本粘贴；验收时重点确认带图新对话不再进 truncate 分支。

**★三块改动均不碰 `modelCapabilities.findContextWindow`（已确认正确）、不给 `contextWindow` 加下限保护。**

---

## ⑤ Stage 拆分

> 共 5 个 stage，全部列出。建议顺序：S1（治本）→ S2（建选择器）→ S3（接入选择器）→ S4（护栏）→ S5（集成自测）。S1/S2 必做，S4 同批做完更稳（见 openQuestions 决议）。

### M4-1-S1 — 图片/文件 token 估算口径修正（治本）

- **做什么**：重写 `agentLoop.ts` `estimateNonTextPartsTokens`——图片三分支统一走 `imageVisionTokens(detail)`（low=85，auto/high/undefined=1100）；文件改 `estimateFileContentTokens`（base64 解码后字节 × `FILE_TOKENS_PER_BYTE=0.3`，仅 size 时 `size × 0.3`，都无走 256）；删除已成死代码的 `estimateBytesAsBase64Tokens`；新增 `FILE_TOKENS_PER_BYTE` 常量并重写常量组上方注释块（行 74-95）纠正错误口径描述。
- **改动文件**：`src/services/agentLoop.ts`
- **验收**：代码审读——3.9MB 单图 `nonTextTokens` 从约 130 万降到 ≈ 1100；新对话带 1 张图，`assembledTokens` 远低于 115200，`compressContext` 不返回 `overLimitWithoutCompression`，agentLoop 不进 truncate 分支、不弹「上下文超长」toast。file 分支用 base64 解码字节 × 0.3 估算。手动核算或加临时 `console` 验证单图/单文件估值量级。无残留对 `estimateBytesAsBase64Tokens` 的引用（Grep 0 命中）。
- **工作量**：small

### M4-1-S2 — 抽 getModelContextWindow / getCurrentModelOption 统一选择器

- **做什么**：抽 `getModelContextWindow` / `getCurrentModelOption` 统一选择器到 `src/store/selectors/modelSelectors.ts`（用 reselect 缓存或跟随项目既有 selector 风格），fallback 链 `capabilities.contextWindow ?? option.contextWindow ?? MAX_CONTEXT_TOKENS`。
- **改动文件**：`src/store/selectors/modelSelectors.ts`（新建）
- **验收**：选择器单点返回正确——`gpt-5.5` 在 `availableModels` 含 `capabilities.contextWindow=128000` 时返回 128000；缺 `capabilities` 时回退 `MAX_CONTEXT_TOKENS`。TypeScript 编译通过，导出签名 `(state) => number`。
- **工作量**：small

### M4-1-S3 — 三处接入统一选择器

- **做什么**：三处接入统一选择器——`StatusBar.tsx` 删硬编码 contextWindow `useMemo`（行 27-34）改 `useAppSelector(getModelContextWindow)`，并确保已用 token 显示优先 `tokenUsage.promptTokens`（实测）否则 estimate（估算）、title 两态标识保留；`AgentPanel.tsx:924` 改用 selector；`agentLoop.ts:401-403` `modelContextWindow` 改调 `getModelContextWindow(rootState)`。
- **改动文件**：`src/components/layout/StatusBar.tsx`、`src/components/layout/AgentPanel.tsx`、`src/services/agentLoop.ts`
- **验收**：StatusBar / AgentPanel / agentLoop 三处不再各自硬编码或写本地 fallback 三元；切换不同模型（如造一个 `capabilities.contextWindow=200000` 的 mock）时 StatusBar 分母随之变化；`gpt-5.5` 仍显示 `/128.0k`。Grep 确认 StatusBar 无 `includes('gpt-4')` 残留。编译通过。
- **工作量**：medium

### M4-1-S4 — 截断兜底护栏

- **做什么**：`compressContext` 增 `historyOnlyTokens` 可选入参——仅当不含当前最新 user 消息的历史文本 token 也接近阈值时才标 `overLimitWithoutCompression`（向后兼容）；`agentLoop` 调用处传入 `historyOnlyTokens`；`truncateOverLongHistory` 加 `MIN_TEXT_BUDGET(1024)` budget 保底，且入口护栏保证当前（最后一条）user 消息文本 `< budget` 时绝不截它、只截更早历史长文本。
- **改动文件**：`src/services/systemPrompt.ts`、`src/services/agentLoop.ts`
- **验收**：构造极端长纯文本单条消息——仍能触发 truncate 但截断后当前消息保留 ≥ 1024 token 正文（非空）。构造「历史短 + 当前带图」场景——`historyOnlyTokens` 低，绝不进 truncate。不传 `historyOnlyTokens` 时行为与现状一致（回归不破）。编译通过。
- **工作量**：medium

### M4-1-S5 — 集成自测

- **做什么**：集成自测——`npm run build` 与 `npm run electron:build` 通过；真机回归 brief 问题4 原始复现路径——新对话首条带 3MB+ 图发送，确认不再弹「上下文超长/截断」toast、消息正常发出、图正常进请求体。
- **改动文件**（涉及但不新增逻辑，仅回归覆盖）：`src/services/agentLoop.ts`、`src/services/systemPrompt.ts`、`src/components/layout/StatusBar.tsx`、`src/components/layout/AgentPanel.tsx`、`src/store/selectors/modelSelectors.ts`
- **验收**：两条 build 命令零报错；真机——带大图新对话发送成功无截断 toast，StatusBar 显示 `/128.0k` 且 token 计数合理（单图约 +1100 而非 +百万级）；多模型切换 StatusBar 分母正确。
- **工作量**：small

---

## ⑥ 风险

1. **图片视觉 token 固定值会系统性低估「网关把整图按 base64 当上下文喂给纯文本模型」的极端非常规网关**——但 brief 已实测本地网关是标准 OpenAI 兼容视觉接口，且固定值口径与 OpenAI 官方一致，低估风险可接受；真要保险可把 `IMAGE_TOKENS_HIGH` 上调到 1500~2000 留余量（仍比 130 万低三个数量级）。
2. **`FILE_TOKENS_PER_BYTE=0.3` 对纯英文文本偏高、对压缩二进制（被当文件传）可能偏低**；但文件场景远少于图片，且 0.3 已是保守上界（英文真实约 0.25），对触发判定方向安全（宁多勿少）。
3. **块三 `historyOnlyTokens` 新入参若调用处计算口径与 `compressContext` 内部不一致，可能护栏失效或误判**——需保证传入的是「除最后一条 user 外历史的纯文本 token」，与 `compressContext` 内 `countConversationTokens` 同函数计算。
4. **`MIN_TEXT_BUDGET=1024` 在 `fixedTokens` 已逼近 threshold 的病态场景会让总量略超 threshold**——这是有意取舍（宁可略超也不发空消息），但需确认本地网关对略超阈值的输入不会硬 400（标准网关按真实 token 计、估算略超不影响）。
5. **StatusBar 当前 `apiTokenCount` 来源是 `conversation.tokenCount`，需确认它 = `promptTokens` 还是 `totalTokens`**；若是 `totalTokens` 则显示「已用」会含上一轮 completion、与分母语义不符，S3 需顺带校正为优先 `tokenUsage.promptTokens`。
6. **selectors 目录是新建**——需确认项目无既有 selector 放置惯例（如直接放 slice 内），若有则跟随而非另起目录，避免引入新模式违反「遵循现有结构」。

---

## ⑦ openQuestions 决议（已决）

> 全部按子代理给出的倾向/建议默认值定案。

1. **IMAGE_TOKENS_HIGH 是否上调留余量（如 1500）？**
   **已决：保持 1100**（与 OpenAI 官方口径一致）。上调会让带多图对话压缩稍早，无必要；即便最坏低估也比旧值低三个数量级，触发判定方向安全。如真机回归发现极端网关偏差再单独评估上调到 1500~2000。

2. **FILE_TOKENS_PER_BYTE 是否认可 0.3，或按 mime 细分？**
   **已决：先用单值 0.3**，简单可靠。不按文件 mime 细分（文本类 0.25 / 未知二进制更高占位）。0.3 已是保守上界，文件场景远少于图片，方向安全（宁多勿少）。

3. **getModelContextWindow 选择器放置位置？**
   **已决：新建 `src/store/selectors/modelSelectors.ts` 目录**，前提是实现时先确认项目无既有 selector 放置惯例。若发现项目已有 selector 惯例（如直接放对应 slice 内或 `modelCapabilities.ts` 旁），则跟随既有惯例而非另起目录，避免引入新模式违反「遵循现有结构」。

4. **StatusBar「已用 token」在有 API 实测时是否一律显示 `tokenUsage.promptTokens` 而非 `conversation.tokenCount`？**
   **已决：是，有 API 实测时一律优先 `tokenUsage.promptTokens`**。实现 S3 时先确认 `conversation.tokenCount` 的真实来源与语义（prompt vs total）：若它实为 `totalTokens`（含上一轮 completion），则与分母语义不符，必须改为优先 `tokenUsage.promptTokens`；若它本就 = `promptTokens` 则维持但显式走 promptTokens 链路。

5. **块三护栏是否降为可选/低优先（先上块一块二，块三视真机回归再做）？**
   **已决：块一、块二、块三同批做完**。块一治本后块三实际触发概率极低，但同批完成更稳、避免遗留防御缺口；接受在工期紧张时拆分（块一块二必做、块三可延后），但默认目标是一次性做完 S1~S5。

---

## ⑧ 该里程碑技术决策小结

- **治本点单一明确**：问题4 的唯一真根因是 `agentLoop.ts:101-119` `estimateNonTextPartsTokens` 把 base64 传输字节当 token。修复核心一句话——**图片走视觉固定值（与体积解耦）、文件走解码后内容估算**，单图 130 万 token → 1100，约降 1100 倍。
- **复用已有常量而非新增机制**：`IMAGE_TOKENS_LOW(85)` / `IMAGE_TOKENS_HIGH(1100)` 本就存在，只是没覆盖到真正高估的 `data:` / `size` 主路径；修复是「扩大已有常量的覆盖面」，不是新造口径。
- **detail 默认取 high(1100)**：因 `AgentPanel.tsx:466` 写死 `detail='auto'`，实战图几乎全是 auto，按 OpenAI 口径 auto ≈ high，取 1100 既贴近真实又保守。
- **文件唯一新增常量 `FILE_TOKENS_PER_BYTE=0.3`**：解出 base64 原始字节 × 0.3，比旧 `base64长度 × 0.25` 低约 4.4 倍；`estimateBytesAsBase64Tokens` 随之成死代码并删除。
- **contextWindow 收敛为单一真相源**：抽 `getModelContextWindow` 选择器，三处接入，消除 StatusBar 唯一脱节的硬编码模型名映射；优先 reselect 缓存避免 render 重算。
- **不动 `findContextWindow`、不加 contextWindow 下限保护**：实测上限本身正确（gpt-5 名字推断 → 128000），与主人决策一致，避免无谓兜底。
- **护栏是「最后防线」而非主修**：块一治本后带图场景几乎不再进 truncate；块三保护「当前消息绝不被截空」（`MIN_TEXT_BUDGET=1024` + 历史 token 护栏 + 当前消息保护断言），向后兼容（不传 `historyOnlyTokens` 维持现行为）。
- **与 record/compact 无关**：本里程碑全程不触碰自动压缩水位/record 生成/`/compact` 入口，主人「自动压缩 + /compact 手动入口并存」的决策在本卷无落点，无需修正设计。

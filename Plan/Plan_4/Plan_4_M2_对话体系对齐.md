# Plan_4_M2 — 对话体系对齐 MC红石AI c-r-m 设计（record 多批次重构）

> 来源：「MC红石AI引入开发对话1」conversationId `db141b55-a7d2-41a9-ab84-9648592adc32`（claude-code，86 轮，设计讨论密集区轮次 72-82）。Synapse 与该项目同源使用 conversation-record-memory 体系，本文件把那边用户拍板的设计对齐到 Synapse。

## 一、用户拍板的决策（2026-06-15）
1. **record 改「多批次追加 + 渐进式读」架构**（替代现在的「合并全文」，解决套壳膨胀 + 回溯精确两个问题）
2. 分支记 parent 关系
3. 90% 改判「组装后的请求体」大小（B 方案：先组装请求体 + 本地 tokenize + 判 90%）
4. 压缩 fallback 崩溃恢复（同步生成 + 可中止 + 半成品不污染 + 下次回到压缩前一刻）
5. 附件分离存储（文件夹 ID + 指针，反对 base64 内嵌）

## 二、借鉴的设计要点（那边讨论原话提炼）

### 三概念不变式（地基）
- **本地存储对话(全量) ≠ 请求体**。请求体(对话部分) = `[record 概括体 + 原文]`，加 system prompt 一起发。
- **90% 指请求体大小**到 maxContext 90% 时触发压缩。
- **不变式**：一次压缩到下次压缩之前，record 概括体不变、只有原文部分变长。

### record 多批次
- record = 批次列表（如 [1-3, 4-12, 13-25, 26-36]）；压缩只**追加新批次到末尾，已有批次完全不动**。
- 新批次生成输入 = **旧 records 骨架形式 + 新增轮次原文**（不重喂全量原文让模型覆盖全程）。
- 防膨胀靠「**改读不改写**」：渐进式读——record 越长，越靠前的老批次读得越简略。具体算法那边**也未定稿**（先留接口/分块结构，算法后续）。参考 mcp-memory-store：头尾截断 + 骨架正则提取 + 块级选择读 + nextReadHint 续读。

### 最近窗口 / 90% 判定
- 最近窗口 = **token 为主 + 轮次保底**（MIN_TURNS=1，一轮 = user-model 一来一回；单轮超大也至少留 1 轮）。
- 90% 判：**组装请求体 → 本地 tokenize 估算 → 判 90%**（B 方案，"别怕麻烦"；否决了"用上一轮真实 token 近似"）。
- 不单设「压缩后原文窗口 30%」预算，最近窗口的确定是唯一统一算法；压缩 = 把 records 末尾到最近窗口起点之间的原文压成新一段 record。

### 回溯（批次整体保留）
- 回溯到消息 M → 按 token+轮次算保留多少原文 → **M 所在的 record 批次整体拉回原文** → 之前批次留作新 record → 再走压缩检查。
- 算例：record [1-3,4-12,13-25,26-36]，回溯到 24（落在 13-25 批次）→ 实际保留 13-24 全部原文 → 新 record=[1-3,4-12]、原文=13-24。
- 代价：回溯近 100% 触发再压缩、要等待（接受，是必要的）；优化方向：record 尽量细分批次、避免大批次频繁。

### 分支
- **分支 = 回溯 + 另存为新对话**；分支/子代理对话各自独立 ID + **记录 parent 归属关系**。

### 压缩 fallback（健壮性）
- record 生成做**同步**（像 OpenAI/CC，异步不现实）；压缩时显示「压缩中」、用户可中止/关进程。
- fallback：未完成数据不污染整体状态，**下次打开回到「压缩前那一刻」**，可从头重压（崩溃恢复）。

### memory
- 模型自写自读；自动注入**至多 top-K(K=5) 标题**，内容模型自己去读；五件套 write/query/read/update/delete；**不做 MCP，内化为工具原生实现**；memory **全局**但对话可自分组，memory **锚定 source conversation**、随对话归属变化锚定不同分组（类 workspace 效果）。

### 附件
- **分离存储**：文件夹 ID（对话 UUID）+ 本地指针/链接，借鉴 Antigravity `brain` 结构；反对 base64 融进 jsonl（膨胀）；字段不冗余。

### 其他敲定的小决策
- system 运作模型单独配置（独立 baseUrl + key）；Mode 补齐 CC 5 档 + 高危拦截清单；消息渲染 react-markdown+gfm+katex+代码高亮+工具卡片；token/思考层级真实 fetch。

## 三、Synapse 现状 vs 目标（gap）
| 维度 | 现状 | 目标 |
|---|---|---|
| record 结构 | 单条 contentMd「合并全文」(recordGenerator 每次揉全文) | 多批次追加、已有不动 |
| 90% 判定 | 用上一轮 API tokenUsage | B 方案：组装请求体+本地 tokenize+判 |
| 回溯 | clampRecord 数字 clamp(M2-1) | 批次整体保留(M 所在批次拉回原文) |
| fallback | generateRecord 失败回退字符截断 | + 崩溃恢复(回压缩前一刻、可中止) |
| 附件 | 可能 dataURL/base64 内嵌 | 分离存储(文件夹ID+指针) |
| 分支(M2-3 未做) | — | 回溯+另存为+记 parent |
| 渐进式读 | 无 | 留接口/分块结构，算法后续 |

## 四、不照搬（MC红石AI 特有）
红石沙盒可视化 / Verilog·MCHPRS·Nucleation 仿真 / `/build` 等红石斜杠命令 / 模红械电领域；memory 默认分组名 redstone-design；那边从零搭 harness（Mode 补档/消息渲染/katex 等 Synapse 已完成）。

## 五、已定最终方案（2026-06-15 用户拍板，晚上继续实现）

### 决策全集
1. **record 改多批次追加**（替代合并全文）
2. **DB 懒迁移**：旧单条 record 被读到时即时包成 1 个「历史批次」；新增 `batches_json` + `record_schema_version` 列；旧 `content_md` 列保留作回滚；不写全表迁移脚本（读时升级、下次压缩自然回写）。
3. **渐进式读（防注入膨胀）= token 预算 + 头尾策略融合 + 按需展开工具 + 正则骨架**（详见下）
4. **90% 判定改 B 方案**：先组装请求体(system + record概括 + 最近窗口原文) → 本地 tokenize 估算 → 判是否到 contextWindow 90%（替代「上一轮 API tokenUsage」）。最近窗口 = token 为主 + 轮次保底(MIN_TURNS=1)。
5. **压缩 fallback 崩溃恢复**：record 生成同步、压缩中可中止、半成品不污染、保留「压缩前一刻」快照供重压。
6. **附件分离存储 + 存量也迁移**：新附件走 文件夹ID(对话UUID)+指针；写迁移把已有内嵌 dataURL 也转分离存储。
7. **分支 = 回溯 + 另存为新对话 + 记 parent**。

### record 多批次数据模型（设计 workflow 维度A）
```
interface RecordBatch {
  index; roundStart; roundEnd;       // 用户轮次范围(含)
  stepStart; stepEnd;                // 步骤范围(不含 tool，对齐 agentLoop requestHistory 口径)
  contentMd;                         // 本批独立完整过程日志
  skeleton;                          // 骨架(正则从 contentMd 提取: ## 标题 + 首行要点)
  phases; timeSpan; createdAt;
}
interface SynapseRecord {
  conversationId; batches: RecordBatch[];   // 有序，压缩只 append 末尾、已有永不重写
  totalRounds; totalSteps; lastUpdatedRound; timeSpan;  // 派生水位(=末批)，append 时同步
  schemaVersion(=2); updatedAt;
}
```
recordStore 新 API：`appendBatch`（追加+同步水位，幂等：本批 stepStart≠末批 stepEnd 则拒绝脏写）、`clampToBatch(keptRounds,keptSteps)`（回溯：找 M 落在哪批→该批及之后整批丢弃回原文、之前批保留→归零则 delete）、`getRecordSkeleton`（各批骨架拼接）。recordGenerator 改 `generateBatch`（输入=旧批骨架+本批新增原文 → 只产本批，不再合并全文；删 buildUpdatePrompt 那套全文重写）。agentLoop 压缩改：getRecord→末批 stepEnd 为起点切 batchSlice→generateBatch→appendBatch（不再整条覆盖）。

### 渐进式读算法（融合，已定）
- 每批两形态：**全文 contentMd** / **骨架 skeleton**（正则提取，零成本）。
- 注入分级（融合 token预算 + 头尾）：
  - **头尾保底**：最老 1-2 批 + 最新若干批 → 全文（保住「开头背景 + 最近进展」）。
  - **token 预算**：在头尾基础上，从最新往前累加全文，record 注入总量控制在 contextWindow 的 X%（X 待定，建议先 ~25-30%）内；超预算的**中段批次降级为骨架**。
  - 结果 = 头(老1-2批全文) + 中段(骨架) + 尾(最新批 token预算内全文)。
- **按需展开工具**：被降级为骨架的批次，AI 可调内置工具 `record_read(conversationId, batchIndex)` 取该批全文（类比 memory「注入标题、内容自读」/ conversation 按需读原文）。

### 分 stage 计划（晚上从 M2-R1 开始）
- **M2-R1** 数据模型 + DB 懒迁移 + recordStore API（RecordBatch/SynapseRecord + batches_json/version 列 + 懒迁移 + appendBatch/clampToBatch/getRecordSkeleton + 正则骨架提取）
- **M2-R2** recordGenerator `generateBatch`（骨架+新原文→新批）+ agentLoop 压缩改 appendBatch
- **M2-R3** 渐进式读注入（头尾+token预算融合分级）+ `record_read` 按需展开工具（注册进 toolRegistry）
- **M2-R4** 回溯批次保留（clampToBatch 接 AgentPanel invalidateRecordForTruncation）+ UI 压缩点按批次（多分隔线）
- **M2-R5** 90% B 方案（agentLoop 组装请求体 + 本地 tokenize + 判）
- **M2-R6** 压缩 fallback 崩溃恢复（同步 + 可中止 + 压缩前快照）
- **M2-R7** 附件分离存储 + 存量迁移
- **M2-3** 对话分支（回溯+另存为新convId+parent + copyRecord 多批次）
- 其后：**M2-5** git worktree agent 执行（绑定方式押"对话级"待最终确认）、**M2-6** 复制消息+mode per-conv、**M3** Multi-AI

### 实现注意（维度A风险）
- step 口径全程对齐「不含 tool」（agentLoop:96 / clamp keptSteps / RecordBatch.stepStart/End）。
- appendBatch 原子性（后端原子 IPC 或幂等校验防 fallback 重入丢批）。
- 注入只认 batches；旧 content_md 列保留不动作回滚保险。
- 渐进式读现阶段先按上述融合分级；mcp-memory-store 的块级 nextReadHint 续读可作 record_read 的参考。

## 六、附件分离存储最终方案（2026-06-16 反重力调研后定稿）

> 编号说明：对应原 §五分 stage 的 M2-R7，实际执行为 **M2-R6**（R1 已合并原 R1+R2+R4，后续顺延：R3 渐进读 / R4 90% / R5 fallback / R6 附件分离）。

### 背景：现状膨胀
附件(图片/文件) base64 **双重内联**：`contentParts.image_url.url` + `message.attachments[].payloadUrl/previewUrl` 都存 base64，进 messages 表 + 压进 record 源 + autosave。一张图存多份、DB 巨大、变卡。

### 反重力(Antigravity)调研结论（子代理 a6b9c414，记忆已存）
- 对话本体(`conversations/<id>.pb`，加密) 与 媒体实体(`brain/<convId>/` 明文文件) **物理分离**；正文用**绝对路径**引用媒体。
- **命名用时间戳 → 无内容去重**（同图实测存 3 份）= 反重力的不足。
- → Synapse 仿效「本体/实体分离 + 正文只放引用」，但用 **sha256 内容寻址** 反超去重。

### Synapse 附件分离设计（定稿）
1. **对话本体/DB 只存引用**：消息里图片从 base64 改 `{ id, sha256, name, mime, kind, size }`；不进 record 源、不进 autosave。
2. **附件实体内容寻址存储**：`attachments/<sha256[:2]>/<sha256>.<ext>`（两级分桶防单目录爆炸）；写前算 sha256，命中已存在直接复用 → **天然去重**。
3. **统一引用层**：`contentParts.image_url` + `message.attachments[]` 都引用同一 sha256，不再各存 base64。
4. **附件账本表** `attachments(sha256 PK, mime, kind, size, refCount, createdAt)`；删/编辑移除附件 refCount-1，归零 GC 删实体。
5. **读时还原**：发 API / 渲染时按 sha256 取回 base64/blob URL（platform.attachment.get）。
6. **懒迁移**：读到旧内联 base64 → 抽离到附件存储 + 换 sha256 引用（用到才迁、无启动卡顿，与 record/DB 懒迁移一脉相承）。

### 网页+桌面统一（落地形态）
- **sha256 引用层 = 统一抽象边界**：DB schema、引用格式、上层逻辑(上传/读取/还原/渲染/迁移)两端**完全同一套代码**。
- **blob 后端两端实现**（压在引用层下、对上层透明）：桌面 = 本地文件系统 `attachments/` 目录；网页 = IndexedDB。
- `platform.attachment` 抽象：`put(blob)→sha256` / `get(sha256)→blob` / `delete(sha256)` / `has(sha256)`。
- ⏳ **网页端「真·一套 SQLite 引擎完全统一」（sql.js WASM + IndexedDB 持久化）= 用户想要但工作量大，往后推**；现阶段先用「引用层统一 + blob 后端各自实现」。

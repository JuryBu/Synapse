# Plan_5_M4-8 — 请求稳定性：retry/fallback 重连 + 进度显示 + 本轮计时

> 现有基础（升级/补缺，非从零）：`aiClient.streamChat` real 分支已有完整指数退避重试（M2-S 任务2 已做）；单条 assistant run 计时已完整实现（MessageBubble）。本里程碑是「补缺口 + 修真根因 + 格式微调 + 范围决策」，不是推翻重做。

---

## 一、目标

让发送给模型的请求——**流式与非流式两条路径**——在遇到可重试故障（网络 / 超时 / 5xx / 限流，以及被网关包装成 HTTP 400 的上游故障）时自动指数退避重连：

1. **重连进度同时显示在两处**：状态区（StatusBar，已有）+ 正在生成的消息气泡内（`reconnect i/N`，新增）。
2. **消息底部展示本轮耗时**：从发出到完成，实时刷新、完成定格、支持「26 m 39 s」量级（带空格 + 补 hour 位）。
3. **可重试 vs 不可重试的判定集中到一个可测的分类函数** `classifyError`，杜绝「上游故障被网关包装成 HTTP 400 → 被当成参数错直接失败、不重连」这个核心 bug。

一句话核心：**真根因不是「400 不该重试」，而是「判定只看 status code、不看 body 文案」**——把被网关包装成 400 的可重试上游故障误判成了不可重试的参数错。

---

## 二、覆盖问题（对应用户问题编号）

本里程碑覆盖设计稿 `coveredIssues` 列出的 6 项：

1. **请求失败要自动 retry/重连，带 fallback**。
2. **UI 显示重连进度 `reconnect 1/5...`**。
3. **消息底部显示本轮总用时计时（26 m 39 s）运行时实时刷新**。
4. **截图中 HTTP 400 `upstream_error` 直接失败、无重连** —— 真根因 = 判定只看 status code，把被网关包装成 400 的上游故障误判为不可重试参数错（本里程碑核心修复）。
5. **off/pseudo 非流式路径完全无 retry 的覆盖缺口**（brief 未提及，现状真实存在）。
6. **退避 sleep 期间用户 stop 不响应 abort 的小缺陷**。

---

## 三、确认现状 / 真根因（currentStateVerified，对 brief 的逐条纠正）

读 `aiClient.ts` / `agentLoop.ts` / `conversation.ts` / `MessageBubble.tsx` / `AgentPanel.tsx` / `StatusBar.tsx` / `attachmentRefs.ts` 后，对 brief 转述的诊断做如下纠正——**这是本里程碑的事实地基，开发前务必逐条核对，避免重做已有功能**：

### 【1】「失败是否有 retry？……无重连」——部分不准

`aiClient.streamChat` 的 **real 流式分支【已有】完整指数退避重试**：
- 429 → `aiClient.ts` line **329** 重试。
- `status >= 500` → line **353** 重试。
- fetch / 流读取异常 catch → line **467-488** 重试。
- `maxRetries = 3`，`delay = min(1000 * 2^retries, 10000)`。
- 每次退避前 `yield {type:'retry', retry:{attempt, maxRetries, reason}}`（M2-S 任务2 已做）。
- **401/403/404/其它（含 400）落 line 366 兜底 error 后直接 `return`，不重试。**

→ 结论：流式 real 路径的重试骨架已在，本里程碑是**重构判定逻辑**（抽 `classifyError`）而非新建重试。

### 【2】「HTTP 400 upstream_error 直接失败」的真根因（关键纠正，本里程碑核心）

400 当前确实不重试，且在「400 = 参数错」语义下这**本来是对的**。但截图里的实际情况是：**网关把上游 5xx / 超时 / 连接失败包装成 HTTP 400 + body 带 `upstream_error` 文案**返回（与前两轮诊断已知的「网关行为特殊」一致）。

**真根因 = 判定只看 HTTP status、不看 body 文案**，把「可重试的上游故障（被包装成 400）」误判为「不可重试的参数错」。**这是本里程碑要修的核心。**

### 【3】「项目已有 retry 进度可观测的基础，见 conversation slice retry 字段」——纠正

`retry` 字段**不在** conversation slice，而在 `aiClient` 的 `StreamChunk` 类型（line **57**）。conversation slice **没有** retry/reconnect 持久字段。

重连进度当前实现链路 = agentLoop 收 retry chunk → `dispatch setConnectionStatus('checking')` + `addNotification(id=retry-${runId}, 「连接不稳，正在重试 N/M」)`（`agentLoop.ts` line **711-728**），StatusBar 渲染 `checking` → 「检测中…」。

→ 即「状态区」已有，但**消息气泡内没有 `reconnect` 显示**（这是 S3 要补的）。

### 【4】「本轮计时……类似 thinking Thought for Xs，扩展为整轮」——纠正

**单条 assistant run 的计时【已完整实现】，不是从零做**：
- `MessageBubble.tsx` line **168** `now` state。
- line **170** `live` 判定。
- line **180-184** `setInterval(300ms)` 实时刷新。
- line **171** `elapsedMs = durationMs ?? (now - timestamp)`。
- line **145-151** `formatDuration`（已支持「Xm Ys」）。
- line **299-306** 渲染「`${streamLabel} for ${formatDuration(elapsedMs)}`」，aborted 显示「Stopped」。
- 完成时 `agentLoop.ts` line **849-878** 写 `durationMs` 定格。

→ 要做的只是**格式微调**（带空格的「X m Y s」+ 补 hour 位）与**「计时范围」决策**（已由主人拍板为端到端，见第七节）。

### 【5】off/pseudo 非流式路径完全无 retry（brief 没提的缺口）

off/pseudo 策略走 `completeChat`（`aiClient.ts` line **196-267**），它直接 `requestChat` → 非 ok 就 `yieldResponseError` 返回，**完全没有重试**。这与全局「请求要有 retry/重连」决策冲突，**本里程碑必须补**（S2）。

### 【6】退避等待不监听 abort

退避等待 `await new Promise(r => setTimeout(r, delay))`（`aiClient.ts` line **335 / 359 / 487**）不监听 abort，长 delay（最高 10s）期间用户 stop 要等满才停。`waitPseudoDelay`（line **158-172**）已有「可中断 sleep」范本可复用（S1）。

### 【7】持久化风险

`sanitizeMessagesForPersistence`（`attachmentRefs.ts` line **190-228**）是**白名单剔除式**——只清 base64，其余字段经 `...msg` 全量保留。故若把 `reconnect` 瞬态字段直接挂 message 上，会被原样落库，历史恢复后带假「重连中」。**S3 需在 sanitize 显式剔除该字段**（并核对 `conversationPersistence` 的 message 落库口径）。

---

## 四、详细设计（按主人决策修正后）

### 4.1 核心抽象：`classifyError` + `retryableSleep`

新增两个纯函数 / 工具，集中所有「可重试性」判定：

```
classifyError(status?, body?, errName?) → {
  retryable: boolean,
  category: 'rate_limit' | 'server_error' | 'network' | 'gateway_upstream'
          | 'client_error' | 'auth' | 'aborted' | ...,
  userMessage: string,   // 重试耗尽 / 不可重试时给用户的明确文案
}
```

判定规则（优先级从上到下）：
- **abort**（`errName === 'AbortError'` 或 signal 已 abort）→ `retryable:false, category:'aborted'`（**绝不能当网络错重试**，否则 stop 触发重试死循环，见风险三）。
- **429** → `retryable:true, category:'rate_limit'`。
- **status >= 500** → `retryable:true, category:'server_error'`。
- **fetch / 流读取异常（非 abort）** → `retryable:true, category:'network'`。
- **400 / 422 且 body 命中上游特征词**（保守词表，如 `upstream_error` / `upstream` / `bad gateway` / `timeout` / `connection` 等）→ `retryable:true, category:'gateway_upstream'`。命中时打 `console.warn` 输出 body 摘要，便于真机调参。
- **400 / 422 且 body 无上游特征** → `retryable:false, category:'client_error'`（真参数错）。
- **401 / 403 / 404 / 其它** → `retryable:false`。

`retryableSleep(delay, signal)` = 可中断的退避 sleep，复用 `waitPseudoDelay`（line 158-172）的「可中断 sleep」范本：监听 `signal.abort` 立即 `reject(AbortError)`，正常超时则 resolve。

### 4.2 流式路径重构（streamChat real 分支）

用 `classifyError` 替换散落的 429 / 5xx / catch 判定。新的优先级链：

```
isStreamUnsupported 降级（保持现有逻辑，最高优先）
  > classifyError.retryable → 退避重试（yield retry chunk）
  > 不可重试 → yieldResponseError
```

三处退避 sleep（line 335 / 359 / 487）一律改用 `retryableSleep(this.abortController?.signal)`。

### 4.3 非流式路径补 retry（completeChat）

把 `requestChat → !ok → yieldResponseError` 改为**重试循环**，复用同一套 `classifyError` + `retryableSleep`：可重试时 `yield retry chunk`（带 `streamMode = mode`，让 agentLoop 知道是非流式重试）并退避重试；达上限或不可重试才 `yieldResponseError`；fetch 异常同样进 `classifyError`。**与现有 auto→pseudo 降级互不冲突**。

### 4.4 重连进度进气泡

- conversation slice 新增**瞬态** `reconnect` 字段 + `setMessageReconnect` action。
- agentLoop retry chunk 分支：`set`（写 `{attempt, max}`）；收到实质数据 / 本轮收尾 → `clear`。
- `MessageBubble` 在 stream-state 区渲染「`reconnect i/N`」。
- **持久化隔离**：`sanitizeMessagesForPersistence` 显式剔除 `reconnect` 字段，并核对 `conversationPersistence` 落 message 口径确保不落库。

> 关于「展示位置」的决策（openQuestion 4）：气泡内 `reconnect i/N`（主推）+ 状态栏（已有）保留；**去掉当前那条持续 notification**，避免三处冗余。详见第七节。

### 4.5 本轮计时校准（按主人决策：端到端）

- `formatDuration` 改带空格「X m Y s」+ 补 hour 位（≥1h 显示「H h M m S s」）。
- **计时范围 = 端到端**（用户发出 → 整个 agent loop 完成，含多轮工具调用）。已由主人拍板（见下）。
  - 实现：`agentLoop` 记录 `loopStartedAt`，在**最终完成消息**附「端到端总计时」徽标。
  - **不破坏逐条 run 计时**：每条 assistant run 仍各自显示自己的 run 计时；端到端总计时只挂在 loop 的**最终完成消息**那一条上，避免每条都显示端到端造成重复/误导（对应风险四）。

### 4.6 maxRetries 配置化

提为共享常量 `MAX_RETRIES`，`streamChat` / `completeChat` / UI 文案的 `N` 统一引用。默认值见第七节决策（取 **5**，写死常量，不做设置项）。

---

## 五、Stage 拆分（完整 5 个 stage，逐个列）

### S1 — 错误分类 + 可中断退避（aiClient 核心）｜effort: medium

- **做什么**：
  - 新增 `classifyError(status / body / errName → {retryable, category, userMessage})` 与 `retryableSleep(delay, signal)`。
  - 重构 `streamChat` real 分支：用 `classifyError` 替换散落的 429 / 5xx / catch 判定，把 `400/422 + upstream_error 文案`纳入可重试（`gateway_upstream`）。
  - 优先级 = `isStreamUnsupported 降级` > `classifyError 重试` > `不可重试 yieldResponseError`。
  - 三处退避 sleep（line 335 / 359 / 487）改用 `retryableSleep(this.abortController?.signal)`。
- **改动文件**：
  - `synapse-app/src/services/aiClient.ts`
- **验收**（单测 / 构造请求）：
  1. 返回 HTTP 400 且 body 含 `upstream_error` → 走退避重试并发 retry chunk。
  2. 返回纯 400 参数错（body 无上游特征词）→ 不重试直接 error。
  3. 429 / 503 / 网络异常 → 重试。
  4. 401 / 403 / 404 → 不重试。
  5. 退避等待期间调 `stop()` → sleep 立即中断、本轮标 aborted 不残留。

### S2 — completeChat（off/pseudo 非流式路径）补 retry 覆盖｜effort: medium

- **做什么**：把 `requestChat → !ok → yieldResponseError` 改为重试循环，复用 S1 的 `classifyError` + `retryableSleep`；可重试时 `yield retry chunk`（`streamMode = mode`）并退避重试，达上限或不可重试才 `yieldResponseError`；fetch 异常同样进 `classifyError`。
- **改动文件**：
  - `synapse-app/src/services/aiClient.ts`
- **验收**：`outputStrategy = off` 与 `pseudo` 时，制造 5xx / 网关 400 upstream / 网络故障 → `completeChat` 自动重试且 agentLoop UI 显示 reconnect 进度；400 参数错不重试；与现有 `auto → pseudo` 降级互不冲突。

### S3 — 重连进度进消息气泡｜effort: medium

- **做什么**：
  - conversation slice 加瞬态 `reconnect` 字段 + `setMessageReconnect` action。
  - agentLoop retry chunk 分支 `set`，收到实质数据 / 本轮收尾 `clear`。
  - `MessageBubble` 在 stream-state 区渲染「`reconnect i/N`」。
  - `sanitizeMessagesForPersistence` 显式剔除 `reconnect` 字段（并核对 `conversationPersistence` 落 message 口径确保不持久化）。
- **改动文件**：
  - `synapse-app/src/store/slices/conversation.ts`
  - `synapse-app/src/services/agentLoop.ts`
  - `synapse-app/src/components/chat/MessageBubble.tsx`
  - `synapse-app/src/services/attachmentRefs.ts`
  - `synapse-app/src/services/conversationPersistence.ts`
- **验收**：网关错 / 断网重试时，正在生成的气泡显示「`reconnect 1/N`」随重试递增；收到首个 token 或本轮结束后该提示消失；重启 / 历史恢复后消息不带残留 `reconnect`。

### S4 — 本轮计时校准｜effort: small

- **做什么**：
  - `formatDuration` 改带空格「X m Y s」+ 补 hour 位（≥1h 显示「H h M m S s」）。
  - **按主人决策实现端到端计时**：`agentLoop` 记 `loopStartedAt` 并在最终完成消息附端到端总计时徽标，不破坏逐条 run 计时。
- **改动文件**：
  - `synapse-app/src/components/chat/MessageBubble.tsx`
  - `synapse-app/src/services/agentLoop.ts`
- **验收**：长任务气泡实时刷新且显示「26 m 39 s」量级格式（带空格、超 1h 有 h 位），完成后定格为最终耗时，stop 后显示「Stopped」；端到端总计时正确挂在 loop 最终完成消息上，不在每条 run 上重复。

### S5 — maxRetries 配置化 + 全量自测｜effort: small

- **做什么**：`maxRetries` 提为共享常量 `MAX_RETRIES`（默认值 **5**，见第七节决策），`streamChat` / `completeChat` / UI 文案的 `N` 统一引用。
- **改动文件**：
  - `synapse-app/src/services/aiClient.ts`
- **验收**：`npm run build` 与 `npm run electron:build` 均过；真机制造网关 upstream 错误，端到端看到气泡 reconnect 进度计数 + 本轮计时实时刷新 + 重试耗尽后给出明确错误文案。

---

## 六、风险

1. **body 文案匹配是启发式**：网关的 upstream 错误文案不确定，特征词表可能漏判（漏判退化为现状 = 400 直接失败，**不致命**）或误判（把真参数错当上游故障重试 3-5 次，多耗几秒 + 几次无谓请求）。缓解：**保守词表 + 仅对 400/422 生效**（其它已可重试状态不依赖文案），并把命中的 body 摘要打 `console.warn` 便于真机调参。
2. **reconnect 瞬态字段漏剔除会落库**，导致历史恢复带假「重连中」。S3 必须**同时**改 `sanitizeMessagesForPersistence` 并核对 `conversationPersistence` 的 message 落库口径。
3. **可中断退避把 `reject(AbortError)` 引入新路径**：需确保 `streamChat` real 分支的外层 catch（line 467 AbortError 判定）与 `completeChat` 外层（off/pseudo 包裹 catch）都正确识别为 aborted 而非误当网络错再重试，否则 **stop 会触发重试死循环**。
4. **端到端计时挂点要明确**（已选端到端范围）：多轮工具调用每轮新建 assistant 消息（agentLoop 每 round 一条），端到端总计时**只挂 loop 最终完成消息**那一条，避免每条都显示端到端造成重复 / 误导。
5. **`maxRetries=5 + delay cap 10s` 最坏退避总等待约 `2+4+8+10+10 ≈ 34s`** 才放弃，长任务下用户感知卡顿。缓解：配合气泡 reconnect 进度让等待可见（本里程碑已含），并考虑首次重试 delay 不要太长。

---

## 七、openQuestions 决议（已决）

> 与设计稿子代理给的「倾向/建议」默认值一致处采纳默认；计时范围按主人最终决策落定。

1. **本轮计时的「本轮」范围** —— **已决：端到端**（用户发出 → 整个 agent loop 完成，含多轮工具调用）。这与主人决策「本轮计时 = 端到端（用户发出→整个 agent loop 完成，含多轮工具）」一致。实现上：逐条 run 仍各自显示 run 计时；端到端总计时记 `loopStartedAt`，只挂在 loop 最终完成消息那一条上。

2. **maxRetries 取 3 还是 5；是否做成设置项** —— **已决：取 5**（brief 文案「reconnect 1/5」暗示 5），**写死共享常量 `MAX_RETRIES`，不做设置项**（与「保持轻量、不引入多余设置面板项」一致；后续若有需要再提为配置）。

3. **fallback 第三层（同端点重试耗尽后自动降级到系统模型 / 备用端点）** —— **已决：本里程碑不做**，留待 M4-7 系统模型配置落地后再接（采纳子代理建议的边界）。本里程碑只做「同端点指数退避重连」，不做跨端点 / 跨模型降级。

4. **重连进度展示位置** —— **已决：气泡内 `reconnect i/N`（主推）+ 状态栏（已有）保留，去掉当前那条持续 notification**（采纳子代理「倾向气泡 + 状态栏、去掉 notification」），避免三处同时显示冗余。

5. **400 + upstream_error 是否给用户「把 400 当可重试」开关** —— **已决：默认开启启发式即可，不加开关**（采纳子代理默认建议）。保守词表 + 仅对 400/422 生效 + `console.warn` 摘要 已足够覆盖；真出现「真参数错被叫 upstream」再按词表收紧，不预先做设置项。

---

## 八、该里程碑技术决策小结

- **核心是「判定逻辑」而非「重试骨架」**：流式 real 路径的指数退避重试 M2-S 已做完，本里程碑把散落的 status code 判定**收敛到单一可测函数 `classifyError`**，并修复真根因——**只看 status、不看 body**，把网关包装成 400 的上游故障误判为参数错。
- **两条路径对齐**：流式（streamChat real）已有重试 → 重构；非流式（completeChat，off/pseudo）**零重试 → 补齐**。两条路径复用同一套 `classifyError` + `retryableSleep`。
- **abort 优先级最高**：可中断退避引入 `reject(AbortError)` 新路径，分类函数必须把 abort 判在最前、判为不可重试，三处外层 catch 都要识别 aborted，杜绝 stop 触发重试死循环。
- **瞬态字段严格隔离持久化**：`reconnect` 是 UI 瞬态，sanitize + persistence 双重显式剔除，防止历史恢复带假「重连中」。
- **计时端到端 + 逐条并存**：run 计时不动（已实现），端到端总计时新增、只挂 loop 最终完成消息一条；`formatDuration` 升级为带空格 + hour 位，支持「26 m 39 s」「1 h 5 m 0 s」量级。
- **maxRetries 写死 5**，共享常量统一 `streamChat` / `completeChat` / UI 文案；最坏退避约 34s，靠气泡 reconnect 进度让等待可见。
- **fallback 第三层划界到 M4-7**：本里程碑只做同端点重连，跨端点 / 系统模型降级等系统模型配置落地后再接。

### 关键文件清单（keyFiles）

| 文件 | 角色 |
|---|---|
| `synapse-app/src/services/aiClient.ts` | `classifyError` / `retryableSleep` / streamChat 重构 / completeChat 补 retry / `MAX_RETRIES` 常量（S1/S2/S5） |
| `synapse-app/src/services/agentLoop.ts` | retry chunk 处理 / `setMessageReconnect` 调度 / `loopStartedAt` 端到端计时（S3/S4） |
| `synapse-app/src/store/slices/conversation.ts` | 瞬态 `reconnect` 字段 + `setMessageReconnect` action（S3） |
| `synapse-app/src/components/chat/MessageBubble.tsx` | `reconnect i/N` 渲染 + `formatDuration` 升级 + 计时展示（S3/S4） |
| `synapse-app/src/components/layout/AgentPanel.tsx` | 重连进度 / 计时呈现关联视图（参照） |
| `synapse-app/src/components/layout/StatusBar.tsx` | 状态区 `checking → 检测中…`（已有，保留） |
| `synapse-app/src/store/slices/agentSettings.ts` | 设置关联（参照；本里程碑 maxRetries 不入设置项） |
| `synapse-app/src/services/attachmentRefs.ts` | `sanitizeMessagesForPersistence` 剔除 `reconnect`（S3） |
| `synapse-app/src/services/conversationPersistence.ts` | 核对 message 落库口径不持久化 `reconnect`（S3） |

# Plan_7 — M8 最终 19 点反馈整合

> 主人最终 18 点挑剔 + 第 19 点（个性化）。经 workflow `wg7p83xc7`（6 路核实，memory 路 API 断连主线补查）拿到代码依据，整合分类。
> 全部做完后进入「子代理深化 + browser-use」。工作方式：先整合（本文件）→ 对范围 → 并行/串行施工 → 双编译 + CDP 真机 + 分批 commit。

## 一、核实关键结论（含与主人观察的出入，需对齐）

| 点 | 核实现状 | 与主人观察 |
|---|---|---|
| #6 插话 | **当前是 queue 语义**（`setStreaming(false)` 在整个 while 循环后 = 整个 run 结束才发） | 主人观察「下个 step 插入」——实为短 run 很快结束的错觉；要的「interrupt」当前**没有** |
| #3 对话级设置 | bpc/compact 两阈值**已对话级持久化+切回生效**（resolveCompactThreshold 对话级优先） | 主人说「没生效」——需确认你测的是不是 bpc/compact 之外的设置，或真有 bug 要复现 |
| #13 崩溃恢复 | **已做**（appendBatch 原子+幂等+expectedStepStart 门，压缩半截崩溃回压缩前一致态） | 主人担心的「污染」其实已防住；缺的是**阻塞态 UI** |
| #14 record 分级 | **有三级分层但是静态按位置分**（头2批全/尾1批全/中间骨架/超阈降titleOnly），**无** hit/距离动态读级 | 主人问「是吗还是已做」→ 答：框架有、但不是 hit+距离动态那套 |
| #17 插件页按钮 | handleOpenExtensionPath **已实现**（PowerShell explorer.exe） | 主人说「没用」——需复现（可能 explorer 命令在某场景失效） |
| #4 sandbox_exec 互斥 | **Synapse 参数全透传、不补空字段**；空 command 来自模型生成或 server schema | 根因在模型/server，Synapse 可选缓解：调用前剥离空字符串可选参数 |

## 二、分类

### A 类 — 确认 bug，直接修
- **#2 设置中止**：根因＝AgentPanel useMemo 依赖含全部 agentSettings，改任一设置→重建 AIClient→重建 AgentLoop→旧流被废弃中止。修：流式中不重建（isStreaming 排除/ref 缓存）或排队到流结束应用。
- **#15 压缩后卡片不更新**：taskHeadline 与 record 脱钩。修：压缩落库成功后从新批摘要 dispatch setTaskHeadline 同步卡片。
- **#13 压缩阻塞无 UI**：已阻塞（isStreaming 锁）但无提示。修：加压缩中阻塞态 UI（提示「压缩中，请稍候」+ 禁发禁操作可见化）。崩溃恢复已做不动。
- **#8 md 编辑器预览缺 KaTeX+图片**：MarkdownViewer 只有 remarkGfm。修：补 remarkMath+rehypeKatex（仿 MessageBubble）+ 图片协议处理。
- **#9 编辑消息框旧工具栏**：MessageBubble 编辑态仍 4 按钮（附文件+附图 emoji）。修：对齐底部 C3 加号小窗。
- **#12 / 命令无彩色 chip + 压缩点不可见**：① / 命令做成 atomic 彩色 chip（仿 @）② /compact 压缩点在对话中标记更显眼 + 配合消息导航展示压缩点。
- **#17 SKILL.md 正文未读**：extensionManager 只存 name/description、未读 SKILL.md 正文。修：loadSkillsContent 读正文注入。插件页按钮先复现再定。
- **#H6补 消息导航 UI**：浮层太透明与下方文字重叠 → 底色调实（近不透明玻璃）；高度到上限出滚动条（不无限增长）。
- **#3 对话级设置（主人确认无 bug）**：降级为「确保重启后每个对话的参数覆盖正确加载持久」——施工时验证切回对话加载该对话的 bpc/compact 覆盖即可。

### B 类 — 明确改造 / 新功能
- **#6 双队列 + task_boundary 本质（主人纠正，重点）**：
  - **task_boundary 是「过程/干活包裹」**——AI 不该在 task 里跟用户汇报/说话，应 end_task_boundary 收口后在「无 task」状态下才汇报。当前 AI 常 task 还 active 就结束 run 输出，造成「task 运行中插入」的错觉。systemPrompt 必须跟 AI 讲明此用法（与 #7 一起）。
  - **interrupt 队列**：task 运行中下个空闲 step 就插入（agentLoop while 循环工具调用间检查）——绑 **Ctrl+Enter**。
  - **queue 队列**：等 AI 彻底干完、收口 task、进入无 task 汇报态才发——绑 **Enter**。注意 queue 的触发不是单纯 isStreaming 下降沿（run 结束），要等「真正空闲（无 active task_boundary + 无 streaming）」。
  - **Shift+Enter** 换行；这套**运行时键位**（区别于非运行时的 sendKeyMode）**设置可改**。
  - conversation slice 加 interruptMessages（与 queuedMessages 并存）；两队列 UI 图五样式（编辑/叉），interrupt 项可切 queue、queue 项可切 interrupt。
- **#11 输入框上方三框**：从上到下 queue / interrupt / review changes 三框；review 框列改动文件+点击打开+全部 accept/reject（从编辑器 tab 搬来/并存）；每框至多 4 项超出现滚动条。
- **#7 H5 语义修正**：当前注入「提醒汇报」→ 改成「检测到长时间在同一 task_boundary/同一轮没开/没切 task → 请求体注入系统提示让 AI 开/切 task」（不打扰用户、不强制汇报）。
- **#16 Exa MCP 接入**：纯配置——mcp_config.json 加 exa server（格式同现有三个，二进制约 `~/.gemini/antigravity/mcp-*/dist/index.js`，需确认路径）。无代码改动。
- **#19 个性化**：settings 加 用户头像/用户ID或昵称/AI头像/AI昵称；头像上传自动压缩大图 + 裁剪框拖动预览；MessageBubble 改读设置渲染（替代硬编码图标色块 + 「你」/「Synapse AI」）。

### C 类 — 架构 / 待主人拍板
- **#14 record 分级升级**：现静态位置分级 → 主人要 hit round/phase（模型读 record 标记找到/没找到）+ 距离当前轮 综合相乘动态三级（brief 标题 / summary 概要 / full 全文）。中等难度（2-3 天），需新增 batch 反馈标记链路。**要不要做？**
- **#18 记忆收敛**：原生记忆（4 内置工具 + IPC + memoryStore）vs memory-store MCP（11 工具）重叠。主人要「原生为主、MCP 仅多源（读 CC/WSF）」。方案待定（见待拍板）。
- **#3 对话级设置**：bpc/compact 已实现；主人说没生效——**需复现确认范围**（是否要把更多设置纳入对话级覆盖）。

### 已 OK（不动）
- #5（小标题/发送键/切页/底色/收口）、#10（归 tb 可选）

### 待主人细化
- #1 review changes 界面（主人还要认可 UI 后细化）

## 三、施工编排（并行/串行）

### 并行轨道（独立文件，子代理外包）
- MarkdownViewer KaTeX+图片（#8）
- Exa MCP 配置（#16，配置文件 + 验证）
- 个性化头像/昵称（#19，settings + 头像组件 + MessageBubble 渲染）
- SKILL 正文读取（#17）

### 串行轨道（核心交织文件 AgentPanel/agentLoop/conversation slice，主线顺序）
1. #2 设置中止（AgentPanel useMemo / AIClient 生命周期）
2. #15 压缩后卡片更新 + #13 压缩阻塞 UI（agentLoop compactNow + 卡片）
3. #7 H5 语义修正（agentLoop 注入）
4. #6 双队列 + #11 三框（AgentPanel + agentLoop + conversation slice，大）
5. #12 / 命令 chip + 压缩点（输入框 + 消息导航）
6. #9 编辑消息框对齐加号（MessageBubble）

## 三-补、主人拍板结果（已定）
- **#14**：✅ 做动态分级（hit round/phase + 距离当前轮 综合相乘 → brief/summary/full），新增 batch 反馈标记链路。
- **#18**：✅ systemPrompt 引导优先原生记忆，mcp__memory-store__* 记忆类工具标注「仅跨源（读 CC/WSF/Codex 等别的源）才用」。
- **优先级**：✅ A 类 bug 先清 → B 类新功能跟上 →（C 类 #14/#18 排入）。
- **#4**：✅ 做 Synapse 侧缓解（mcpBridge callTool 前剥离值为空字符串的可选参数）；已出具 sandbox_exec 问题描述给 server 维护方；两边正交不反向。
- **#3**：✅ 主人确认无 bug，只需保证重启持久化加载。
- **#6 键位**：运行时 Enter=queue / Shift+Enter=换行 / Ctrl+Enter=interrupt，设置可改。

## 四、原待拍板（已全部拍完，见上）
1. **#14 record 分级**：做 hit+距离动态分级（2-3天）还是现状静态分层够用？
2. **#18 记忆收敛方案**：A) 仅 systemPrompt 引导优先原生、MCP 记忆工具标注「仅跨源」 B) 默认隐藏/弱化 MCP 记忆工具，需要时显式开 C) 其他
3. **#3 对话级设置**：你测的是哪个设置没生效？要把哪些设置纳入对话级覆盖？
4. **优先级**：A 类 bug 先清，B 类新功能跟上，C 类待你定——是否这个顺序？
5. **#4 sandbox_exec**：要不要做 Synapse 侧缓解（调用前剥离空字符串可选参数）？

## 六、施工进展（实时）
- ✅ 批1 `c6cac69`：#2 设置中止（流式中缓存 client 不重建）/ #8 md 公式图（MarkdownViewer KaTeX+图片）/ #16 Exa 框架（npx exa-mcp-server, enabled:false 待主人填 EXA_API_KEY）/ #17 SKILL.md 正文注入
- ✅ 批2 `eff9325`：#7 H5 语义修正（按 task_boundary 状态注入「开/切 task」）/ #13 压缩阻塞 UI（isCompacting + banner + 发送守卫；崩溃恢复已有）
- ✅ 批3 `5b3951c`：#18 记忆引导 / #4 剥空字段 / #9 编辑框加号 / #16 Exa 走 HTTP Broker（手搓 transport）
- ✅ 批4 `302ea74`：#19 个性化头像昵称 / #12a /命令彩色 chip / #12b 压缩点可见+导航UI修
- ✅ 批5 `9ddb96f`：#6 双队列(interrupt+queue) / #11 三框 / 运行时键位（drainInterruptMessages 轮间插入）
- ✅ 批6：#14 record 动态分级（hit×距离→brief/summary/full）——方案①只在压缩点重算+固化 renderLevel，渲染只读固化值不读动态量→prompt cache 不破；mark_record_hit 工具记账 + 新鲜度衰减；子代理 1820 组穷举验证关闭/旧 record 退回逐字一致。**Plan_7 代码全部完成（批1-6）**
- ⏸ #15 压缩后卡片更新：主人不确定 + headline 概念上不随压缩变，暂记小本本待主人明确指哪个卡片
- 🔬 全部待主人重启统一真机验证；整体 adversarial review（Workflow 多 lens：#6 interrupt 语义 / #14 cache 不变式 / #11 三框 / #19 个性化）；Exa 需 Broker 在跑(127.0.0.1:14588)

## 五、待评估 / 小本本（承接 Plan_6）
- queue 附件 release / run_command 副作用入账本 / 队列上限连点 / subtitle 并发节流（Plan_6 遗留）
- #17 缺陷 B：WORKFLOW 注入 BUILT_IN 静态 vs commandRegistry 实际，可能漂移

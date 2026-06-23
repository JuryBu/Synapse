# Plan_6 补充 — M8 深度反馈施工（第七轮补充批）

> 第七轮主人补充了 8 类深度反馈 + 沙盒认知澄清。经 7 路只读核实（工作流 wf_51abf0ac）拿到代码依据，本文件固化结论与施工编排。
> 工作方式：独立文件派子代理并行；核心交织文件主线串行（bug 优先）；每批双编译 + CDP 真机验证 + commit/push。

## 一、本批讨论结论（含认知纠正）

1. **文件回滚真生效**：回溯/重试按快照真回滚文件（created 删、edited/deleted 写回，afterHash 校验防误删）。**逐文件 / 逐 hunk / 逐 block 三层 accept/reject 已有**（applyDiffReview/applyHunkReview/applyBlockReview）。→ 缺：中文化、视图对齐图四、行级按钮、review status 落库。
2. **权限审批 = 执行前 gate，≠ 沙盒**：拒绝→返回「用户取消了工具 X」、AI 继续。run_command 用 child_process.spawn 裸跑主机，仅 30s 超时 + 10k 截断，无进程/资源隔离。worktree 只是路径重定向（同进程改 cwd）。
3. **⭐ 沙盒分工（主人纠正，关键）**：MCP sandbox = 隔离即弃、**文件变化不进回溯账本** → 只配「一次性计算 / 试验 / 不留痕」小活；**危险 / 要回滚的操作走自己体系**（write_to_file 快照回溯+审批；run_command 审批门控）。
4. **task_boundary 卡住根因（bug，3 HIGH）**：① handleStop 漏 dispatch endTaskBoundary（用户停/abort 后边界永不收口）② taskBoundaryRender 的 endIdx 实时算 messages.length-1（endAnchor 空时每条新消息卡片自动延伸吞掉）③ AI 报错/超时没调 end_task_boundary 无兜底。
5. **插话现状 = 被无声丢弃**：isStreaming 时 handleSend 直接 return（非 interrupt，用户感觉按钮没反应）。→ 做 queue 顺带修这个坑。
6. **auto-retry 机制全但有诊断盲区**：9 级分类 + 5 次退避 + _userAborted 区分用户停/API 失败。但 API 失败（context canceled）可能被显示成「已停止生成」（伪装成用户停）；错误原因只显示「⚠️ AI 请求失败」无根因；网关特征词仅 8 个易漏判；0 token 失败诊断信息丢失。
7. **附加发现（小本本）**：run_command 命令的文件副作用不入快照账本（不可回溯）— 盲区，systemPrompt 引导规避 + 后续评估。

## 二、本批范围（主人定：全做，能并行并行）

### 沙盒方向：轻量增强（不做重型原生沙盒）
- 不做完整进程/资源隔离沙盒（6+ 周 + 打乱 worktree/contextId 架构，ROI 低）。
- run_command 后续加：细粒度超时（按工具）+ 工具调用审计日志（待评估，非本批必做）。
- systemPrompt 引导正确分工（见 B 任务）。

### 任务分组
- **硬伤组**：task_boundary 卡住修复 / Review Changes 中文化+视图 / auto-retry 错误诊断 / 用户消息半透明底色
- **发送边界组**：用户消息归 tb 可选（不归则先中止上个 boundary，设置可调）/ 插话 queue 模式
- **AI 引导组**：systemPrompt 补 tb/artifact 时机引导 + 修正版 sandbox 分工 / agentLoop 同轮长时间干活注入提醒
- **消息导航组**：Message.subtitle 字段 + DB 懒迁移 / 每条 user 消息系统模型异步生成小标题 / 导航列表 UI + scrollTop 跳转（tb 内消息不计）

## 三、施工编排（并行轨道 vs 串行轨道）

### 🔀 并行轨道（独立文件，子代理外包）
- **A：Review Changes 中文化 + 视图对齐图四** — 只动 `components/editor/ReviewChangesView.tsx` + 其专属 css
- **B：systemPrompt 引导补强** — 只动 `services/systemPrompt.ts`

### ➡️ 串行轨道（核心交织文件，主线顺序，bug 优先）
核心文件：AgentPanel.tsx / agentLoop.ts / conversation.ts / MessageBubble.tsx / aiClient.ts / settings.ts
1. task_boundary 卡住修复（bug，最先）
2. auto-retry 错误诊断（API 失败别伪装已停止 + 错误根因显性化）
3. 用户消息半透明底色（chat.css，小，顺手）
4. 用户消息归 tb 可选 + 插话 queue
5. 同轮长时间干活注入提醒（agentLoop while 循环，配合 B 的 systemPrompt）
6. 消息小标题 + 跳转导航（最大，最后）

## 四、Task 清单

### Stage H1：task_boundary 卡住修复（bug）
- 目标：用户停/AI abort/报错时 active 边界自动收口，卡片不再无限吞新消息
- 依据：本文件 §一.4
- 执行清单：
  - [ ] handleStop 加 dispatch(endTaskBoundary({aborted:true}))（AgentPanel ~1289-1307）
  - [ ] taskBoundaryRender endIdx 缓存/收敛（endAnchor 空时不无限延伸到末尾；AgentPanel ~356-415）
  - [ ] AI 报错/超时兜底收口（agentLoop 错误路径 dispatch endTaskBoundary）
  - [ ] clampTaskBoundariesAfterTruncation active 丢锚显式标 done（conversation slice ~298）
- 验收：CDP 真机——开 tb→点停止→卡片收口；报错后不再卡 tb 状态
- 证据：改动文件清单 + 双编译 EXIT + CDP evaluate 验证

### Stage H2：auto-retry 错误诊断
- 目标：API 失败不再伪装「已停止」，错误根因呈现给用户
- 依据：§一.6
- 执行清单：
  - [ ] API 失败 streamState 走 'error' 而非 'aborted'（区分 context canceled vs 用户停）
  - [ ] MessageBubble error 字段显性化（错误根因 badge/展开，非仅「请求失败」）
  - [ ] 网关特征词表扩充 + console.warn 改可见提示
  - [ ] （评估）token usage 异常路径回写
- 验收：模拟 API 失败显示「出错+原因」非「已停止」
- 证据：双编译 + 真机/构造错误验证

### Stage H3：用户消息半透明主体色底
- 目标：滚动时快速分辨用户/模型消息
- 依据：§一 T7-B
- 执行清单：
  - [ ] chat.css 给 .message.user / .message-body 加 rgba(主体色,0.08~0.12) 半透明底（用 CSS 变量，深浅模式兼容，不冲突现有玻璃化）
- 验收：CDP 截图/computed style 验证底色 + 美观
- 证据：双编译 + CDP

### Stage H4：用户消息归 tb 可选 + 插话 queue
- 目标：① 发消息可选不归入当前 tb（不归则先中止上个 boundary）② 生成时发消息排队，本轮结束自动发
- 依据：§一.4/.5
- 执行清单：
  - [ ] settings 加「用户消息归入 task_boundary」开关（默认归入）
  - [ ] handleSend：不归入时先 dispatch endTaskBoundary 再发
  - [ ] conversation slice 加 queuedMessages + isQueueing
  - [ ] handleSend isStreaming 时改为 enqueue（不再无声丢弃）
  - [ ] agentLoop run() finally 加 dequeueAndRun（护栏：stop/切对话清队列，最多 5 条，过期 GC）
  - [ ] UI：发送按钮切「N 条排队中」+ badge
- 验收：生成中发消息→排队→本轮完自动发；归属开关生效
- 证据：双编译 + CDP

### Stage H5：同轮长时间干活注入提醒
- 目标：AI 同轮/同 tb 干太久不收口时，请求体注入提醒
- 依据：§一 T7-A3
- 执行清单：
  - [ ] agentLoop while 循环记 round + loopStartedAt
  - [ ] round>10 或 elapsed>120s 时注入系统提醒段（考虑汇报进展 / end_task_boundary / 分解任务）
- 验收：构造长轮次验证注入
- 证据：双编译

### Stage H6：消息小标题 + 跳转导航
- 目标：每条 user 消息系统模型生成小标题（可手改），导航列表点击快速跳转（tb 内消息不计）
- 依据：§一 T6
- 执行清单：
  - [ ] Message 加 subtitle/subtitleGeneratedAt 字段 + DB 懒迁移 + persistence
  - [ ] agentLoop 每条 user 消息 fire-and-forget generateSubtitleFromText（复用 systemModelClient）
  - [ ] MessageBubble 加 data-message-id + 小标题手改入口
  - [ ] 导航列表 UI（浮层/面板）+ scrollTop 跳转 + highlight，过滤 tb 内消息
- 验收：长对话生成小标题 + 点击跳转定位 + 闪烁高亮
- 证据：双编译 + CDP

### 并行 A：Review Changes 中文化 + 视图对齐图四（子代理）
- [ ] ReviewChangesView 全部英文文案中文化（20+ 处）
- [ ] +N/-N 标记突出（加大/高对比/显眼位）+ 视图向图四对齐

### 并行 B：systemPrompt 引导补强（子代理）
- [ ] task_boundary：有多步工作开始 begin、阶段完成/汇报立刻 end 收口
- [ ] artifact：值得用户看/存的产物用 show_artifact 推送，优先于塞正文
- [ ] sandbox 分工：危险/要回滚→自己文件工具；一次性试验/计算→MCP sandbox（不留痕）；改文件优先 write_to_file 别用 run_command 间接改

## 六、施工进展（实时）
- ✅ 批3a `cdacb53`：H1 task_boundary 卡住（agentLoop wasAborted/lastError 兜底收口 + handleStop 收口 + TaskBoundaryCard 手动「结束」按钮）/ A Review Changes 中文化+IDE视图 / B systemPrompt 引导（含修正版 sandbox 分工）
- ✅ 批3b `7941a30`：H2 auto-retry 诊断（classifyError 只信用户主动 abort 标志，服务端 context canceled 改判 network 重试+显真因；completeChat 统一 this.aborted；网关词表扩充）/ H3 用户消息半透明主体色底（CDP 实测 22 条生效）
- ✅ 批4：H4 归 tb 可选（settings 开关 + dispatchUserSend 发送前收口）+ 插话 queue（queuedMessages + 下降沿自动发 + 护栏①②③④ + 输入框上方排队区 UI）。子代理 ad11cda 做数据+逻辑层(质量高,工具预算到顶停)，主线补 UI 排队区+SettingsPanel 开关+css+护栏②确认（reducer 兜底）。双编译 EXIT 0
- ✅ 批5a `f103d2e`：H5 同轮长时间干活注入提醒（round≥10 或 >2min 注入一次 system 提醒，flag 防重复+不破坏 prompt cache 前缀）
- ✅ 批5b：H6 消息小标题+跳转导航（Message.subtitle + DB messages 表 ensureColumn 加列懒迁移 + IPC 20 列严格对齐 + agentLoop fire-and-forget 生成 + 导航 portal 浮层 + scrollToMessage 高亮 + 手改标题；排除 tb 内消息）。子代理 acd4e355 三步做完整，主线 review IPC 列对齐完美
- 🎉 **第七轮补充反馈（深度反馈批）H1-H6 + A/B 全部完成**
- 🔬 待主人重启统一真机验证：H1 收口/手动按钮、H2 retry 诊断、H4 queue、H5 提醒、H6 小标题导航
- 🔬 待重启真机验证（与主人验收一起）：H1 自动收口/手动按钮、H2 API 失败重试不再显「已停止」、H4 queue
- ⚠️ sandbox 分工已按主人纠正落地（B 的 systemPrompt）：危险/要回溯走自己文件体系，一次性试验走 MCP sandbox

## 五、待评估 / 小本本
- [ ] H4 queue：切换/新建/分支对话时清队列已由 reducer（clearConversation/setConversation）兜底防串台 OK，但队列消息的附件 sha256 未主动 release（边缘泄漏，低危——漏 release 只多占盘，且极低频；TDZ 限制：handleNewConversation/Switch 定义在 clearQueueWithRelease 之前，要补需内联模块级 release）
- [ ] run_command 文件副作用入快照账本（回溯盲区）
- [ ] review status 落库（重启不丢 accept/reject）
- [ ] 逐文件行级 accept/reject（现 block 最细，ROI 待定）
- [ ] run_command 细粒度超时 + 工具调用审计日志（沙盒轻量增强延伸）
- [ ] #158 按消息缓存 token / xlsx CVE / MCP 路径硬编码 / browser-use（Stage G）

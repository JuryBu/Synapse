# Plan_5 M5 进展与待办（实时滚动）

> 真机验收 + 子代理协作推进的活动记录。权威设计在 `Plan_5_压缩回溯统一模型规范.md` / `Plan_5_梯队三实现蓝图.md`。

## ✅ M5-RL（record 多级分层）— 完成

R-L1~R-L5 全部实现 + 4-lens 对抗审查（「水位/幂等门」「R-L5/落库」两 lens 零 findings，核心坑确认无问题）+ commit + push。
- R-L1 extractSkeletonTitle（仅标题骨架，1/3 量纲）
- R-L2 三级分层（头全文+尾全文+中间骨架+最老 titleOnly），fixture 实测 60 批前缀 **降 48%**、cache 逐字稳定
- R-L3 fixture 验证全 PASS
- R-L4 折叠元批（archived/meta/foldedFrom；lastRealBatch 排除 meta 防丢批；解折叠再裁不撕裂）
- R-L5 token 硬闸（正常 no-op 保 cache，危险态降级 + hardTruncate）
- 对抗审查修了 3 low/nit：分隔线过滤 meta、unfoldBatches 重排 index、metaBatch 空兜底
- **R-L6（BPC 衔接，可选）** 留待 M5-BPC 完成后评估

## ✅ M5-FIX 真机回归修复（本批，全部 commit+push）

回溯 undo 语义（点 user 那条回输入框、它及之后清）/ 重试·分支确认 / 工具卡片转圈 FIX-13 / PDF FIX-12+12b（缩放·滚动条·拖拽·Ctrl滚轮 + 对抗审查 6 修）/ reload 快捷键 + 未保存守卫 / UI-10 独立 tab / UI-6 文件夹默认收起+per-workspace 记忆 / UI-9 HTML 滚动条注入末尾+!important / UI-7 浮层中文+背景 / **PDF worker 回归**（vite optimizeDeps.exclude pdfjs-dist + worker.format es）/ **主题浮层浅色**（浅色补 --glass-bg + 新增 --glass-bg-solid + modal 改 --syn-bg-surface）

## ✅ P1 主题浅色全局适配 — 完成（commit b221b81，playwright 验证）

浅色模式全局梳理完成（按「成对语义变量 + 组件统一引用」根因修法，非逐处改写死值）：
- index.css 新增成对深浅语义变量（--glass-bg-solid / --syn-bg-code / --syn-text-code / overlay 5 档 soft~scrim），浅色块补齐 --glass-bg
- 8 处样式文件（chat/components/layout/editor/conversationList/fileTree/settings/wizard）写死深色改语义变量
- ErrorBoundary 整页崩溃兜底改主题变量；CodeEditor prism 主题随 useResolvedTheme（深 vscDarkPlus/浅 vs）；MessageBubble mermaid 图表主题跟随（浅色 default + 浅色 themeVariables）
- 新增 hooks/useResolvedTheme（读 redux theme.mode，system 跟 matchMedia）
- playwright 真机扫描+诊断确认无残留真深色，截图确认整体协调美观

待真机复核（小本本）：个别 badge/mode-switch 对比度边角若主人真机发现再点修；mermaid 图表渲染待有真实 mermaid 消息时一眼确认（配色取自已验证的浅色 token，编译通过）。
P2 保留不改：代码块/编辑器固定 GitHub dark 配色（深底浅字对比 OK，设计取舍）。

## ✅ M5-BPC（后台预压缩）— 全部完成（PhaseA 底座 + PhaseB 接线 + PhaseC UI）

详细蓝图见 `Plan_5_梯队三实现蓝图.md`（BPC-0~BPC-8）。

### ✅ PhaseA 底座（commit b2eeec5）— run() 未接线、对现有压缩零影响
- recordStore RecordBatch/AppendBatchInput 加 source('auto'|'manual'|'bpc')
- agentLoop compactNow 拆薄壳 + generateAndAppend（纯生成+落库，signal 入参，**零 store.dispatch** 不污染主 UI）+ bpcGenerate/computeBpcSnapshotInput；compactNow/手动两路逐字等价，AbortController 责任留壳层
- agentSettings BpcConfig + DEFAULT_BPC_CONFIG（bpcThreshold0.68/compactThreshold0.9/deltaSteps2/abortCooldownMin3/circuitBreakGapSteps1）；store sanitizeBpcConfig（Number.isFinite 防 0 falsy）
- conversation slice bpcThresholdOverride/compactThresholdOverride + override 全链路（DB 两 REAL 列懒迁移 + IPC + Web + persistence）
- bpcScheduler 单例状态机（idle/snapshotting/generating/ready/replacing/cooldown/circuit-broken）+ evaluateWater/triggerSnapshot/runGeneration/takeReadyPrefix/discardCurrent/abort/restart/熔断/δ retry，全套就位
- bpc slice 极薄 UI 投影（不持久化）

### ✅ PhaseB 接线激活（commit ef7b4a3）— BPC 正式跑起来
- compressContext 加 thresholdRatio 参（默认 0.9 向后兼容），硬阈值可配
- agentLoop resolveCompactThreshold（本对话覆盖 ?? 全局 bpc.compactThreshold ?? 0.9，number 防 falsy）下推 compressContext + overLimit
- AgentPanel attachLoop/detachLoop 注入 scheduler（切模型/MCP 重建自动 discard 在途）
- run while 每轮末 evaluateBpcWater 钩子（fire-and-forget 按 run 同口径算水位）
- run 进入 apiHistory 前裁决：撞硬阈值丢在途 BPC 防双写（边界①②），否则有 ready 则 takeReadyPrefix 收尾+记熔断游标（边界⑤）
- **设计核心**：record 注入复用 M5-1 else 统一口径（BPC 落库下一轮 run 天然读取注入），takeReadyPrefix.recordMd 不被依赖 → 注入正确性独立于 BPC 逻辑瑕疵；store 永远全量，水位用全量算靠 batchSlice 增量门 + 熔断防原地打转
- 双编译通过；**两轮对抗审查全过**：
  - 一轮（单 opus agent）：修 H1 retry 死锁（task 内调 retry 被 genPromise 防重入闸挡死→永卡 snapshotting）+ M1 ready 误判 + M2/M3 对话身份串台 + L1 阈值 clamp（commit 03f83d4）
  - 二轮（5 视角 verify workflow）：揪出 HIGH「appended 误判」——appendBatch 拒写(脏写 recordStore:482 / 并发水位门:519)返回的是【旧 record】(非 null)，if(updated) 把它误判落批 → 假 ready → 注入陈旧前缀+水位没降 → 下轮 gap<=1 误熔断（M1 失败模式下移到 updated 层）；改判据 `updated.totalSteps>stepStart` + L1 防负 clamp（commit 4ec25f0）。H1/M1/M2/M3/降级安全全 pass

### ✅ PhaseC UI 收尾（commit 1e068d9）— BPC 完整可用
- CompressionRing（footer/context tab/StatusBar 三处统一收敛，订阅 bpc slice）：idle token%（红黄灰）/ snapshotting·generating spin 环+「后台压缩中」+中止× / replacing / cooldown「冷却中 Nm」/ circuit-broken 红「BPC 已停」+重启↻（→ scheduler.restart，熔断重启入口已补）
- CompactDivider（替内联虚线）：按 record 批 source 三态（manual 灰 / auto 蓝 / bpc 紫渐变）；recordBatchStepEnds 升级为带 source/index 的 BatchMark + extractBatchMarks helper 两处填充共用
- SettingsPanel 压缩设置区（替写死占位）：BPC 5 参（预压/硬压水位滑杆 + δ/冷却/熔断间距）+ 风险校验黄字（阈值距离过近/过低，纯前端不阻止保存）+ Record 分层 6 参（补 R-L2 欠的 UI）
- 真机验证（playwright + vite dev 深浅色）：CompressionRing idle/generating/circuit-broken 三态渲染正确；设置面板 BPC+分层区深浅色对比清晰美观；风险校验黄字触发正确（rgb(245,158,11)）。CompactDivider 三态靠 CSS+逻辑审查（web 空对话无 record，留主人真机确认）
- 小缺口（可选）：本对话覆盖 UI（conversation override）未在设置面板暴露（设置面板全局语义）；override reducer+持久化已就位（PhaseA），后续可加 /命令入口

## 🎉 M5-BPC 全部完成 + M5 梯队三收官
后台预压缩从设计到 UI 全链路落地，两轮对抗审查通过（H1 retry 死锁 + 二轮 HIGH appended 误判均修）。M5 梯队三（M5-RL 分层 + M5-BPC 预压缩）完成。

### R-L6（BPC 衔接，可选）
PhaseC 后评估：scheduler 生成前 predictRecordPrefixTokens 超 maxRatio 提前 foldOldBatches。

## 🔍 待主人真机核验（BPC 需运行时触发，单测/playwright 注入难覆盖，攒一起验）

> 这些都要真实长对话 / 真实 record 数据才能验，playwright web 模式造不出来。BPC 逻辑层已两轮对抗审查通过、
> UI 层 playwright 注入验过三态，但「端到端真实链路」需主人 electron 真机跑。攒在这里，下次一起核验。

- [ ] **BPC 端到端**：渐进对话触达 bpcThreshold(默认 68%) → footer CompressionRing 转「后台压缩中」spin 环 → 后台生成完转 ready → 下一轮发请求无缝替换（footer 回 idle + token 回落 + 消息流插入 BPC 紫色分隔线）
- [ ] **CompactDivider 三态视觉**：manual（手动 /compact 灰）/ auto（撞 90% 自动蓝）/ bpc（后台预压紫渐变）三种分隔线配色 + 图标，需真实 record 压缩点才显示；确认浅色下也好看
- [ ] **δ 窗口**：ready 早于 targetReplaceStep 即用；生成失败在 δ 窗口内自动 retry；越 δ 上限仍无 ready → 退硬阻塞兜底
- [ ] **边界①②（超大输入）**：单条超大输入一瞬撞 0.9 → 直接硬阻塞同步压缩（不等 BPC，discardCurrent 丢在途）
- [ ] **中止冷却**：footer 环上点中止 × → 进 cooldown「冷却中 Nm」，冷却期内不再触发 BPC
- [ ] **熔断**：构造「压完几乎没推进又触发」连续 2 次 → 熔断弹窗 + footer 转红「BPC 已停」+ 重启 ↻ 按钮可恢复
- [ ] **设置面板调参生效**：改 bpcThreshold/compactThreshold/δ/冷却/熔断间距 后行为跟随；改 recordLayering 6 参后注入前缀分层跟随
- [ ] **中止 × / 重启 ↻ 按钮**真机点击 → scheduler.abort() / restart() 行为正确

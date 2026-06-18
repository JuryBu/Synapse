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

## 🔧 P1 主题浅色对比度待修（子代理 B 全局排查，未改，下批 UI 打磨）

浅色模式下对比度不足/不协调（深色模式正常），子代理 B 精确清单：
- `ErrorBoundary.tsx:22/26/33` 整页崩溃兜底写死深色 → 用 --syn-bg-base/--syn-text-*（浅色用户崩溃会黑屏割裂）
- `conversationList.css:202 #fecaca` / `:365 #fbbf24` / `:408 #ef4444` 浅色文字贴浅底对比低 → 饱和深色或 var(--syn-error)
- `settings.css:258/263/268` plugin-status badge 浅色字（#86efac/#fde68a/#fca5a5）→ 饱和深色版（#16a34a/#b45309/#b91c1c）；`:491 #f59e0b`
- `layout.css:926-927` mode-switch.fast `#22d3ee` 青色浅底发飘 → var(--syn-accent)
- `workflow .wf:423 #22c55e`
- **P2（设计取舍，建议不改）**：代码块/编辑器固定深色主题（chat.css:342 / editor.css:134 `#0d1117`，GitHub dark 配色，浅色下深底浅字但对比 OK、可读）；语法高亮 token 色同理

最划算根因修法：新增成对语义变量（如 --syn-success-text 深浅各一）组件统一引用，而非逐处改写死值。

## ⏭ M5-BPC（后台预压缩）— 待做

- 子代理上轮只给了 phase 级概要（schema 未填详细），**需先补一轮 BPC 详细设计 workflow** 再实现
- 规范 §8：~70% 阈值快照 → 后台 compact → 压好下一轮即用；δ 窗口（δ=2 最晚上限）；5 条边界（超大输入硬阻塞兜底 / 未替换前撞阈值转硬阻塞 / 可见可中止压缩环 / 阈值风险提醒 / 连续循环熔断）；所有可调参数进设置
- 依赖 M5-RL（R-L4 折叠 + R-L5 硬闸已就位，是 BPC 边界5 熔断的前置保证）

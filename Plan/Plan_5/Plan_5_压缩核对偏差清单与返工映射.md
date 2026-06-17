# Plan_5 · 压缩/回溯/分支/重试 核对偏差清单 + 返工映射

> 2026-06-17，8 路只读核对「当前实现 vs [统一模型规范](Plan_5_压缩回溯统一模型规范.md)」结果整理。
> 状态：**整理留档中**，等用户补充 `background-pre-compact` 机制 + UI 细节后，定稿为返工 Plan（暂名 M5-x）。

## 一、核对总览（8 领域，34 偏差，4 不符 + 4 部分符）

| 领域 | 符合度 | 一句话 | 返工块 |
|---|---|---|---|
| 压缩单一性 | 🔴 no | `/compact` 走 `applyManualCompact` 截断 store + `isManualEntry` 两套压缩 | M5-1 |
| 轮次概念 | 🔴 no | 无"轮"概念，把"轮"当成 user 消息条数；保留/裁剪纯 step 不按轮 | M5-2 ★地基 |
| record 增量生成 δ | 🔴 no | 生成摘要只喂目标段，无前后 δ 轮原文连贯性参考 | M5-6 |
| 懒加载 | 🔴 no | 全量渲染无虚拟滚动（纯前端问题，不碰底座） | M5-7 |
| UI 显示 | 🟡 partial | 正确的分隔线（batchDivider）已有、被错误的 /compact 架空打架 | M5-1 |
| 回溯 | 🟡 partial | 能砍 record 批，但①不回填输入框②轮中间切③入口按单条非按轮 | M5-3 |
| 分支 | 🟡 partial | **最接近**：砍批口径对、源对话不动对；缺①回填②按轮取整 | M5-5 |
| 重试 | 🟡 partial | 自动重发对；但没按轮回退（多步轮只删被点条）+ 入口错挂 AI 消息 | M5-4 |

## 二、两个"根子"（修好它们一大半连带消失）

1. **压缩没归一**（M5-1）：`conversation.ts` `applyManualCompact`（:379-393）`state.messages=[摘要,...tail]` 删 store；`AgentPanel.tsx:1031` dispatch 它；`agentLoop.ts:1187` `isManualEntry` 分支让自动/手动走两套 batchSlice；`MessageBubble.tsx:300-321` 为承接 system 摘要消息而生。→ 全删，`/compact` 只调自动 `compactNow`（不截断 store），UI 交还已存在的 `batchDividerByIdx` 分隔线（AgentPanel.tsx:257-279/1996-2005）。连带：之前的"水位错位 bug"、弱熵 id、本地文件被删减、token/导出基于残缺历史 —— 全部随之消失。
2. **没有轮次概念**（M5-2，地基）：全项目把"轮"=`role==='user'` 条数（`agentLoop.ts:1236-1238`、`AgentPanel.tsx:1202`、`conversationPersistence.ts:398`）；保留原文 `compressContext` `keepCount=4` 纯按条切（`systemPrompt.ts:263-265`）；`clampToBatch` 的 `keptRounds` 形同虚设只告警（`recordStore.ts:532-539`）。→ 新增**轮边界识别层**（从 role 序列识别"user 段+紧随 model 段含所有工具/子代理 step=一轮"，产出 消息→轮号 + 轮号→[stepStart,stepEnd] 两张表），压缩/回溯/分支/重试**四处共用**。

## 三、返工结构（依赖顺序；待补充后定稿）

```
M5-1 压缩归一          删两套→单一 compactNow，UI 回归 batchDivider 分隔线
  → M5-2 轮次地基 ★    轮边界识别层，下面全吃它
    → M5-3 回溯        按轮回退 + N+1 轮 user 回填输入框待发（入口挂 user 消息）
    → M5-4 重试        入口挂 user 消息；回退整轮 + 该 user 自动重发
    → M5-5 分支        按轮取整 + 与回溯对齐（落新对话）
  → M5-6 增量生成 δ    GenerateBatchInput 加前/后 δ 轮原文参考（不计入水位）
  → M5-7 懒加载        纯前端虚拟滚动 + 上滚不打断（不碰存储/record）
  → M5-8 background-pre-compact + UI 细节   【待用户补充后排期】
```

## 四、各块关键偏差与修向（精炼）

- **M5-1 压缩归一**：删 `applyManualCompact`/`isManualEntry`/system 摘要卡片 + dispatch；`/compact`→`compactNow`；清理误导注释。`effort` 中。
- **M5-2 轮次地基**：新增轮边界层；`compressContext` 保留按 token→向轮边界取整；批次 stepStart/stepEnd 由轮推导；`clampToBatch`/`copyRecordFrom` 裁剪基准对齐轮边界（`keptRounds` 转真实依据）。`effort` 中-大。
- **M5-3 回溯**：`handleUndoToMessage` 重做——定位目标轮 N、`setPendingMessage` 回填 N+1 轮 user（恢复 pending 附件、不自动发、GC 排除它）、按轮 truncate。入口语义统一到"轮"。`effort` 中。
- **M5-4 重试**：入口**改挂 user 消息**；`handleRetry` 截断基准从"被点 AI 之前"改为"该 user 轮之后全部（含本轮所有 assistant/tool 中间步）"，再 `skipUserMessage` 自动重发。`effort` 中。
- **M5-5 分支**：`branchConversation` cutIdx 向轮边界取整；与回溯对齐（user 分支点→新对话 setInput 回填待发）。砍批口径已对，复用 M5-2 轮 helper。`effort` 中。
- **M5-6 δ 参考**：`GenerateBatchInput` 加 contextBefore/contextAfter（δ≤1 轮/按 token）；`buildBatchPrompt` 增"前文/后文参考（只读勿写入）"分区；参考不计入 step/round 水位。`effort` 中。
- **M5-7 懒加载**：引虚拟滚动（react-virtuoso / @tanstack/react-virtual / 手写窗口化）替换 `AgentPanel.tsx:1996` 全量 `messages.map`；改无条件 `scrollIntoView`（:413-415）为"仅底部附近才置底"；store 全量持有不变、**不碰 record/存储/回溯**。`effort` 中。

## 五、决策记录（用户已拍板）

- **懒加载 = 纯前端虚拟滚动**，store 全量持有不变，不碰本地存储/record/回溯（用户 2026-06-17 纠正，推翻"底座级"误判）。
- **重试入口 = user 消息**（点 user 重试 = 回溯+自动重发），非 AI 消息（用户 2026-06-17 纠正）。
- 回溯/重试/分支统一以"user 消息=轮起点"为锚（见规范 §3/4/5）。

## 六、待用户补充（补完即定稿）

- **`background-pre-compact`**（后台预压缩）机制 → 规范 §8 占位。
- **UI 细节点**（压缩分隔线样式、回溯/重试/分支入口呈现等）→ 规范 §9 占位。

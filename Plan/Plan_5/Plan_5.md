# Plan_5.md — Synapse 成熟 Agent Harness 化 · 总纲领

> 立项日期：2026-06-16
> 触发：Plan_4 收官后的一次**真机整体回归**（用户亲自逐功能点测），暴露出一批 Plan_4「编译过 + 对抗审查过」未覆盖的基础体验真问题。本 Plan 把 Synapse 从「demo 成熟度」推到「真·可用的 CC/Codex 式 agent harness」。
> UI 壳子（VS Code 式布局）保持不变，只动机制层与体验层。

## 一、项目概述

Plan_4 完成了上下文 harness（M1）、对话体系（M2）、Multi-AI（M3）三大块，但真机回归发现：核心功能多数其实**真生效**（SSE 真流式、安全审批、AI 参数、通用设置、Multi-AI 编排都已落地），可大量**基础体验**存在 bug 或缺失——新对话带图即误判截断、对话切换选中错位、附件打不开、输入框不封顶、thinking 渲染倒置、文件图标朴素、系统模型/工作区感知缺失、缺 @// 命令、缺 retry/重连/计时。

Plan_5 用 8 个里程碑系统性补齐，目标是让 Synapse 在日常教学使用中**稳、顺、像成熟工具**。

## 二、诊断与设计方法（留痕）

- **两轮并行只读诊断**：主诊断 8 路（覆盖 10 类用户问题，30 条根因）+ 补充审计 3 路（设置实装度 / @// 现状 / record-memory 现状，24 条）。
- **8 路里程碑设计** + **8 路分卷落盘**，全程子代理 opus。
- **实测纠偏贯穿全程**：多次「子代理给的表层根因被实测 / 亲读代码推翻」。最典型——问题4 诊断归因为「上下文上限被算小」，但实测本地网关 `/v1/models` 对 gpt-5.5 **不返回任何 context 字段**、`findContextWindow` 名字推断 `gpt-5→128000` 已正确，真根因实为 `estimateNonTextPartsTokens` 把 base64 图片字节长度当 token（3.9MB 图→130 万「token」）。**本 Plan 的根因均以亲读代码为准，禁止表层归因。**

## 三、里程碑划分（8 个，各有分卷）

| 里程碑 | 主题 | 分卷 | stage 数 |
|---|---|---|---|
| **M4-1** | 上下文/token 机制根治 | [Plan_5_M4-1](Plan/Plan_5/Plan_5_M4-1_上下文token根治.md) | 5 |
| **M4-2** | 对话体验修复 + 对话工作区归属 | [Plan_5_M4-2](Plan/Plan_5/Plan_5_M4-2_对话与工作区归属.md) | 7 |
| **M4-3** | UI 修复与美化 | [Plan_5_M4-3](Plan/Plan_5/Plan_5_M4-3_UI修复与美化.md) | 8 |
| **M4-4** | 文件查看器（图片/高亮/Office） | [Plan_5_M4-4](Plan/Plan_5/Plan_5_M4-4_文件查看器.md) | 4 |
| **M4-5** | 系统模型 + 自动标题 + 工作区感知 + cache | [Plan_5_M4-5](Plan/Plan_5/Plan_5_M4-5_系统模型与感知.md) | 4 |
| **M4-6** | 输入区 @ 艾特 + / 斜杠命令 | [Plan_5_M4-6](Plan/Plan_5/Plan_5_M4-6_输入区命令.md) | 5 |
| **M4-7** | MCP 真接（读为主）+ /compact 手动入口 | [Plan_5_M4-7](Plan/Plan_5/Plan_5_M4-7_MCP真接.md) | 7 |
| **M4-8** | 请求稳定性：retry/重连 + 本轮计时 | [Plan_5_M4-8](Plan/Plan_5/Plan_5_M4-8_稳定性重连计时.md) | 5 |

合计 **45 stage**。

## 四、推进顺序与依赖

建议顺序（价值优先 + 依赖约束）：

```
M4-1（头号 bug，独立，最先）
 → M4-3（一批 UI bug，快速见效，独立）
 → M4-8（稳定性，独立，高价值）
 → M4-4（查看器，独立）
 → M4-2（对话 + 工作区归属，含 DB 懒迁移）
 → M4-5（系统模型，为 M4-7 的 record/标题铺路）
 → M4-7（MCP 桥接 + compactNow，提供 /compact 实装）
 → M4-6（@// 命令，/compact 复用 M4-7 的 compactNow）
```

**关键依赖**：
- M4-6 的 `/compact` 命令 → 调用 M4-7 抽出的 `compactNow()`（M4-6 先建命令壳 + helpers.compactNow 钩子，M4-7 实装）。
- M4-7 `recordGenerator`、M4-5 自动标题 → 用 M4-5 的「系统模型」配置（故 M4-5 在 M4-7 前）。
- M4-8 fallback 第三层（降级系统模型/备用端点）刻意**不做**，留到 M4-5/M4-7 落地后再议（解耦）。

## 五、关键技术决策（用户已拍板 / 已固化）

**架构与范围**
- **自动压缩保持不变**：现有 ~90% 水位自动生成 record 的机制**不删、不降级、不改成只提示**。`/compact` 是**新增的手动压缩入口**，与自动压缩**并存**、复用同一套 `compactNow` 逻辑。「生成转手动」只针对外置 **MCP memory-store 自带的生成功能**。
- **MCP 真接、读为主**：Synapse 已有完整 MCP stdio client（非从零），缺的是桥接进工具循环 + 默认配置。接三个本地 server（memory-store/sandbox/web-fetcher，路径 `C:\Users\Stardust\.gemini\antigravity\mcp-*`）；默认只开 memory-store，另两个默认关；sandbox 执行类 / web 写类工具**强制审批**，不因「读为主」全放行。
- **工作区归属**：维持单当前工作区架构（不引入并发多开）；对话默认归当前工作区、可改归 Global/历史工作区；用工作区 **path 作键**（改名会失联 = 已知限制）；列表按 当前/Global/全部 三态过滤。
- **系统模型**：新增独立「系统模型」配置（留「跟随主模型」空选项），后台任务（record 压缩摘要 / 自动标题）用它。

**体验细节**
- 图片 token = 固定 1100/张（视觉口径），文件按解码内容估；`contextWindow` 抽统一选择器；**不给 contextWindow 加下限保护**（上限本身正确）。
- 自动标题 = 截断占位 + 异步系统模型生成 ≤15 字 + 失败 retry 1 次 + 降级保留截断。
- 工作区感知 = 轻量（工作区信息 + 当前打开文件路径/名/类型，**不含正文**）；工作区文件树概要列**二期**。
- 本轮计时 = **端到端**（用户发出 → 整个 agent loop 完成，含多轮工具）。
- 输入区：`@`（工作流/设置/对话）+ `/`（loop/compact/goal）；`/loop` 先最小版（N 轮串行 + 硬上限）；`@` 句中触发、`/` 仅整条开头触发；`@对话` 引用默认 record 摘要优先；`@设置` 走跳转。
- 历史恢复 = 右侧栏顶部下拉浮层对话管理区（与左侧栏共用数据源）。
- 图片打开 = 注册 `synapse-file://` 协议（同 wallpaper 旧 API 风格），video/PDF 顺手一起修。
- 代码高亮 = react-syntax-highlighter 只读路（编辑 textarea 不动），大文件 >2000 行降级裸 pre。
- Office 预览 = pptx/docx 改走已就绪的 LibreOffice → PDF 链路（仅改 `editorFileTypes` 两行特判）。
- 已发附件打开 = 新 tab type `'attachment'`，图片走预览模态。
- 文件图标 = 内置 material-icon-theme 风格 SVG 子集（首批 ~40 扩展），只动 FileTree。
- 文件树排序 = 文件夹优先 + 组内字符序。
- 编辑器 tab = VS Code 式 `...` 菜单 + 预览 tab（单击斜体临时 / 双击固定）+ Ctrl+K 和弦。
- 删 SettingsPanel 整张开发自检表，措辞中性化。
- 本项目派的子代理一律用 **opus**；Synapse 内部子代理走本地 API。

## 六、真根因速查（防表层诊断复发）

| 问题 | 真根因（亲读代码确认） | 修法 |
|---|---|---|
| 4 新对话带图即截断 | `estimateNonTextPartsTokens` base64 长度 ×0.25 当 token | 图片固定 1100、文件按解码内容 |
| 9 切换选中跳第二 | 切走时 `saveCurrentToHistory` 刷新被切走对话 `updated_at` → 排序跳第一 | IPC `systemTouch` 不刷排序时间 |
| 2b 自动保存失败 | 运行态 message.id 弱熵碰撞 + `replaceConversation` 纯 INSERT 撞 UNIQUE 整条回滚 | crypto.randomUUID + INSERT OR REPLACE |
| 2a 底部写死 128k | StatusBar 自带硬编码模型名→窗口映射 | 统一 `getModelContextWindow` 选择器 |
| 3① 图片黑屏 | 编辑器 `<img>` 裸磁盘路径被 Electron 安全策略拦 | 注册 `synapse-file://` 协议 |
| 3③ Office 走文本 | `editorFileTypes` 把 pptx/docx 特判**绕开**已就绪的 LibreOffice 链路 | 改路由归 `'office'` |
| MCP 未配置 | 已有 client，缺 `mcp_config.json` + 未桥接进工具循环 | 默认配置 + mcpBridge |
| 满屏「部分实装」 | 硬编码开发自检表被当产品 UI 渲染 | 整张删 |

## 七、待复核 / 小本本（实现期确认）

- [ ] `conversation.tokenCount` 真实语义（prompt vs total）—— 影响 StatusBar 实测显示口径（M4-1）
- [ ] 项目既有 selector 放置惯例（`getModelContextWindow` 放哪）（M4-1）
- [ ] `buildStableRecordPrefix` 方案 B「头 N 批全文」N 的具体取值（M4-5）
- [ ] `runSystemModelOnce` 放 recordGenerator 还是新建 systemModelClient.ts（M4-5）
- [ ] 本地端点 `http://127.0.0.1:54861/v1` 是否支持 prompt caching —— 真机验证收益（M4-5）
- [ ] LibreOffice 冷启动延迟（首次数秒）体验是否需进度优化（M4-4）
- [ ] S3 附件 objectUrl 需 `Map<tabId,url>` + tab 关闭 revoke 防泄漏（M4-3）
- [ ] 删自检表后全量 grep 确认 `settingAuditRows/SettingsAuditMatrix/auditStatusClass` 无残留引用防 TS 失败（M4-3）
- [ ] MCP transport 走 stdio（**不走** HTTP Broker 127.0.0.1:14588，最大坑）（M4-7）
- [ ] 工作区改名 → 对话失联（已知限制，是否后续做 path 重绑）（M4-2）

## 八、二期 / 暂不做（明确边界）

- 工作区**文件树概要**注入（需新建目录扫描 + 落库 + 忽略规则）—— 二期
- `/loop` 的 CC 式「AI 自判完成、未完成续跑」收敛循环 —— 后续
- M4-8 fallback 第三层（同端点重试耗尽后降级系统模型/备用端点）—— M4-5/M4-7 后再议
- 真·并发多开多工作区 —— 暂不做（维持单当前工作区）

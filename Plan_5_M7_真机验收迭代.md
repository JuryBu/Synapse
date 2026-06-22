# Plan_5_M7 — 真机验收迭代（标题 / 读原文 / 图表 + 性能 + P0 三项）

> M7 不是预先规划的里程碑，而是 M6 富文本输入框收官后、由主人多轮真机反馈驱动的快速修复迭代。
> 本文档留痕本轮（第三轮真机反馈）P0 三项的根因、改法、验收口径与遗留小本本。

## 一、本轮已完成（第三轮真机反馈 P0 三项）

### P0-3 图表「该渲染就渲染」（commit c7ba87a）
- **反馈**：主人说「图表放在最后渲染效果不好，而且还是容易渲染不出来，该渲染的时候就渲染」。
- **根因**：上一版为降卡顿做成「整条消息流式期都不渲染 mermaid、完成才渲染」。
- **改法**（`MessageBubble.tsx`）：
  - 加 module 级纯函数 `isMermaidFenceClosed(content, blockCode)`：正则提取所有【已闭合】```mermaid 块的代码体集合做 trim 成员判定。
  - code renderer mermaid 分支：`closed = !isStreaming || isMermaidFenceClosed(deferredContent, childStr)`，闭合块即渲染，只有正在书写的最后未闭合块 `pending=true` 显源码占位。
  - `MermaidBlock` 加 `mermaid.parse(suppressErrors)` 预校验，半截/无效静默保留旧 svg 防红框闪烁。
- **验收**：流式生成含 mermaid 的回答，每个 ``` 闭合的图表应立即渲染成图（不再等整条消息结束），最后正在写的半截块显示源码占位。

### P0-2 auto retry 误中断（commit 9eb4e59）
- **反馈**：主人说「要注重对话区域的 auto retry，刚刚的中断可能是这个原因」。
- **根因A（治本，主因）**：上游/网关在生成完成前【静默掐断】TCP 连接时，`reader.read()` 返回 `done=true`（不抛错），旧代码把半截内容当正常 `done` 收尾 → 用户看到「回答说一半突然停」。
- **根因B（加固）**：`abort()` 把 `abortController` 置 null 后，`signal.aborted` 经 `?.` 短路成 undefined，极端时机用户主动停可能被误判网络错重试。
- **改法**（`aiClient.ts`）：
  - 跟踪 `sawFinish`（收到 `finish_reason` 非空 或 `[DONE]`）；`finish_reason` 捕获前移到 `if(!delta)continue` 之前。
  - reader 自然 done 但 `!sawFinish && streamedAny` → throw 进 catch 走可重试重连 + resetContent。
  - 加 `_userAborted` 标志 + `aborted` getter，三处 classifyError 改用它。
- **验收**：长回答中途网络抖动/上游断流时应自动重连续写而非半截停住；点「停止」应干净中止、不触发重试。（真实断流难复现，重点验「停止」按钮行为正常 + 长回答能完整输出。）

### P0-1 工作区路径统一（commit 007a4e7）
- **反馈**：主人「图三系统工具不完备」+ 那边 AI 自检「路径混乱 / list_dir workspace 套娃 / search_files 搜不到 / 相对路径 cwd 不一致」。
- **根因**：
  1. `list_dir` 无 worktree 时忽略 `args.path`、永远铺主工作区整棵树（maxDepth=3）+ formatNode 递归整棵 → 套娃刷屏。
  2. `search_files` 用 `searchFiles`（只查内存 3 层树 + Web 上传文件），真机深层/未加载文件搜不到。
  3. `readFile`/`writeFile` 无 worktree 时相对路径原样透传 → 主进程 `process.cwd()` 兜底落安装目录 synapse-app。
- **改法**（纯渲染端，不碰 electron 侧）：
  - `fileSystem.ts`：抽 `redirectIntoWorktree` 纯函数；新增 `resolveWorkspacePath`（无 worktree 时相对路径锚工作区根）、`getWorkspaceRootResolved`（权威根）；readFile/writeFile 改走前者；`searchInWorkspace` 加 rootOverride；旧 `searchFiles` 标 @deprecated；`DEMO_WORKSPACE_PATH('/workspace')` 当假路径 sentinel 隔离（防相对路径拼成不存在路径）。
  - `toolRegistry.ts`：list_dir 用 resolveWorkspacePath 解析 args.path + formatNode 改【单层列举】（治套娃）；search_files 改用 searchInWorkspace 走磁盘 file:search。
- **验收**：先「打开工作区」选真实文件夹后，让 AI：① `list_dir` 某子目录应只列该目录【一层】、不再套娃；② `search_files` 关键词应能搜到深层文件（含内容匹配）；③ `write_to_file` 相对路径应落在工作区里、不再落到安装目录。

### P0-4 图表交互式查看器（缩放 / 平移 / 全屏）
- **反馈**：主人「目前这个图表，大小排版有问题，也不能手动对图表进行调整、缩放」。
- **根因**：`.mermaid-container svg { max-width:100% }` 把大图死压在气泡宽度内，节点多就糊；渲染出来是死图无法缩放。
- **改法**：新建 `MermaidDiagram.tsx` 查看器组件（替代内联 MermaidBlock）：
  - viewport 固定高度 380px + transform stage（translate+scale，transform-origin 0 0）。
  - 工具条：缩小 / 百分比 / 放大 / 适配重置 / 全屏；Ctrl(⌘)+滚轮以鼠标为锚缩放；拖拽平移；全屏 portal modal（Esc / 点背景关闭）。
  - 初始 fit-to-contain（整图适配并居中），svg 去 max-width 约束。
- **经 5 路对抗 review（workflow wqlawwekb）修复 9 项**：
  - [high] 滚轮缩放改【原生 addEventListener('wheel', fn, {passive:false})】——React 19 onWheel 是 passive，preventDefault 失效会连带滚/缩页面（仓库 PdfViewer FIX-8/12 已记录的坑，照搬）。
  - [med] scale/tx/ty 合并 view 单 setState（updater 纯函数，StrictMode 双跑安全）。
  - [med] 拖拽改 ref 直接写 stage.style.transform、mouseup 才 setState（避免每帧重渲染）。
  - [med] ResizeObserver 兜底：折叠/隐藏区(0 尺寸)展开后补 fit。
  - [med] 闭合但语法非法的块显「图表渲染失败」而非永久「加载中」。
  - [med] will-change 仅拖拽期启用（不常驻吃显存）。
  - [low] useMaxWidth:false + CSS svg width:auto（fit 计算准确）。
  - [low] parseSvgSize 兼容带 px/% 单位的尺寸属性。
  - [low] 全屏 z-index 1000 → 9000（高于 toast/fileTree，低于全局 modal）。
- **验收**：让 AI 生成一张多节点流程图 → ① 初始应整图适配查看框居中、不再糊成一团；② 工具条放大/缩小/适配可用、百分比正确；③ Ctrl+滚轮在图上缩放、页面不跟着滚；④ 拖拽可平移看不同区域；⑤ 点全屏放大看大图、Esc/点背景退出。

## 二、待复核 / 小本本

- [ ] **Sidebar demo 假路径** `Sidebar.tsx:101` dispatch `openWorkspace({ path: '/workspace' })` 污染 Redux currentPath。本轮用 sentinel 隔离规避，但根上应让 demo 兜底不写假路径进真实路径字段。
- [ ] **性能批2 订阅隔离**（降级，卡顿已大好）：A 收窄 AgentPanel 订阅 / C1 断左栏整 conversation 订阅 / C2 抽 MessageList memo / D2 分块增量。
- [ ] **#1 全局 tab 标题**仍显示消息截断（「当前/全部对话」标题已正确）。
- [ ] **#4 输入框自动增高丢了**（autoResize 回归？真机复核）。
- [ ] **#6 中止后输入框无法输入**（疑卡死衍生，P0-2 修后复测是否还在）。
- [ ] **#8 权限弹窗原生 UI → 前端化对齐**。
- [ ] 工具补全：`search_web` 接真实 API、`read_url_content` 修、`read_course_material`/`generate_summary` 真解析（现占位）、`memory_delete` 工具。
- [ ] **MermaidDiagram DOMPurify 配置冗余**（review low）：htmlLabels:false 已不产出 foreignObject，但 sanitize 仍开 html profile + ADD_TAGS foreignObject，轻微扩攻击面。当前保持现状（图表文字已验证正常，避免改动引入「只剩框」回归），后续可收紧为纯 svg profile 并真机回归。

## 三、第三轮反馈批（已全部完成 + commit）

| 项 | commit | 说明 |
|---|---|---|
| 命令中断转圈 → cancelled | `1dc4f86` | 中断/恢复时收尾未完成工具，ToolCallCard 加 cancelled 态 |
| 模型参数门控 | `d543d02` | 不支持的参数不发请求体 |
| 性能·ConversationList 断订阅 | `0ded3cd` | 断整 conversation 对象订阅，回调走 store.getState |
| 权限弹窗前端化 | `715f974` | ApprovalDialog 玻璃浮层替代 window.confirm |
| show_artifact 产物推送 | `7d922df` | AI 主动推产物卡片，点开在编辑器打开 |
| search_files 搜不到 | `375cc04` | 搜索根与 list_dir 同口径（resolveWorkspacePath） |
| **task_boundary 任务边界** | `fce7d97`/`0bdb591`/`1900e6c` | 数据层+持久化+4工具+卡片+历史变迁浮层+渲染+接线全链路 |
| 工作区重启持久化 | `f176080` | persist workspace + Sidebar 启动恢复 fileSystem |
| 图表加载提速 | `eb49c5d` | mermaid 模块级单例 + initialize 按 theme 缓存 |
| 模型参数可单独改 | `49e5f63` | 上下文窗口手动覆盖，覆盖所有用 contextWindow 处 |

### 第三轮小本本（待复核/后续）
- [ ] **task_boundary 卡片渲染位置**：首版渲染在消息流【末尾】（所有边界堆底部）。反重力是按任务发生位置内联穿插——需 begin_task_boundary 时记 anchorMessageId（当前 assistant 消息），渲染按 anchor 插到对应消息后。首版能看到卡片 + 历史变迁，精确穿插待优化。
- [ ] **task_boundary gating 软引导**：现仅靠 systemPrompt planning guidelines 引导（fast 模式 prompt 不提）+ agentSettings.taskBoundaryEnabled 开关（已存但 prompt gating 用 context.taskBoundaryEnabled，需 agentLoop 构造 context 时传入才完全生效）；硬 gating（schema 过滤非 planning 不给工具）+ SettingsPanel 开关 UI 待补。
- [ ] **sandbox / web-fetcher MCP + 原生读 OFFICE/PDF**（主人图6，明确「之后一定要做」）：当前 sandbox 与 web-fetcher 尚未接；原生用什么库读 office/pdf 待定（现走 LibreOffice 转换 + pdf.js，但工具层未暴露给 AI）。
- [x] **task_boundary 回溯/编辑联动**（规范 §10.6）：✅ 第四轮已做——clampTaskBoundariesAfterTruncation 在 truncateAt/editMessage/clearMessages 裁剪边界（anchor 不在则丢弃、active 收口防永久脉冲）。

## 四、第四轮反馈批（task_boundary 吞消息返工 + 性能根治 + UI）

> 主人第四轮真机反馈 8 项 + 我对抗 review（workflow 6 路）自查 11 条 bug，本轮一并处理。

### 性能根治（诊断子代理定位，治「发消息卡到未响应」+ 流式卡顿 + 图表加载久）
| 项 | 改动 |
|---|---|
| 1-A 关 dev 中间件 | `store/index.ts` getDefault 关 serializableCheck+immutableCheck（每 dispatch 深度遍历巨大 messages 树是「未响应」元凶，dev 日志已实锤 60ms+） |
| 1-B token encode 移出发送路径 | agentLoop 工具集 token 按引用缓存 + 两遍全历史遍历合并成一遍（子代理，纯算术等价，不破坏压缩语义） |
| 3-A1 回调稳定 | handleEdit/handleRetry/handleDelete/handleUndo 改读 `conversationRef.current.messages` 去 messages 依赖 → MessageBubble memo 流式期不再全列表陪渲 |
| 3-A2 batchDivider | 依赖改 messages.length（流式 content 变不重算 O(n) 双层遍历） |
| mermaid 预热 | 未闭合块提前 import mermaid/DOMPurify 大 chunk（幂等缓存），闭合即渲染，治「图表加载久」 |

### task_boundary 卡片吞消息返工（反重力式，本轮最大）
- **数据层**（conversation.ts）：TaskBoundary 加 `endAnchorMessageId`（吞消息区间下界）；`clampTaskBoundariesAfterTruncation` 截断裁剪（回溯/编辑/清空，治漂末尾+active 永久脉冲 HIGH bug）；`set_task_headline` summary 缺省保留（配合 handler 传 undefined，治误清概括）。
- **渲染**（AgentPanel）：按 `[anchorMessageId, endAnchorMessageId]` 区间归组，区间消息收进卡片 children（非平铺）；聚合区间 diffs/artifacts 作「已编辑文件」chips。
- **卡片**（TaskBoundaryCard 重写）：容器布局 = headline+summary+已编辑文件(可点击打开)+进度更新(可折叠)+完整过程(children 可折叠，active 默认展开/done 收起)+历史变迁浮层。
- **持久化 bug**：branchConversation anchor/endAnchor 按 idMap 重映射 + toolCallIds 深拷贝；handleBranch promotion 补 taskBoundaries/taskHeadline/goal（治分支丢边界 HIGH）。

### UI
- 系统工具默认隐藏（show_artifact/task_boundary 系列/worktree 等元工具，AgentPanel filterSystemToolCalls）+ SettingsPanel 开关（隐藏系统工具 + 任务边界卡片两个 checkbox）。
- 顶部栏玻璃化 3 处（子代理，复用 `--glass-bg`：WindowTitleBar/.tab-strip/.code-editor-toolbar+.viewer-toolbar）。
- artifact 卡片放大（子代理，chat.css .artifact-chip 等，CSS 覆盖图标尺寸）。
- 全局列表标题修复（子代理，conversationPersistence legacy 去重基准升级为 platform 全量 id）。
- context window 输入框非受控+key+onBlur/Enter（治逐字中间态 2→20→200 误触发压缩 MEDIUM）。
- workspace demo sentinel '/workspace' 持久化死局 + mermaid import 失败永久缓存不自愈（子代理）。

### 第四轮小本本（降级/后续）
- [ ] **1-C 拆 AgentPanel conversation 整对象订阅**（降级：1-A 已治大头，拆订阅改动面大风险高，后续按需）。
- [ ] **2-B 定时器收敛 / 3-B2 isMermaidFenceClosed 缓存**（降级：live timer 通常仅 1 个、fence 仅流式有图表时，收益小）。
- [ ] **按消息缓存单条 token**（1-B 子代理提的更大优化，需改 store/类型层挂 token 缓存字段）。
- [ ] **task_boundary gating 硬过滤**（schema 非 planning 不给工具）——现软引导，主人说「没问题」。
- [ ] **sandbox / web-fetcher MCP + 原生读 office/pdf**（主人图6，「之后一定要做」）。

# Task_8 — M8 P0修复 + 并发治本 执行清单

## ✅ Stage P0-A：#5 双流 / #12 中止卡（已完成 commit 648bcd2）
- 目标：根治插入消息双流+中断不了、中止卡UI
- 依据：Task_第三批反馈 #5/#12
- 执行清单：
  - [x] agentLoop 全局 runningAgentLoops 登记表（run登记/stop+finally注销）+ window埋点
  - [x] handleStop 遍历副本停全部 loop（含幽灵）+ 幂等 setStreaming(false)
  - [x] settings.safety 摘出 loop 工厂 useEffect → 独立 effect 热更新 updateAutoApprove
- 验收：[x] 双编译EXIT0 [x] CDP：改设置无幽灵/插入不双流/中止干净归0

## ✅ Stage 文件树：maxDepth（已完成 f22be9e）
- [x] IPC默认3→8 + settings.fileTreeMaxDepth + 滑块 + Sidebar贯穿
- 验收：[x] CDP直连IPC maxDepth=8树深8/229目录

## ✅ Stage #7 Mermaid（已完成 8c5f275）
- [x] MarkdownViewer 补 code 映射→MermaidDiagram（无需改CSS,样式全局）
- 验收：[x] CDP DOM mermaid渲图+标准表格正常（表格图七是源数据）

## ✅ Stage #1 @@美化（已完成 3cea65e）
- [x] ReviewChangesView formatRangeHeader 翻人话
- 验收：[x] 编译（视觉随#2/#6测时确认）

## ✅ Stage #4 实时同步（已完成 6bf1e77）
- [x] openTabSync.refreshOpenTabsForChanges + agentLoop/agentOrchestrator 接入
- 验收：[x] CDP AI写文件→tab自动刷新

## ✅ Stage #6/#10 diff合并（已完成 e4e9085）
- [x] FileDiffSummary加originalSnapshotId/originalBeforeHash/afterContent
- [x] addMessageDiff同path+contextId+pending合并累积diff
- [x] toolRegistry透传afterContent
- 验收：[x] CDP 连写2次pendingDiff恒1条/accept零卡死

---

## 🔨 Stage byId 真并发治本（设计固化，待执行）
- 目标：#8 切对话A后台继续写A切回看到+B不污染；顺带治#9卡UI
- 依据：`Plan_8_byId真并发治本.md`（6步详设）
- 开始条件：新上下文（本批过夜上下文已满，防botch未硬上）
- 执行清单：
  - [ ] 步1 conversation.ts state改 byId+activeId+PerConversation桶
  - [ ] 步2 全写入reducer加conversationId路由（含迁#6/#10合并进桶）
  - [ ] 步3 agentLoop全dispatch带execContextId
  - [ ] 步4 setActiveConversation切对话不停run + hydrateConversation建桶
  - [ ] 步5 订阅细粒度化（治#9）AgentPanel/StatusBar/EditorArea
  - [ ] 步6 持久化按桶 + run finally后台桶落库
- 验收：8步CDP双对话实测（见Plan_8_byId文档五节）——B干净/A后台写byId[A]/切回完整/不卡/reload不丢
- ⚠️ 撞到无法默认的设计岔路→停安全commit点记此处留主人定

## 🔨 Stage #2 inline diff 重做（设计固化，待执行）
- 目标：文件本体红绿+√×(仿反重力图四)，废SingleDiffView
- 依据：`Plan_8_inline_diff_#2.md`；**必Read图四/二/三**
- 执行清单：
  - [ ] 步1 统一opener（openDiffTarget/handleFileClick带diffId开普通viewer）
  - [ ] 步2 CodeEditor/MarkdownViewer按行红绿装饰+行内√×（建议只读装饰层降风险）
  - [ ] 步3 废diffview/SingleDiffView，ReviewChangesView留唯一review入口
- 验收：CDP两路径打开都显文件本体inline diff非review页

## 🔨 Stage A状态色 / D右键菜单 / 文件树懒加载 / browser use
- [ ] A 对话四态闪烁色点（依赖byId）
- [ ] D 顶部+列表右键菜单（仿Codex，部分需补底座）
- [ ] 文件树懒加载治本增强
- [ ] browser use Stage G（二期，补Codex调研结论）

## 待复核/小本本（见 Plan_8.md 末尾）
- [ ] M8_真机交接 3处 ../Plan_7 失效链接待修
- [ ] #6/#10对pre-existing多条旧pending只合第一条
- [ ] autoApprove生产韧性（如反馈再增强）
- [ ] 后台桶内存保留策略

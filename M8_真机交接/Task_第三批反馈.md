# M8 真机第三批反馈 — 详细交接 Task

> 来源：对话 9821e6b3-76e3-431e-b6d4-0c1d88af0308 轮 326/327/329/331（主人真机测试 Plan_7 批1-9 成果后的反馈）。
> 图已存 `M8_真机交接/images/`，每条都 Read 核对过，非脑补。
> ⚠️ 主代理（上一轮）这批 P0/interrupt/isRunning 改动**拔萝卜带出泥**，引入了 #5/#8/#9/#12 一串对话 bug，是本批最高优先。

---

## 一、图索引（已 Read 核对，16 张）

| 文件 | 实际内容 | 对应反馈 |
|---|---|---|
| `images/r000325-1/2/3` | 验收时上下文用量截图（Context window 530.5k/1M 53%、Plan usage） | 无（验收上下文） |
| `images/r000326-1` | 同上，Context window 截图 | 无 |
| `images/r000327-1.webp` | 「测试Synapse平台」对话：task_boundary 多步 + 用户「插入测试消息」+ 两条「思考中」并存 | **#5 双流** |
| `images/r000327-2.webp` | **反重力 Antigravity 截图**：test_file_0623.txt 在编辑器打开，第3行「今天是个好日子呢，主人！」红底（删除），行尾有 ✓ ✗ 放大 三个按钮（inline 装饰） | **#2 期望效果** |
| `images/r000327-3.png` | Synapse review changes 视图：`@@ -0,0 +1,8 @@` + 「段 -0,0 +1,8」+ 绿色新增行 | **#1 @@ 是什么** |
| `images/r000327-4.webp` | 收到消息测试.md 在编辑器打开 + 右侧对话「1 个文件待审查 +10 -0」 | #4 上下文 |
| `images/r000327-5.webp` | 收到消息测试.md 编辑器内左侧显示 SingleDiffView（`@@ -6,3 +6,13` + 接受此块/接受此段/接受全文件） | **#2 现状（做偏了）** |
| `images/r000329-1.webp` | Artifact「Harness 工具关系图」：`flowchart TD U[用户]-->UI...` **渲染成纯文本源码、没成流程图** | **#7 Mermaid 图** |
| `images/r000329-2.webp` | 「3 个文件待审查」全是同一个「收到消息测试.md」(+10-0 / +13-0 / +8-11)，没合并 | **#6/#10 冗余** |
| `images/r000329-3.webp` | 「思考中」+ 1 个文件待审查(+12-10)；左侧露出 KaTeX 公式 8/8=1（KaTeX 已 OK 旁证） | #7 KaTeX OK 旁证 |
| `images/r000329-4.webp` | ref_new.md 预览：表格渲染了**但 `**序号**` 等加粗语法未解析（显示字面 **）、无边框线、列对不齐** | **#7 表格** |
| `images/r000329-5.webp` | 一堆「接受失败：文件已在 AI 修改后继续变化，已停止文件级审阅：收到消息测试.md」通知堆叠（7+ 个） | **#10 接受失败** |
| `images/r000331-1.webp` | 「继续文件增删改排队测试」卡片【已中止】+ 7 个文件待审查（收到消息测试.md ×7：+10/+13/+8/+37/+25…）+ 输入框 /compact | **#12 中止卡 + 冗余** |

---

## 二、13 点反馈（逐条，可勾选）

### ✅ 已验收通过（主人确认 OK，勿动）
- [x] **#3** 发消息回复正常 + 用户气泡不显示模型型号 + 消息导航按轮生成（commit 3697cc3 / 7943aa3 / 7a49d9c）
- [x] **#11** 设置中止（#2 设置中止）已 OK
- [x] **#13** #19 个性化(头像昵称裁剪) / #12 命令彩色 chip / #9 编辑框加号小窗 已确认

### 🔴 P0/HIGH — 主代理副作用（拔萝卜带出泥，最高优先）

- [ ] **#5【P0】插入消息(interrupt)→ 双 agent 多重请求、且中断不了**
  - 主人原话：「插入消息直接把对话搞成多重请求了，非常恐怖。插入消息的时候原本消息流没变化继续生成而不是中断，同时插入消息直接开了一个新的消息流。结果就是一个对话同时两个 agent 在生成消息，而且连中断都中断不了！」
  - 图：`r000327-1.webp`（task_boundary 多步进行中 + 用户「插入测试消息」+ 两条「思考中」并存=双流铁证）
  - 现状：interrupt（Ctrl+Enter / 运行时键位）入队后，AgentPanel 空闲 effect 或 dispatchUserSend 又起了一个新的 agentLoop.run，与原 run 并发 → 两个 agent 同时写。
  - 期望：插队消息应只进 interruptMessages，由【正在跑的那个 run】在轮间 drainInterruptMessages 消费，绝不另起新 run。中断能一键停掉全部。
  - 怎么改：查 AgentPanel 的 handleSend interrupt 分支 + 空闲 effect（上一轮改成 `isStreaming || isRunning` 闸门）——很可能 isRunning 守卫没挡住「interrupt 入队后又被 effect 当空闲发出去」；确认 interrupt 只入队不 run，drainInterruptMessages 是唯一消费者。中断要能停 agentLoop 主 run + 任何被误起的并发 run。
  - 疑似根因：上一轮 #6 双队列 + isRunning 闸门改动。**重点回归审 AgentPanel interrupt 链路 + agentLoop.run 重入。**

- [ ] **#12【P0】中止后一直卡「中止中」UI、点了没用**
  - 主人原话：「中止后一直卡中止 UI 不停止，点了没用，不知道是不是那一个插入导致的」
  - 图：`r000331-1.webp`（卡片「已中止」但下方还卡着一堆待审查 + 输入框试 /compact）
  - 现状：handleStop / agentLoop.stop 后，UI 仍停在「中止中」态，可能因为有并发 run（#5）没被一起停，或 isStreaming/isRunning 状态没复位。
  - 期望：点中止 → 立刻停所有 run + 状态复位，UI 恢复可用。
  - 疑似根因：与 #5 同源（双流导致 stop 停不干净）。

- [ ] **#8【HIGH】生成中切换对话 → 串线（原 run 追到新对话继续写）**
  - 主人原话：「当前生成过程中切换对话会直接串线，跟那个被追杀一样追到切换之后的对话继续」
  - 现状：切对话 `handleSwitchConversation` 只做 exitWorktree + setConversation，**不停原 run**；conversation 又是单对话 slice → 原 run 继续 dispatch 写到新对话（串台）。
  - 期望：这正是上一批 #3「真并发隔离」要做的——主人已选「A 后台继续写 A、切回看到」。但在真并发做好前，**至少不能串到 B**。短期止血：切对话时把原 run 的写入按 execContextId 隔离（写不进当前 slice 就丢弃/落持久化），或切对话即停原 run（次选，违背主人要的后台继续）。
  - 关联：上一批待办 B「真并发隔离」。

- [ ] **#9【HIGH】生成中点 切换对话/新建/打开文件/中止 → UI 卡**
  - 主人原话：「生成过程中点击切换对话，新建对话，打开文件，中止等 UI 会卡，虽然现在滚动等不卡了，但是这个卡对我们之后问题很大」
  - 现状：生成中这些操作触发的重渲/dispatch 被流式高频更新阻塞，主线程卡顿。
  - 期望：生成中这些交互依然流畅。
  - 怎么改：排查生成中高频 dispatch（appendMessageContent 等）是否阻塞这些操作的事件处理；可能要把这些操作的 dispatch 提优先级 / 流式渲染进一步降频 / 用 transition。

### 🟠 HIGH — 文件 diff 冗余（导致接受卡死）

- [ ] **#6/#10【HIGH】同一文件多次修改不合并 +/−，堆成多条冗余 → 接受失败卡死**
  - 主人原话：「同一个文件的修改不会合并 +-，而是显示为很多条的冗余」「图十的问题更弱智，因为你没合并一个文件的后续变化，导致接受都接受不了，直接卡在这了这堆」
  - 图：`r000329-2.webp`（3 条全「收到消息测试.md」）、`r000329-5.webp`（一堆「接受失败：文件已在 AI 修改后继续变化，已停止文件级审阅」）、`r000331-1.webp`（7 条同名待审查）
  - 现状：AI 对同一文件多次 write/edit，每次产生一条独立 pendingDiff，不合并；后一次修改让前一次的快照失效，接受时报「文件已在 AI 修改后继续变化，已停止文件级审阅」，全卡住接受不了。
  - 期望：同一文件的多次修改**合并成一条累积 diff**（基于原始快照 → 最新内容的总 diff），一次 accept/reject 即可。
  - 怎么改：pendingDiffs 按 path 合并（同 path 只保留一条，diff = 原始 snapshot → 当前文件内容重算）；accept/reject 走最新内容。查 conversation slice 的 pendingDiffs 结构 + fileRollback + agentLoop 产 diff 处。

### 🟡 MEDIUM — 功能/渲染

- [ ] **#2【需重做】行内 diff 理解偏差：要文件本体红绿+√×，不是 review changes 界面**
  - 主人原话：「这个在文件上显示红绿变化不是 review changes 这样的页面，就是我不管从任何一个地方打开文件，就是图二这样的，上面显示红绿的和 √ ×，你看我之前发你的这个图四的反重力的效果。不是图三这种在 review changes 界面的，只有 review changes 这个才是这个样式的界面」
  - 图：**期望** `r000327-2.webp`（反重力：打开文件本体，删除行红底、行内 ✓✗ 放大按钮）；**做偏的现状** `r000327-5.webp`（SingleDiffView 是 review changes 界面风格）
  - 现状：上一轮做的 SingleDiffView 是「review changes 界面」风格（@@/段/接受此块），方向错。
  - 期望：**任何方式打开有未 accept 改动的文件 → 文件本体（普通编辑器视图）上直接叠加 inline diff 装饰**——删除行红底、新增行绿底、每处改动行内 ✓✗ 接受/拒绝。像 Cursor/反重力的 inline diff decoration。review changes 界面（@@ 那种）只保留在「Review Changes」一个入口。
  - 怎么改：在文件编辑器（CodeViewer/MarkdownViewer 等）上做 inline diff 装饰层（按 pendingDiff 的 hunks 在对应行渲染红绿背景 + 行内 ✓✗），而非另开 review 视图。上一轮的 SingleDiffView/diffview tab 可能要废弃或改造。

- [ ] **#7【MEDIUM】Markdown 表格 + Mermaid 图渲染不行（KaTeX 已 OK）**
  - 主人原话：「MD 对表格和图如图七、图八还是不行啊，KaTeX 确实可以了」
  - 图：表格 `r000329-4.webp`（`**序号**` 加粗语法未解析显示字面 `**`、无边框线、列对不齐）；Mermaid `r000329-1.webp`（flowchart TD 渲染成纯文本源码、没成流程图）
  - 现状：① 表格：单元格内的 markdown（如 `**粗体**`）未二次解析 + 缺表格边框 CSS；② Mermaid：代码块没走 mermaid 渲染、只当普通代码显示。
  - 期望：表格正常渲染（粗体解析 + 边框 + 列对齐）；Mermaid 代码块渲染成流程图。
  - 怎么改：MarkdownViewer/MarkdownPreview 的 remark/rehype 链：表格补 remark-gfm 单元格内联解析 + 表格 CSS；Mermaid 加 mermaid 渲染（项目可能已有 mermaid 依赖，见 chat.css 提到 mermaid idle，确认渲染管线为何没生效）。

- [ ] **#4【MEDIUM】打开的文件不实时同步（AI 改了要重新打开才更新）**
  - 主人原话：「目前打开文件区域打开的文件不是实时变化的，那边修改了，要重新开一次才会同步更改」
  - 现状：editorTab 打开文件后内容是快照，AI write_to_file 后不刷新已打开的 tab。
  - 期望：AI 改了文件 → 已打开该文件的 editor tab 实时刷新（或提示「文件已变更，点击刷新」）。
  - 怎么改：write_to_file 落盘后，发事件/dispatch 通知 editorTabs 对应 tab 重读内容。

- [ ] **#1【LOW】review changes 的 `@@ -0,0 +1,8 @@` 太黑话**
  - 主人原话：「review changes 这里的 @@ -0,0 +1,8 @@ 是什么？」
  - 图：`r000327-3.png`
  - 说明：这是 unified diff 的 hunk 头（旧文件第0行起0行 → 新文件第1行起8行）。主人看不懂、觉得突兀。
  - 期望：隐藏或换成人话（如「新增 8 行」/「第 X-Y 行」），别暴露 `@@` 原始语法。
  - 怎么改：ReviewChangesView / SingleDiffView 渲染 hunk 头时翻译成人话。

---

## 三、优先级建议（给新对话）
1. **先止血 P0 对话 bug**：#5 双流多重请求 + #12 中止卡 + #8 切对话串线 + #9 生成中 UI 卡——这批是上一轮 P0/interrupt/isRunning 改动的副作用，**最该先回归审查那批改动**（commit 3697cc3 / 7943aa3），可能需要部分回退或重新设计 interrupt 消费链路。
2. **#6/#10 文件 diff 合并**：影响 accept 完全不可用，HIGH。
3. **#2 行内 diff 重做** + **#7 表格/Mermaid** + **#4 实时同步**：功能完善。
4. **#1 @@ 美化**：收尾。

## 四、上一批（第二批）待办（见 Plan_7「七、真机反馈第二批」）
- A 对话状态色（绿蓝红黄闪烁） / B 真并发隔离（=#8 治本） / C 对话 ID 注入（已做待验证） / D 顶部对话栏右键菜单
- ⚠️ B 真并发隔离 与本批 #8 是同一件事；A 对话状态色的「蓝=生成中」依赖 B。

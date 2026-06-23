# Plan_8 — #2 行内 diff 重做（文件本体红绿+√×，仿反重力）设计弹药库

> 来源：子代理侦察（workflow wpvbej01x）。状态：**设计已固化，待执行**。
> ⚠️ 执行前**必 Read** 三张图核对方向（别脑补，主人反复强调）：
> - 期望=`../../M8_真机交接/images/r000327-2.webp`（图四 反重力：文件本体打开、删除行红底、行内 ✓✗放大）
> - 入口/现状=`../../M8_真机交接/images/r000327-4.webp`（图二：普通 Markdown 预览、无红绿√×，要在这上面叠加）
> - 做偏=`../../M8_真机交接/images/r000327-5.webp`（图三：上一轮做成了 review-changes 风格 SingleDiffView，方向错）

---

## 一、要解决什么
主人原话：「在文件上显示红绿变化**不是** review changes 这样的页面，不管从任何地方打开文件，就是图二这样的，上面显示红绿的和 √×，参照图四反重力。**不是**图三这种 review changes 界面。」
- 期望：任何方式打开有未 accept 改动的文件 → **文件本体（普通编辑器视图）上直接叠加 inline diff 装饰**——删除行红底、新增行绿底、每处改动块行内 ✓✗ 接受/拒绝（像 Cursor/反重力）。
- review changes 界面（@@/段/接受此块）只保留在「Review Changes」一个入口。

## 二、根因（path:line）
两条「打开文件」链路取向不一致：
- **侧边栏点文件** → `Sidebar.handleFileClick`(Sidebar.tsx:137-144)：只 `resolveEditorType` 开普通 viewer，**完全不查 conversation.pendingDiffs** → 图二无红绿。
- **对话流 diff chip 点文件** → `AgentPanel.openDiffTarget`(2143-2176)：匹配到 pending diff 就开 `type:'diffview'` tab(2162) → `EditorArea` case 'diffview'(291) 渲染 `SingleDiffView` = review-changes 风格（同 @@/段/接受此块）= 图三做偏。
- diff 数据齐：`pendingDiffs[id].hunks[].lines[]` 每行带 `type/content/oldLine/newLine`（conversation.ts:115-141），足够在文件本体对应行渲红绿。

## 三、方案（3 步）
### 步1 统一入口取向
- 删/改 `openDiffTarget`(AgentPanel.tsx:2153-2166) 里「有 pending diff 就开 diffview」那段 → 改成始终 `resolveEditorType` 开普通 viewer，并把 diffId 塞进 openTab payload（`EditorTab.diffId` 已有，editorTabs.ts:27）。
- `Sidebar.handleFileClick`(Sidebar.tsx:137) 同步：开普通 viewer 时也带该 path 当前 pending diff 的 id（从 `store.conversation.pendingDiffs` 按 path+status(pending/mixed) 查）。

### 步2 装饰渲染（核心）
- 给 MarkdownViewer 的源码/分屏（内嵌 CodeEditor）和 code tab 的 CodeEditor 加可选 prop `inlineDiff?: FileDiffSummary` + √×回调。
- CodeEditor（CodeEditor.tsx:199-259 现在是「透明 textarea 叠 Prism 高亮 pre」单体）：按行渲染——新文件行(newLine)命中某 add block → 该行容器加 `.add` 绿底；删除行(delete 无 newLine)作只读红底行插入；每个连续改动块右上角浮 ✓(accept)✗(reject) 小按钮（仿图四）。
- ✓✗ 复用 EditorArea 现有 `applyBlockReview/applyHunkReview/applyDiffReview` + `updateDiffBlockStatus/updateHunkStatus/updateDiffStatus`（EditorArea.tsx:262-283 已验可用）。红绿底复用 `editor.css:1678-1687 .review-diff-line.add/.delete` 配色，但**新开一套选择器挂文件本体行容器**。

### 步3 收口 review 界面
- `EditorArea` case 'diffview'(291) + `SingleDiffView` 整体废弃（或 diffview 直接重定向到带 inlineDiff 的普通 viewer）。
- `ReviewChangesView`(type:'review') 作为唯一「Review Changes」总览入口保留不动（#1 @@人话已在这里改好，commit 3cea65e）。

## 四、风险（务必防）
1. **CodeEditor 单体结构改按行渲染+行内按钮**=本次最大改造点、回归风险高（破坏像素对齐/滚动同步/可编辑性）。**强烈建议**：inline diff 装饰做成**只读叠加**——diff 存在时该 viewer 进只读审阅态，accept/reject 完才回可编辑，避免与编辑态打架。删除行需「插入原文件不存在的额外行」与 textarea 真实内容错位，这也是倾向只读装饰层的原因。
2. **MarkdownViewer preview 模式无行概念**，红绿只能落 source/split 的 CodeEditor。有 pending diff 的 md 打开时默认切 source/split，preview 模式给「有 N 处未审改动，点击切换查看」提示条。
3. 两 opener 统一后去重键别撞（现 diffview 用 `diff://id` 去重，改普通 viewer 后同文件普通 tab 与带 diff 的 tab 可能撞 path，保留稳定去重）。
4. accept/reject 后触发 viewer 重读最终内容并清装饰（响应式刷新 pendingDiffs 状态变化）。

## 五、CDP 验证
在「水桶理论聊天」工作区让 AI 改/建一个 md 产生 +N 改动，然后**两条路径都验**：① 左侧课件管理双击该 md ② 对话流 Edited chip 点该文件——截图确认两者都在**文件本体（普通编辑器视图）**显示删除行红底/新增行绿底/改动块行内 ✓✗（对齐图四），而**不是图三的 @@/段/接受此块独立页面**。点行内 ✓ 接受某块→装饰消失、文件落最终内容；点 ✗ 拒绝→回退。确认「Review Changes」按钮打开的仍是总览页（唯一 review 入口）。

## 六、关联
- #1 @@人话已改好（ReviewChangesView，commit 3cea65e），本设计步3 保留 ReviewChangesView 不动。
- 本设计**独立于 byId**（不冲突），可在 byId 之前或之后做；但 CodeEditor 改造风险高，建议主人能盯时做或先小步只读装饰层验证。

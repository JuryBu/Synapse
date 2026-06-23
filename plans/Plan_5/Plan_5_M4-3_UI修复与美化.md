# Plan_5 M4-3 — UI 修复与美化

> 子代理（opus）逐文件读代码后的设计（2026-06-16），并按主人最终决策修正。实现时按此推进。
> 范围：纯前端改动，**不碰** Electron 主进程 / IPC / DB。按「先低风险 bug → 后美化增强」推进，每个 stage 可独立 `npm run build` 验证。
> 全部文件路径以 `synapse-app/` 为根（即 `C:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app\`）。

---

## ① 目标

修复 4 个真实 UI bug / 缺失，并完成 3 项主人决策的美化 / 增强，把 Synapse 的核心交互观感推到成熟 agent harness 水准：

- **bug 修复**：①输入框无 auto-resize 且超高被裁；②思考块渲染在正文下方；③已发消息附件不可点开（死 div）；④设置页开发自检表外泄给终端用户。
- **美化 / 增强（主人决策）**：⑤文件树彩色图标主题；⑥文件夹优先排序；⑦编辑器 tab 栏 VS Code 式 `...` 菜单 + 真正的预览 tab 机制 + 快捷键。

---

## ② 覆盖问题（对应用户问题编号）

| 编号 | 类型 | 一句话 |
|---|---|---|
| 问题1 | bug | 聊天输入框 textarea 无 JS auto-resize，CSS 有 `max-height:120px` 但无 `overflow` → 超高被裁切不滚动 |
| 问题5a | bug | `MessageBubble` thinking-block 渲染在 `message-content` 之后 → 思考显示在正文下方 |
| 问题5b | missing | 已发消息附件点击无法打开（无 `onClick` 的 `div`） |
| 问题8 | 主人决策 | 删 `SettingsPanel` 开发自检表 `settingAuditRows` + `SettingsAuditMatrix`；safety/data 页措辞中性化；删表后控件纵向排布 + 宽内容横向滚动兜底 |
| 文件图标 | 主人决策 | `FileTree` 改用内置 material-icon-theme 风格彩色 SVG 子集按扩展名映射 |
| 文件树排序 | 主人决策 | `FileTree` 改为文件夹优先 + 组内字符序 |
| 编辑器 tab 栏增强 | 主人新增（参考 WSF） | `...` 菜单（Show Opened Editors / Close All / Close Saved / Enable Preview Editors / Lock Group / Configure）+ 预览 tab 机制（单击=斜体临时、双击或编辑=固定）+ 快捷键 |

---

## ③ 确认现状 / 真根因（逐文件读代码核实，并纠正 brief 中 3 处与代码不符的诊断）

### 问题1（brief 准确）
- `src/components/layout/AgentPanel.tsx:1349-1357`：textarea `rows=1`，`onChange` 只 `setInput(e.target.value)`，**无任何高度计算**。
- `src/styles/layout.css:822-834`：`.agent-input` 有 `min-height:20px` / `max-height:120px` / `resize:none`，但确实**无 `overflow-y`** → 超 120px 内容被裁且不可滚。
- 结论：brief 描述完全准确。

### 问题5a（brief 准确）
- `src/components/chat/MessageBubble.tsx`：`message-content` 在 341-431 行，thinking-block 在 449-459 行，确在正文**之后**。
- `thinkingOpen` 折叠 state 在 165 行（默认 `!thinking?.collapsed`）。
- 结论：把 thinking 块 JSX 整体上移到 `message-content` 之前即可，**折叠逻辑无需动**。

### 问题5b（brief 部分需纠正 —— 本里程碑最大的现实校准）
- `MessageBubble.tsx:436` 的 `message-attachment` 确是**无 `onClick` 的纯 div**，图片走预览模态可行。
- 但 brief 说「文档类走编辑器区 `openTab`（混合方案）」在当前架构下**不可直接成立**，真根因有三条：
  1. 附件采用 **sha256 内容寻址存储**（`platform.attachment`，桌面 fs IPC / 网页 IndexedDB），对话本体 / DB 只存 sha256 + 元数据（name/mime/size），**不保证有工作区 `filePath`**（`attachmentRefs.ts` 头部契约明确）。
  2. `EditorArea.tsx` 的所有 viewer（`CodeFileViewer:332` readFile、`PdfFileViewer:259-264` getFileUrl/readBinary、`DocxViewer`/`PptxViewer`/`OfficeViewer` 均按 `filePath` 走 fileSystem、`ImageViewer:81` getFileUrl(filePath)）——它们读的是 **fileSystem 工作区路径**，而附件 blob **不在该路径体系内**。
  3. `platform.attachment` 只暴露 `put/get/has/delete/addRef/release`（`platform/index.ts:205-212`），`get` 返回 blob 数据**而非工作区路径**；renderable 的 `AttachmentInfo` 持的是 `payloadUrl/previewUrl`（blob/object URL），不是 `filePath`。
- **真根因结论**：要让附件能被打开，必须先把附件落成一个可被消费的 URL（`attachment.get` 拿 blob → `URL.createObjectURL` → objectUrl），再带 URL 生命周期管理。
- ★ **主人已拍板走「新 tab type `'attachment'` + 图片走预览模态」**（见 ⑦ openQuestions 决议 S3），故不再尝试让现有 viewer 兼容 objectUrl，而是新增专用 tab type，避免污染现有 viewer、避免 Docx/Pptx/Office 吃不下 objectUrl 的白屏风险。

### 问题8（brief 准确）
- `settingAuditRows` 定义在 `SettingsPanel.tsx:128-175`，`SettingsAuditMatrix` 组件在 1679-1700，且在 **10 个设置 tab 页各渲染一次**（grep 实证行号：790/923/1113/1154/1195/1228/1305/1551/1627，外加组件本体引用共构成 10 处调用）。
- `auditStatusClass` 辅助函数 1702-1707、`SettingAuditStatus` / `SettingAuditRow` 类型在 94 行附近。
- 中性化措辞具体落点：1168 / 1173「固定默认，暂未开放调整」、1590「Electron 文件缓存与数据库缓存暂列待确认扩展」。
- `settings.css:284-329` 是 audit-matrix 全部样式（删表后这段 CSS 一并清掉）。
- `.setting-item` 已是 `flex+wrap` 横排（`settings.css:86-119`），删表后控件天然纵向堆叠，**无需大改布局**。

### 文件图标（brief 需评估的两方案已查证）
- `package.json` 当前**无任何图标库**（仅 `lucide-react ^0.577.0`；`material-icon-theme` / `vscode-icons-js` / `vscode-material-icons` / `file-icons-js` 全部 undefined）。
- `FileTree` 现状用 emoji：`fileSystem.getFileIcon(ext)` 返回 emoji（`fileSystem.ts:676-690`），文件夹用 📂/📁（`FileTree.tsx:88`）。
- 注意：`TabBar` 也用 lucide 图标 + `tab-icon-*` 彩色 CSS（`editor.css:314-357`），与 `FileTree` 是**两套**，本次只动 `FileTree`（主人决策确认只动 FileTree）。

### 文件树排序（brief 准确）
- `FileTree.tsx:458` 直接 `root.children?.map` 渲染，112-113 行递归子节点也直接 `node.children.map`，**全程无任何排序**——顺序取决于 fileSystem 返回的原始顺序。
- 结论：需在渲染前对 children 做「目录优先 + 组内 `localeCompare`」排序。

### 编辑器 tab 栏 + 预览 tab（brief 现状需重要纠正）
- `editorTabs` slice 已有 `isPreview` 字段（`editorTabs.ts:8`）。
- `Sidebar.handleFileClick` 打开文件时已传 `isPreview:true`（`Sidebar.tsx:126`，handleFileClick 整段 118-129）。
- `TabBar` 也已给 preview tab 加 `.preview` className + 斜体样式（`TabBar.tsx:91` + `editor.css:301-303`）。
- 但**预览语义完全没实装**：
  - `openTab` reducer（`editorTabs.ts:42-50`）只按 `filePath` 去重，**不做「新 preview 替换旧 preview」**；
  - `TabBar` 无双击 / 编辑 → 固定逻辑；
  - 无任何 `...` 菜单、无 Close All / Close Saved、无 Enable Preview Editors 开关、无相关快捷键。
- 结论：这部分是「**字段壳子已在、行为全缺**」，需补 reducer 语义 + TabBar 交互 + 全局快捷键。

---

## ④ 详细设计（按主人决策修正）

> 总体策略：纯前端改动，不碰 Electron 主进程 / IPC / DB。按「先低风险 bug → 后增强」顺序，每个 stage 可独立编译验证。

### A. 输入框 auto-resize（问题1）
- `AgentPanel.tsx`：新增 `autoResize` 工具函数：`el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,120)+'px'`。
- `onChange` 改为 `setInput(v); autoResize(e.target)`。
- 用 `useLayoutEffect` 监听 input 变化，在挂载 / 外部置空（如发送后 `setInput('')`、切换对话）时复位高度。
- `handleSend` 成功后除 `setInput('')` 外，显式对 `inputRef.current` 调一次 `autoResize` 复位（回到单行）。
- `layout.css` `.agent-input` 加 `overflow-y:auto`（超 120px 出现纵向滚动条）。
- 注意：`rows=1` 保留作为最小行；`max-height:120px` 保留由 CSS 兜底。

### B. 思考块上移（问题5a）
- `MessageBubble.tsx`：把 449-459 行整个 `{!isUser && thinking?.content && (...)}` 块**剪切**到 `message-content`（341 行 `<div className="message-content...">`）**之前**。
- 折叠 state（`thinkingOpen` / `setThinkingOpen` / 187 行 effect）与 JSX 内部结构**不动**，仅调整 DOM 顺序。
- 验证：assistant 消息思考块显示在正文上方，折叠 / 展开正常。

### C. 已发消息附件可点开（问题5b，按主人决策修正为「新 tab type `'attachment'`」方案）
1. `MessageBubble` props 增 `onOpenAttachment?: (att: AttachmentInfo) => void`，`message-attachment` 的 div（436 行）改为 `button` / 加 `onClick={() => onOpenAttachment?.(att)}`，加 `cursor:pointer` 样式与键盘可达（role/tabIndex/Enter 键）。
2. `AgentPanel` 实装 `handleOpenAttachment`：
   - **图片**（`kind==='image'` 且有 `previewUrl`）：**走预览模态**（主人决策：图片走预览模态）→ 复用现有 `previewAttachment` state / 模态（`AgentPanel.tsx:1583-1599`）。
     - 注意 `att` 是 `AttachmentInfo`（MessageBubble 形），`previewAttachment` state 是 `AttachmentRef` 形——需用一个**轻量 adapter** 取交集字段（name/size/mimeType/previewUrl 都在两者交集，可直接用）。
   - **文档 / 其它非图片**：**新增 tab type `'attachment'`**（主人决策），不复用现有 viewer：
     - 解析：若 `att.payloadUrl` 已是可用 http/blob/object URL（非 `data:`）直接用；否则用 `att.sha256` 调 `platform.attachment.get` → 得 blob/bytes → `URL.createObjectURL` → objectUrl。
     - `openTab({ id:`att:${att.sha256||att.id}`, filePath: objectUrl, fileName: att.name, isDirty:false, isPreview:true, type:'attachment' })`，并把 mime 一并带入（供 viewer 选渲染方式）。
     - 失败降级 `addNotification` 提示「附件无法在编辑器打开」。
3. **新增 `AttachmentTabViewer`**（`EditorArea.tsx` 内新增分支或独立组件）：按 mime 渲染——`image/*`→`<img>`、`application/pdf`→`<iframe>` 或 PdfViewer 吃 URL、文本类→`<pre>`、其它→「下载 / 系统打开」提示。**不污染现有 fileSystem viewer**。
4. **URL 生命周期**：`createObjectURL` 出的 url 需在 tab 关闭时 `revoke`。最简做法：解析函数维护 `Map<tabId, objectUrl>`，监听 `closeTab` / tab 列表变化时 revoke 已不存在 tab 的 url（参考 `fileSystem.memoryFileUrls` 现有 revoke 模式）。
5. `AgentPanel` 渲染 `MessageBubble` 处（`1176-1201`）补传 `onOpenAttachment={handleOpenAttachment}`。

> ★ 与设计稿差异说明：原 design 把方案选型（i 复用现有 viewer / ii 新增 tab type）留作 openQuestion。**主人已拍板方案 ii（新 tab type `'attachment'`，图片走预览模态）**，本里程碑直接按 ii 实现，砍掉「让 Pdf/Docx/Office 兼容 objectUrl」的尝试。

### D. 删开发自检表 + 措辞中性化（问题8）
- `SettingsPanel.tsx`：删除 `settingAuditRows`（128-175）、`SettingsAuditMatrix` 组件（1679-1700）、`auditStatusClass`（1702-1707）、`SettingAuditStatus` / `SettingAuditRow` 类型（94 附近），并删掉 **10 处** `<SettingsAuditMatrix rows=.../>` 调用。
- 措辞中性化（safety/data 页「待确认 / 未开放」改中性，主人决策）：
  - 1168 / 1173「固定默认，暂未开放调整」→「当前为内置默认值」。
  - 1590「暂列待确认扩展」→「当前仅清理 localStorage 缓存」之类中性表述（去掉「待确认 / 未开放 / 开发自检」味）。
- `settings.css`：删 284-329 audit-matrix 整段样式。
- 布局兜底：删表后各 tab 内容靠 `.setting-item`（`flex+wrap`，已纵向堆叠）天然成立；对个别宽内容（长路径，如 about 页 `userDataPath`、worktree `repoRoot`、mcp source 路径）补一个工具类 `.settings-wide-scroll{ overflow-x:auto; white-space:nowrap; }` 并施加到对应展示元素，防溢出撑破侧栏（`.settings-content` 当前 `overflow-x:hidden`，`settings.css:76`）。

### E. FileTree 彩色图标主题（主人决策：内置 SVG 子集，不引 npm 包）
- 方案评估结论（主人决策确认采纳「内置 material-icon-theme 风格 SVG 子集」）：
  - `material-icon-theme` npm 包是 VS Code 扩展形态，主入口是注册逻辑、SVG 散在 `icons/` 且无现成 React / ext→icon 映射 API，整包体积大、tree-shaking 差，集成成本高。
  - **采纳**：内置一个精选 SVG 子集（material-icon-theme 风格，**首批 ~40 个最常见扩展**：ts/tsx/js/jsx/json/md/html/css/py/java/rs/go/cpp/c/sh/yml/png/pdf/docx/pptx/xlsx/zip 等 + 默认 file + 文件夹 open/closed），作为 React 组件或 inline SVG 字符串放 `src/services/fileIcons.ts`（导出 `ext→SVG` 映射 + `getFileIcon(ext)` / `getFolderIcon(open)`）。彩色用 SVG 自带 `fill`，自然区分。
- `FileTree.tsx:87-89` `tree-icon` 由 emoji 改为渲染该 SVG（文件用 ext 映射、目录用 open/closed）。`fileSystem.getFileIcon` 的 emoji 版可保留给别处用（本里程碑只动 FileTree 引用，降低牵连）。
- `fileTree.css` 加 `.tree-icon svg` 尺寸（14-16px）、对齐。
- 找不到映射的扩展回退到 default file 图标。
- ★ 范围：**只动 FileTree**（主人决策），TabBar 的 lucide + `tab-icon-*` 彩色图标本里程碑不动。

### F. FileTree 文件夹优先排序（主人决策）
- `FileTree.tsx`：加纯函数 `sortNodes(nodes: FileNode[]): FileNode[]`：先按 type（directory < file）分组，组内用 `a.name.localeCompare(b.name, 'zh', {numeric:true, sensitivity:'base'})`。
- 应用点：`root.children?.map` 前（458）与递归子节点 `node.children` 渲染前（112-113）都用 `sortNodes` 包裹（用 `useMemo` 或在渲染处即时 sort 副本，**勿原地 mutate `FileNode`**）。

### G. 编辑器 tab 栏 VS Code 式增强（主人新增）

**G1 预览 tab 语义（reducer 层，`editorTabs.ts`）**
- 改造 `openTab`：当 `payload.isPreview===true` 且当前存在另一个 `isPreview` tab → 用新 tab **替换**那个 preview tab（同位置），而非新增（实现 VS Code「单击文件复用同一个临时 tab」）。已存在相同 `filePath` tab 则仅激活（保留现逻辑）。
- 新增 reducer：
  - `pinTab(id)`（`isPreview=false`，双击固定）。
  - `togglePreviewEnabled`（Enable Preview Editors 开关，存 slice 一个 `previewEnabled:boolean`，默认 `true`；`false` 时 `openTab` 一律 `isPreview:false`）。
  - `closeSavedTabs`（关闭所有 `!isDirty` 且非 welcome 的 tab）。
  - `closeAllTabs` 已有（111-114，可复用，但 dirty 确认交给 TabBar 调 `resolveUnsavedTabs` 后再 dispatch）。
  - `lockGroup`（slice 加 `groupLocked:boolean`；单 group 架构下简化为「锁定 = 禁用 preview 复用、强制新 pinned tab + 不被 Close All 误关」的轻量版，见 openQuestions 决议）。
- `setTabDirty` / `setTabContent` reducer 里，`dirty===true` 时顺带 `isPreview=false`（**编辑即固定**，符合 VS Code）。

**G2 TabBar 交互（`TabBar.tsx`）**
- 单击 tab：保持 `setActiveTab`（已有）。
- 双击 tab：`dispatch(pinTab(id))`（去斜体、固定）。
- 顶栏右侧加 `...` 按钮 + 下拉菜单（**复用 `ContextMenu` 组件**，`src/components/ui/ContextMenu.tsx`），项：
  - Show Opened Editors（菜单内快速跳转列表，列出所有 tab，主人决议取轻量版）。
  - Close All（`Ctrl+K W`）。
  - Close Saved（`Ctrl+K U`）。
  - Enable Preview Editors（勾选态，`togglePreviewEnabled`）。
  - Lock Group（勾选态）。
  - Configure（跳设置 / 占位）。
  - 带 shortcut 文案。

**G3 快捷键（`EditorArea.tsx`）**
- 在 `EditorArea` 注册 `Ctrl+K` 前缀和弦（主人决议：EditorArea 自管 Ctrl+K 和弦，仅作用于编辑器区聚焦时）：`Ctrl+K W`=Close All、`Ctrl+K U`=Close Saved。
- `EditorArea` useEffect 加 window keydown 监听并管理 chord 状态（防与浏览器 / 已有快捷键冲突、防 input 聚焦时误触发）。
- Close All / Saved 走 dirty 确认链（`resolveUnsavedTabs`）。

**G4 CSS（`editor.css`）**
- 补 `.tab-strip` 右侧 `...` 按钮样式、菜单定位；`.tab-item.preview` 斜体已有（301-303）。

---

## ⑤ Stage 拆分（逐个列，完整覆盖全部 8 个 stage）

### M4-3-S1 — 输入框 auto-resize 修复（问题1）
- **做什么**：`AgentPanel` 加 `autoResize`（height auto→`min(scrollHeight,120)`），接 `onChange` + `useLayoutEffect` + 发送后复位；`layout.css` `.agent-input` 加 `overflow-y:auto`。
- **改动文件**：`src/components/layout/AgentPanel.tsx`、`src/styles/layout.css`。
- **验收**：输入多行文本，高度随内容增长到 120px 封顶，超过后输入区内出现纵向滚动条不裁切；发送 / 清空后高度复位为单行。`npm run build` 通过。
- **工作量**：small。

### M4-3-S2 — 思考块上移（问题5a）
- **做什么**：`MessageBubble` 把 thinking-block JSX（449-459）移到 `message-content`（341）之前，折叠逻辑不变。
- **改动文件**：`src/components/chat/MessageBubble.tsx`。
- **验收**：assistant 消息思考块渲染在正文之上；折叠 / 展开、Thought for 计时正常。`npm run build` 通过。
- **工作量**：small。

### M4-3-S3 — 已发消息附件可点开（问题5b，按主人决策新 tab type `'attachment'` + 图片走预览模态）
- **做什么**：`MessageBubble` `message-attachment` 加 `onClick` + `onOpenAttachment` prop；`AgentPanel` 实装 `handleOpenAttachment`（图片→复用 `previewAttachment` 模态；文档 / 其它→sha 解析为 objectUrl 后 `openTab({type:'attachment'})`，失败降级通知）+ objectUrl 生命周期 revoke；新增 `AttachmentTabViewer`（按 mime 渲染 img/iframe/pre/下载提示）；`AgentPanel` 渲染处补传回调。
- **改动文件**：`src/components/chat/MessageBubble.tsx`、`src/components/layout/AgentPanel.tsx`、`src/services/attachmentRefs.ts`、`src/components/layout/EditorArea.tsx`、`src/styles/chat.css`。
- **验收**：已发图片附件点击→预览模态打开；文档附件点击→编辑器区 `'attachment'` tab 按 mime 渲染或明确降级提示；不再是死 div；切关 tab 后无 objectUrl 泄漏。`npm run build` 通过。
- **工作量**：large。

### M4-3-S4 — 删 SettingsPanel 开发自检表 + 措辞中性化（问题8）
- **做什么**：删 `settingAuditRows` / `SettingsAuditMatrix` / `auditStatusClass` / 相关类型 + 10 处调用；safety（1168/1173）/ data（1590）措辞中性化；`settings.css` 删 audit-matrix 样式；宽内容（长路径）加 `.settings-wide-scroll` 横向滚动兜底。
- **改动文件**：`src/components/settings/SettingsPanel.tsx`、`src/styles/settings.css`。
- **验收**：10 个设置 tab 页均无开发自检矩阵；safety/data 无「暂未开放 / 待确认」开发味措辞；控件纵向排布正常；长路径不撑破侧栏（横向滚动）。无 TS 未使用符号报错；`npm run build` 通过。
- **工作量**：medium。

### M4-3-S5 — FileTree 文件夹优先排序（主人决策）
- **做什么**：加 `sortNodes`（目录优先 + 组内 `localeCompare` numeric），应用到 `root.children` 渲染与递归子节点渲染（不原地 mutate）。
- **改动文件**：`src/components/sidebar/FileTree.tsx`。
- **验收**：文件树中文件夹全部排在文件之前，组内按名称自然序（含数字）；展开子目录同规则。`npm run build` 通过。
- **工作量**：small。

### M4-3-S6 — FileTree 彩色图标主题（主人决策）
- **做什么**：内置 material-icon-theme 风格 SVG 子集（`services/fileIcons.ts`，含 ~40 常见扩展 + 默认 + 文件夹 open/closed），`FileTree` `tree-icon` 由 emoji 改用 ext 映射的彩色 SVG，未命中回退默认；`fileTree.css` 调 svg 尺寸对齐。**不引 npm 包**（理由见 ④E）。**只动 FileTree**（主人决策）。
- **改动文件**：`src/components/sidebar/FileTree.tsx`、`src/services/fileIcons.ts`、`src/styles/fileTree.css`。
- **验收**：常见扩展（ts/js/md/py/html/css/png/pdf/docx 等）显示对应彩色图标，文件夹有开合两态图标；未知扩展回退默认文件图标；视觉与 VS Code/WSF 同款风格。`npm run build` 通过。
- **工作量**：medium。

### M4-3-S7 — 预览 tab reducer 语义（`editorTabs` slice）
- **做什么**：`openTab` 支持 `isPreview` 替换（新 preview 复用同一临时 tab 位）；新增 `pinTab` / `togglePreviewEnabled`（`previewEnabled` 默认 `true`）/ `closeSavedTabs` / `lockGroup`（`groupLocked`）；`setTabDirty` / `setTabContent` 在 `dirty===true` 时自动 `isPreview=false`（编辑即固定）。
- **改动文件**：`src/store/slices/editorTabs.ts`。
- **验收**：reducer 行为正确——连续单击不同文件只占一个斜体 preview tab；编辑后该 tab 转固定；`previewEnabled=false` 时新 tab 直接固定。`npm run build` 通过。
- **工作量**：medium。

### M4-3-S8 — TabBar 交互 + `...` 菜单 + 快捷键（主人新增）
- **做什么**：`TabBar` 双击→`pinTab`；顶栏 `...` 按钮（复用 `ContextMenu`）：Show Opened Editors / Close All（`Ctrl+K W`）/ Close Saved（`Ctrl+K U`）/ Enable Preview Editors（勾选）/ Lock Group（勾选）/ Configure；Close All / Saved 走 `resolveUnsavedTabs` 确认；`EditorArea` 注册 `Ctrl+K` 和弦快捷键；`editor.css` 补 `...` 按钮与菜单样式。
- **改动文件**：`src/components/editor/TabBar.tsx`、`src/components/layout/EditorArea.tsx`、`src/styles/editor.css`。
- **验收**：单击文件=斜体临时 tab、双击 / 编辑=固定；`...` 菜单各项可用；`Ctrl+K W` 关全部、`Ctrl+K U` 关已保存均经 dirty 确认；Enable Preview Editors / Lock Group 勾选态生效。`npm run build` 通过。
- **工作量**：large。

---

## ⑥ 风险

1. **附件文档打开（S3）是本里程碑最大不确定点**：附件无工作区 `filePath`，必须经 sha→objectUrl 解析。主人已拍板走「新 tab type `'attachment'` + 专用 `AttachmentTabViewer`」方案，回避了让现有 Pdf/Docx/Office viewer 吃 objectUrl 的兼容性陷阱（那些 viewer 依赖本地 fs 转换，可能报错或白屏）。新 viewer 仍需对各 mime 兜底（不认识的 mime 给「下载 / 系统打开」提示，不要硬塞渲染）。
2. **S3 objectUrl 不 `revoke` 会内存泄漏**：需可靠的 tab 关闭→revoke 生命周期管理（参考 `fileSystem.memoryFileUrls` 模式），漏管易积累。
3. **previewAttachment state 类型不齐**：现为 `AttachmentRef` 形，`MessageBubble` 给的是 `AttachmentInfo` 形，字段可能不完全对齐，图片复用模态时需 adapter 防类型 / 字段缺失。
4. **S4 删自检表涉及删类型与 10 处调用**：若有遗漏引用会导致 TS 编译失败——需**全量 grep** 确认 `settingAuditRows` / `SettingsAuditMatrix` / `auditStatusClass` / `SettingAuditRow` / `SettingAuditStatus` 无残留引用。
5. **S6 内置 SVG 子集需逐个准备图标**：工作量集中在资产收集；若直接用 material-icon-theme 原始 SVG 需注意其许可（MIT，可用但要保留版权声明）。
6. **S7/S8 预览 tab 语义改 `openTab` reducer 会影响所有现有 `openTab` 调用方**（Sidebar / AgentPanel `openDiffTarget` / `openReviewChanges` / `openWorkflowTab`）——替换逻辑要确保 review/workflow 等非文件 tab（`isPreview:false`）不被误当 preview 替换。
7. **S8 `Ctrl+K` 和弦快捷键**：自行 window keydown 管理 chord 状态需防与浏览器 / 已有快捷键冲突、防 input 聚焦时误触发（主人决议 EditorArea 自管，仅编辑器区聚焦生效，可缩小冲突面）。
8. **lockGroup 在单 group 架构下语义模糊**（VS Code 是多 group 概念），实现需简化，过度实现会引入无意义复杂度（主人决议取轻量版）。

---

## ⑦ openQuestions 决议（已采纳主人 / 子代理倾向默认值）

1. **S3 文档附件打开策略二选一**（i 复用 viewer / ii 新增 tab type）
   - **已决：方案 ii** —— 新增 tab type `'attachment'` + 专用 `AttachmentTabViewer` 按 mime 渲染（img/iframe/pre/下载提示）。
   - 依据：主人决策「已发附件打开=新 tab type `'attachment'`，图片走预览模态」。子代理工程建议也是 ii 更稳（不污染现有 viewer，回避 Docx/Pptx/Office 吃不下 objectUrl 的白屏）。

2. **S3 图片附件点开方式**（轻模态 vs 编辑器区 image tab）
   - **已决：图片走 `previewAttachment` 预览模态**（轻、快），不进编辑器区 image tab。
   - 依据：主人决策「图片走预览模态」+ brief 倾向。

3. **S6 文件图标内置 vs npm 引包**
   - **已决：内置 material-icon-theme 风格 SVG 子集**，不引 npm 包；**首批 ~40 常见扩展**，其余回退默认，后续按需补。
   - 依据：主人决策「内置 material-icon-theme 风格 SVG 子集（首批 ~40 常见扩展）」+ 子代理工程建议。

4. **S6 范围**（是否同时统一 TabBar 图标）
   - **已决：本里程碑只动 FileTree**，TabBar 的 lucide + `tab-icon-*` 彩色图标不动。
   - 依据：主人决策「只动 FileTree」+ 子代理建议（降低牵连）。

5. **S7/S8 lockGroup 与 Show Opened Editors 形态**
   - **已决：Lock Group 取轻量版**（锁定 = 禁用 preview 复用 + 不被 Close All 误关）；**Show Opened Editors 做菜单内快速跳转列表**（轻量，不做侧栏式面板）。
   - 依据：子代理建议默认值（单 group 架构下重实现无意义）。

6. **S8 快捷键中枢**（是否已有统一中枢 / 能否 EditorArea 自管）
   - **已决：EditorArea 内自管 `Ctrl+K` 和弦**，仅作用于编辑器区聚焦时。
   - 依据：主人决策「快捷键（EditorArea 自管 Ctrl+K 和弦）」+ 子代理建议。

---

## ⑧ 该里程碑技术决策小结

- **纯前端、零主进程**：8 个 stage 全部限定在 `src/` 渲染层，不动 Electron 主进程 / IPC / DB，每 stage 独立 `npm run build` 验证，回滚成本低。
- **附件打开走「新 tab type `'attachment'` + 专用 viewer」**（而非复用现有 fileSystem viewer）：根因是附件 sha256 内容寻址、无工作区 `filePath`，现有 viewer 全按 `filePath` 走 fileSystem，objectUrl 无法被 Docx/Pptx/Office 等本地转换 viewer 消费。图片单独走 `previewAttachment` 轻模态。objectUrl 需 `Map<tabId,url>` + tab 关闭 revoke 防泄漏。
- **删自检表 = 把开发自检矩阵彻底从终端用户视图移除**：删 `settingAuditRows`/`SettingsAuditMatrix`/`auditStatusClass`/两个类型 + 10 处调用 + `settings.css:284-329` 样式；safety/data 措辞中性化；长路径加 `.settings-wide-scroll` 横向滚动兜底。删后务必全量 grep 确认无残留引用，避免 TS 编译失败。
- **文件图标内置 SVG 子集**（material-icon-theme 风格 ~40 扩展），放 `services/fileIcons.ts`，彩色用 SVG `fill`，未命中回退默认；**只动 FileTree**，不碰 TabBar 的 lucide 图标体系。
- **文件树排序 = 目录优先 + 组内 `localeCompare(numeric)`**，纯函数 `sortNodes`，root 与递归两处应用，不原地 mutate `FileNode`。
- **预览 tab 是「字段壳子已在、行为全缺」**：`isPreview` 字段早有，但 reducer/交互/快捷键全缺。本里程碑补齐 reducer 语义（preview 替换 / pin / previewEnabled / closeSaved / lockGroup / 编辑即固定）+ TabBar 双击与 `...` 菜单 + EditorArea 自管 `Ctrl+K` 和弦。改 `openTab` 时要保护 review/workflow 等非文件 tab 不被当 preview 替换。
- **lockGroup 与 Show Opened Editors 取轻量版**：单 group 架构下不做多 group 重语义，避免无意义复杂度。

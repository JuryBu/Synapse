# Plan_5_M6 — 富文本输入框（contenteditable + 内联 atomic @token + 两级类型菜单）

> 验收诉求（主人）：复刻 Antigravity——@引用做成**输入框内联高亮 atomic token**（`@Writing A Summer Story` 含空格、整体高亮整体删），不要上方独立卡片；@ 菜单**两级**（先选类型再选具体项），类型**完整七类**：Files / Directories / Conversation / Workflow / Settings / MCP / Terminal。
>
> 技术路线（已与主人对齐）：**contenteditable**（非 textarea+overlay）。Electron 单 Chromium 让中文 IME 可控。
>
> 完整蓝图 + 对抗审查原文：workflow `wftu0s156` 输出 →
> `C:\Users\Stardust\AppData\Local\Temp\claude\C--Users-Stardust-Desktop-VC----Synapse\9821e6b3-76e3-431e-b6d4-0c1d88af0308\tasks\wftu0s156.output`

## 核心设计决策

| 维度 | 决策 |
|---|---|
| 编辑器 | contenteditable div，**非受控**（DOM 是唯一真值，React 不回写 innerHTML） |
| 状态同步 | 单向 DOM→React（onInput 抽派生态：是否空/触发检测）；React→DOM 仅命令式插/删 token |
| token | `<span data-token contenteditable=false data-type data-id data-value>`，textContent 赋值（防 XSS） |
| 菜单 | 两级状态机 level: 'type'｜'item'；Esc 二级回退一级 |
| 发送提取 | 遍历 childNodes → `{ plainText, tokens: ExtractedToken[] }`；**消息存盘额外持久化 tokens[]**（编辑回填重建用） |
| 注入 | buildContextFromTokens 按 token 类型分派，conversation 复用现有 buildInjectedContext |

## 七类 provider 取数源

| 类型 | 取数 | token(id/value) | 注入语义 |
|---|---|---|---|
| Files | `fileSystem.getWorkspaceTree()`/`searchInWorkspace`（worktree-aware） | 绝对路径/相对路径 | 无，AI 按需 view_file |
| Directories | 同上 filter dir | 绝对路径/相对路径+`/` | 无，AI 按需 list_dir |
| Conversation | `listConversationSummaries({})`（复用 atConvCache） | conversationId/title | `<referenced_conversation>`（复用 buildInjectedContext） |
| Workflow | `store.multiAI.modes`（复用 getWorkflowItems） | modeName/modeName | `@MultiAI:` 占位 → parseMultiAITrigger |
| Settings | `SETTINGS_INDEX`（复用 getSettingsItems） | sectionId/label | **不插 token**，选中即跳转 |
| MCP | `mcpBridge.listRegistered()` 解析 `mcp__server__tool` | `mcp__server__tool`/toolName | `<mcp_tools_available>`（新增 buildMcpContext） |
| Terminal | **新建 terminalSessionStore 单例** | sessionId/终端名 | `<referenced_terminal>`（新增 buildTerminalContext） |

## 文件改动清单

**新建**：`RichTextInput.tsx`（forwardRef: insertToken/extract/clear/focus/getAtTrigger）、`AtTypeMenu.tsx`（两级菜单）、`richInput/domUtils.ts`、`richInput/atTrigger.ts`、`atProviders.ts`、`terminalSessionStore.ts`、`styles/richInput.css`

**修改**：`AgentPanel.tsx`（textarea→RichTextInput；menu 两级；refreshMenu 用 detectAtTrigger；applyCompletion 拆 applyTypeSelect+applyTokenCompletion；handleKeyDown 加 Esc 回退+退格删 token；**删 refs/agent-ref-tray/removeRef**；handleSend 改 extract+buildContextFromTokens；**refillInputFromUserMessage 改逐 token 重建**）、`atSources.ts`（三函数改 export 复用）、`triggerDetect.ts`（抽 isValidAtContext 共享）、`types.ts`（CompletionGroup/meta 扩展）、`TerminalPanel.tsx`（appendOutput 写 store）、`promptBuilder/systemPrompt`（mcp/terminal 注入段）、消息数据结构（存 tokens[]）

## 对抗审查 — 必修问题（实现时逐条焊死）

**HIGH（会导致真机 bug 或返工）：**
- [ ] P1 IME：compositionend 后先 `normalize()` 再 detectAtTrigger；detectAtTrigger 回溯要跨文本节点
- [ ] P4+P17 编辑回填：消息存盘除 plainText 额外持久化 `tokens[]`；`refillInputFromUserMessage` 用 tokens 逐个 insertToken 重建，**禁止任何 innerHTML 反序列化**
- [ ] P6 占位字符用 **`​` 零宽**（非 ` `），extract 整体 strip；token 在**开头**也要前置占位
- [ ] P7 退格：**两段式**——先删占位空格、第二次才删 token；findAtomicTokenBeforeCaret 严格判定（offset===0 且 previousSibling 是 token）
- [ ] P10 send 可用性改 `extract().plainText.trim() || tokens.length`；确认 extract 的 plainText 让 parseMultiAITrigger/parseAndDispatch 仍命中（workflow token 在最前、/命令 纯文本无 token 才触发）
- [ ] P11 多行粘贴：extract 对块级元素 div/p 进入前补 `\n`；粘贴 `\n` 显式拆 text+`<br>`，不靠 execCommand 默认分行
- [ ] P13 async 二级菜单竞态：requestSeq ref 或 AbortController，stale 结果丢弃
- [ ] P16 粘贴图片：onPaste 先查 clipboardData.files/items 有 image → 走 addPendingFiles，无 image 才取 text/plain（不能 preventDefault 堵死粘图）

**MEDIUM：**
- [ ] P2 compositionend 用 queueMicrotask 延后 + detect 去抖（避免 insertCompositionText 重复跑）
- [ ] P3 composition 期间菜单冻结坐标/隐藏
- [ ] P5 extract/createTokenSpan 对 type 做白名单校验（非法当普通文本）
- [ ] P8 全选删除后 cleanupEmptyNodes（移除空 span/div、合并 br）
- [ ] P9 RichTextInput 用 React.memo + 回调全 useCallback（菜单 state 绝不下传编辑器）
- [ ] P14 不存 Node 引用（normalize 会失效），每次操作前重新 detectAtTrigger 定位 @
- [ ] P15 onMouseDown preventDefault 绑菜单**最外层容器**（含 loading/空态/滚动条）
- [ ] P18 插/删 token 后 rAF 再 autoResize；.rt-token 用 display:inline
- [ ] P19 menu 加 mode: 'at'｜'slash'，Esc/Enter 按 mode 派发；@ 和 / 不同时 open
- [ ] P20 Ctrl+Enter 无条件 preventDefault，置于菜单分支之前最前

## 分阶段（每阶段独立真机验收）

### Phase 1 — 编辑器底座 + 仅 Conversation 单类型
- 新建 RichTextInput（非受控 + onInput 派生空态 + autoResize + paste 纯文本/图片 + IME 守卫 + 两段式退格删 token）
- domUtils（createTokenSpan/insertTokenAtCaret/extractContent/findAtomicTokenBeforeCaret/isEditorEmpty/cleanupEmptyNodes）
- atTrigger（detectAtTrigger Range 版，复用 isValidAtContext）
- AgentPanel：textarea→RichTextInput；menu 暂单层只接 Conversation；删 refs/agent-ref-tray；handleSend 改 extract+buildContextFromTokens（仅 conversation）；refillInputFromUserMessage 改 tokens 重建
- 焊死 P1/P4/P6/P7/P10/P11/P13(单类型暂不涉及async竞态)/P16
- **真机验收**：@ 出对话→选中→内联高亮 atomic 块→中文 IME 正常→退格两段式删块→粘贴富文本只进纯文本→粘贴截图进附件→Ctrl+Enter 发送 AI 收到注入；编辑带引用的历史消息→token 还原；连打/Esc 菜单不错乱

### Phase 2 — 两级菜单 + 全七类
- menu 扩两级；AtTypeMenu（一级类型图标列表 + 二级候选 + loading）
- handleKeyDown selectActive 分层 + Esc 回退
- atProviders 接 Files/Directories(async+searchInWorkspace)、MCP(mcpBridge)、Terminal(新建 store)、Workflow/Settings(复用)
- terminalSessionStore + TerminalPanel 接线
- systemPrompt 加 mcp/terminal 注入段；buildContextFromTokens 全类型分派
- 焊死 P13 竞态 + P15 失焦 + P19 双触发器
- **真机验收**：@ 出七类图标→选 Files 进二级→Esc 回退→各类型 token 生成→Settings 跳转不留 token→Workflow 识别为工作流→MCP/Terminal/Conversation 注入段正确

## 实施状态（2026-06-22）

Phase 1+2 接线**已完成并 commit**（6021089 接线 / 96b520f 对抗审查修复）。底座 5 文件 + atProviders + AtTypeMenu + AgentPanel 全链路改造 + App.tsx CSS。5 lens workflow 对抗审查 → 修 HIGH×2(token 锚点重 detect)+MEDIUM×4(ZWSP双边/粘贴/二级抖动/块级换行)+LOW×2。
playwright dev server 真机验证通过：@→七类菜单 / 选类型→二级回退条+候选 / 内联 atomic token(绿) / 文本+token 中文混排 / 两段式退格删 token 无残留 / 空态 placeholder。双编译通过。

**C6（编辑框统一）已完成**（1068349 抽 useAtMention hook + MessageBubble 接入 / ee3bada AgentPanel 迁 hook 去重，净删 ~193 行）：编辑历史消息的输入框 = 底部同款 RichTextInput + 两级 @ 菜单（Enter 保存 / Shift+Enter 换行 / Esc 取消）。真机验证底部零回归 + 编辑框生效。

## 待复核/小本本

- [ ] **C6-附件（主人验收补充）**：编辑历史消息时编辑框也要支持附件/图片——显示原消息带的图/附件、可增删、保存重发带上。底部已有完整链路（addPendingFiles + pendingAttachments tray + 上传按钮 + refillInputFromUserMessage 的附件还原），MessageBubble 编辑 UI 加附件 tray + onEdit 签名带 attachments + AgentPanel handleEdit 接附件即可。主人定级「小问题」、优先级中。
- [ ] **D1（Phase 1.5）**：Message 加 richTokens?:ExtractedToken[] + agentLoop user 消息透传 + sanitize 保留；refillInputFromUserMessage 改 tokens 逐个 insertToken 重建。当前编辑历史消息回填降级为纯文本（token 显示 @对话:xxx 文本，与旧版 refs 不持久化等价、非回归），D1 做了才能无损还原 atomic 块（P17）。
- [ ] **LOW-2**：workflow token 的 modeName 含空格时 @MultiAI: 占位经 parseMultiAITrigger(^\S+) 解析失败（旧缺陷，Synapse 默认 modes 名无空格不触发）。修：TOKEN_INLINE.workflow 占位用 token id 或 workflow token 直接走 runWorkflowFromInput(token id) 不经文本往返。
- [ ] **联动确认（真机各跑一次）**：① detectAtTrigger 跨节点回看缺失——handleInput(普通打字/粘贴)路径不 normalize，若 @ 跨文本节点边界落前一节点会漏触发（IME 路径靠 compositionend normalize 兜）；② fileSystem.getWorkspaceTree() node.path 绝对/相对口径——若 child 相对 tree 绝对则 toRelative 前缀匹配失败、@文件 value 退化 basename（根因在 fileSystem.ts）。
- [ ] **electron 真机终判**：中文 IME composition（playwright 测不了）/ @文件·@目录·@MCP 真实候选 / @对话发送注入 / @工作流分流 / @设置跳转 / /命令 / 粘贴多行+截图 / Ctrl+Enter 发送。

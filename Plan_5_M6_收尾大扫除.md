# Plan_5_M6_收尾大扫除.md —— M6 富文本输入框收官子计划

> 立项：2026-06-22
> 起因：M6 主体（A/B/C/D 类 + C6 编辑框统一 + C6 附件）已被主人全面验收通过。剩下 4 项小本本一次清空，让 M6 彻底收官。
> 主文档：[Plan_5_M6_富文本输入框.md](Plan_5_M6_富文本输入框.md) —— 主体施工与验收记录在那里。
> 调研产出：workflow `w4c4lhg85`（D1 蓝图）+ workflow `wotfcmtkz`（LOW-2 / 联动①② 调研与方案）。

## 一、范围（4 项）

| 项 | 主题 | verdict | 优先级 |
|---|---|---|---|
| **D1** | richTokens 持久化 + 编辑历史 @高亮块无损还原 | 真 bug，要做（M6 最后一个功能缺口） | 高 |
| **LOW-2** | `@MultiAI:` workflow modeName 含空格被截断 | 真 bug，要做（自定义工作流模板 100% 中招） | 中 |
| **联动①** | `detectAtTrigger` 跨相邻文本节点回看缺失 | 真 bug，要做（场景 #1 退格删 token 后 @ 几乎必现） | 中 |
| **联动②** | `@文件` token value 用相对路径，无 worktree 根承接 | ⚠️ **隐藏的高优 bug**：Electron 模式 + 无活动 worktree 时 AI 调 `view_file` 会读 `process.cwd`（开发模式=synapse-app 项目根，AI 会读到 Synapse 自己的源码） | **高** |

### 联动②为啥升级成高优（调研意外发现）

我以为这只是「绝对/相对路径口径不一致」的纸面缺陷。调研亲读发现：

- `getWorkspaceTree()` 返回的 `node.path` 是**绝对路径**
- 当前 `atProviders` 把它**转成相对路径**再塞进 `token.value`
- 注入给 AI 的提示文本变成 `@src/fileSystem.ts` 这种相对路径
- AI 调 `view_file('src/fileSystem.ts')` → `fileSystem.readFile` 没有 worktree 根可承接 → 落到 `process.cwd`
- **开发模式 `process.cwd` 就是 synapse-app 项目根**——AI 会读到 Synapse 自己的源代码 ❗
- 打包后 `process.cwd` 是 exe 目录 → 报「文件不存在」

调研的修法：token.value 改回绝对路径（菜单/pill 仍显相对，靠新协议 `displayLabel` 解耦）。

## 二、跨项协调：TokenSpec 协议奠基

**关键洞察**：D1 + LOW-2 + 联动② 都需要 `TokenSpec` 协议加 `displayLabel`（显示文本）/ `value`（持久化锚点）二元分离：

| 项 | value（锚点） | displayLabel（显示） |
|---|---|---|
| D1 通用 | 各类型锚点 | 各类型可读文本 |
| LOW-2 workflow | `mode.id`（英文 slug，无空格） | `mode.name`（含空格） |
| 联动② file/dir | 绝对路径 | 相对路径 |

所以**第一步先扩 TokenSpec 协议**（types.ts + domUtils createTokenSpan 用 displayLabel），三项才能并行落地。

## 三、施工顺序（拆 3 个 commit）

```
C1: 联动①（atTrigger 跨节点回看 + removeTokenSpan 补 normalize）
    └─ 完全独立、不碰其它三项，先 commit 止血

C2: TokenSpec 协议奠基 + LOW-2 + 联动②
    └─ Step 1: types.ts 加 displayLabel 字段 + domUtils.createTokenSpan 用 displayLabel
    └─ Step 2 (并行可拆): LOW-2 改 atProviders workflow 分支 + multiAITrigger + WorkflowEditor
                         联动② 改 atProviders file/dir 分支
    └─ 一起测一起 commit（三项强相关）

C3: D1 持久化主体
    └─ conversation.ts/database.ts/ipc/conversation.ts 加 rich_tokens 列
    └─ AgentPanel.handleSend 写 richTokens / agentLoop.run.opts 透传
    └─ MessageBubble 编辑回填 setContent(buildRichParts(content, richTokens))
    └─ 复用 C2 已落地的 displayLabel 协议
```

每个 commit 都能独立通过双编译 + 手测，回滚单元小。

## 四、各项细化

### 4.1 C1 —— 联动① detectAtTrigger 跨节点回看

**真根因**：`detectAtTrigger` 只看 `focusNode.textContent`，但用户「退格删 token」「粘贴」「IME 二次组合」后 @ 字符可能落在与 「@ 前空白/起点」**不同的文本节点**。IME 路径靠 `compositionend` 调 `normalize()` 兜底，普通打字/粘贴路径不 normalize 就裸跑。

**触发场景**：
- 场景 #1（几乎必现）：删 token 后立刻打 `@s` —— 菜单不弹或要先打几个字才弹
- 场景 #2（偶发）：粘贴多行后打 `@`
- 场景 #3（罕见，Android）：IME 二次组合后 `@`

**修法（两层）**：
1. **A 层（5 行止血）**：`domUtils.removeTokenSpan`（src/services/inputCommands/richInput/domUtils.ts:187-197）末尾补 `(token.parentNode as Element | null)?.normalize()`（IME 活跃期间跳过 normalize 避免抢节奏）
2. **B 层（治本）**：`atTrigger.detectAtTrigger`（src/services/inputCommands/richInput/atTrigger.ts:24-46）改跨节点回看版：
   - `MAX_LOOKBACK=64` 字节上限
   - 遇 atomic token（`[data-token]`）/ BR / DIV / P 立即停
   - 任意一节点出现 `\s` 即收手
   - 用 `atIndexInRaw` 反推 `startNode/startOffset` 保证 `range.setStart` 落对位置

**风险**：
- `locateOffset` 反推 startNode/startOffset 错位 → token 插入位置漂或删错文本。必须用 TreeWalker 严格按累积长度定位
- `previousTextNodeWithin` 钻到嵌套 `<span data-token>` 内的子文本节点会越界。判定时只查 `hasAttribute('data-token')` 第一层
- `normalize` IME 活跃期会破坏体验 —— 加 `isComposingRef.current=true` 跳过守卫

**测试**：
- 场景 #1 主路径 + 误触发分支（删 token 后打 `x` 再用方向键到 next 节点起点打 `@` → 不应弹菜单，因前驱是 `x` 非空白）
- 场景 #2/#3 验
- 回归：现有所有 @ 触发（行首、空格后、token 后）不变
- 双编译

### 4.2 C2 —— TokenSpec 协议 + LOW-2 + 联动②

#### Step 1: TokenSpec 协议奠基

- **`src/services/inputCommands/richInput/types.ts:16-22`**：TokenSpec 加 `displayLabel?: string` 字段 + 注释（value=持久化锚点、displayLabel=菜单/pill 显示文本，缺省回落到 value）
- **`src/services/inputCommands/richInput/domUtils.ts:30-42 createTokenSpan`**：`textContent` 改 `'@' + (t.displayLabel ?? t.value)`，dataset 加 `data-label`（dataset.value 不变仍存锚点）

#### Step 2a: LOW-2 workflow 含空格修复

**真根因**：协议层错配——`TOKEN_INLINE.workflow` 用 `@MultiAI:` 前缀 + 紧跟可含空格的用户标识符，但 `parseMultiAITrigger` 用 `^(\S+)` 硬扫描到第一个空白。两端契约对不齐。

**修法（方向 A：token.value 走 mode.id）**：
- **`src/services/inputCommands/atProviders.ts:210-216`**：workflow 分支改专用 helper：
  ```ts
  function withTripleWorkflow(items): CompletionItem[] {
    const modes = (store.getState() as any)?.multiAI?.modes ?? [];
    return items.map(it => {
      const m = modes.find(mm => mm.name === it.label);
      const idForToken = m?.id ?? String(it.label);
      return { ...it, meta: { ...it.meta, type:'workflow', id:idForToken, value:idForToken, displayLabel:it.label } };
    });
  }
  ```
- **`src/services/multiAITrigger.ts:75-86 resolveWorkflowMode`**：匹配优先级反转 id → name（id 命中是主路径，手打语法 name 兜底兼容）
- **`src/components/settings/WorkflowEditor.tsx:127, 131-134`**：`triggerExample` 改用 `mode.id`；提示文案补「推荐用工作流 id（英文）触发，模板名可含空格仅作显示」；模板名 trim

**风险**：
- 旧消息里若有 `@MultiAI:含空格名` plainText（无 token DOM）→ D1 重建找不到对应 token，作历史脏数据处理
- `MultiAIMode.id` 必须无空格 → 检查 `WorkflowEditor` 用户自定义 id 是否允许空格，必要时 id 字段加 trim + 空格转 `-`

#### Step 2b: 联动② @文件 token 改绝对路径

- **`src/services/inputCommands/atProviders.ts:108-120 flattenTree`**：value 改绝对路径（normSlash 归一）：
  ```ts
  const absNorm = normSlash(node.path);
  const value = wantType === 'directory' ? `${absNorm.replace(/\/+$/, '')}/` : absNorm;
  out.push({ id:`at-${wantType}-${node.path}`, label:node.name, description:rel,
    group:GROUP_BY_TYPE[wantType],
    meta:{ type:wantType, id:node.path, value, displayLabel: rel || node.name } });
  ```
- **`src/components/layout/AgentPanel.tsx:972-990 buildContextFromTokens`**：注释更新口径（fileTokens 仍用 `t.value`，t.value 现在是绝对路径，注入提示用绝对路径供 AI 直接调工具）
- **依赖**：`fileSystem.ts:107-117` 已有绝对路径前缀重写（norm.startsWith(baseNorm)），worktree 场景自动正确

**测试**：
- 主路径：Electron + 不 enter_worktree → @ 一个 src/ 真实文件 → AI `view_file` → 应读到该真实文件（开发模式不再混淆为 Synapse 源码）
- worktree：`enter_worktree` 后 @ worktree 内文件 → AI `view_file` 应读 worktree 副本
- 目录：@ 目录 → AI `list_dir` 应列真实内容
- `write_to_file`：让 AI 改 @ 过的文件 → 应写到正确路径（不再覆盖 Synapse 源码）
- 观感：pill 显示 `@src/fileSystem.ts`（相对）不变

### 4.3 C3 —— D1 持久化主体

#### 数据载体

**`src/store/slices/conversation.ts`**：
- 顶部 import `ExtractedToken`
- Message 接口（120-161）在 attachments? 附近加 `richTokens?: ExtractedToken[];`
- editMessage reducer（651-664）payload 加 `richTokens?: ExtractedToken[]`，函数体加 `state.messages[idx].richTokens = action.payload.richTokens && action.payload.richTokens.length>0 ? action.payload.richTokens : undefined;`（同 contentParts/attachments 写法）
- normalizeMessage / addMessage 不动（`...message` 全量保留自动透传）

#### 发送链路

**`src/services/agentLoop.ts:577-587, 621-629`**：
- `run()` opts 加 `richTokens?: ExtractedToken[];`
- 构造入库 userMsg 加 `richTokens: opts?.richTokens,`

**`src/components/layout/AgentPanel.tsx:992-1063 handleSend`**：
- 两条 run 分支都补 `richTokens: tokens.length>0 ? tokens : undefined`

#### 回填重建（关键）

**新建 `src/services/inputCommands/richInput/rebuild.ts`**：
```ts
import { TOKEN_INLINE } from './domUtils';
import type { TokenSpec, ExtractedToken } from './types';

export function buildRichParts(content: string, richTokens?: ExtractedToken[]): Array<string | TokenSpec> {
  if (!richTokens || richTokens.length === 0) return [content];
  let cursor = 0;
  const parts: Array<string | TokenSpec> = [];
  for (const tk of richTokens) {
    const placeholder = TOKEN_INLINE[tk.type](tk.value);
    if (placeholder === '') { parts.push(tk); continue; }
    const idx = content.indexOf(placeholder, cursor);
    if (idx < 0) continue; // 占位串找不到 → 跳过该 token
    if (idx > cursor) parts.push(content.slice(cursor, idx));
    parts.push(tk);
    cursor = idx + placeholder.length;
  }
  if (cursor < content.length) parts.push(content.slice(cursor));
  return parts.length > 0 ? parts : [content];
}
```

**注意**：`TOKEN_INLINE` 要从 `domUtils.ts` `export` 出来（当前是模块私有 const），保证单一真相源——将来改占位语义只改一处。

#### 回填消费

**`src/components/layout/AgentPanel.tsx refillInputFromUserMessage`（1116-1146）**：
- 签名加 `richTokens?: ExtractedToken[]`
- `richRef.current?.setContent([text])` 改 `richRef.current?.setContent(buildRichParts(text, userMsg?.richTokens))`
- **调用方收口**：grep 所有 refillInputFromUserMessage 调用点（回溯 / 分支 / 重试），把整 user 消息（含 richTokens）传进去

**`src/components/chat/MessageBubble.tsx`（222-252）**：
- `MessageProps` 加 `richTokens?: ExtractedToken[]`
- 进入编辑 useEffect（245-252）：`editRichRef.current?.setContent([content])` 改 `editRichRef.current?.setContent(buildRichParts(content, richTokens))`
- 依赖数组不入 richTokens（进编辑那刻快照，与 attachments 同口径）
- `handleSubmitEdit`（222-230）：`const ext = editRichRef.current?.extract(); const newTokens = ext?.tokens ?? [];` 透传给 onEdit
- onEdit 签名扩 `(id, text, attachments?, richTokens?)`

**父组件接线**：渲染 MessageBubble 处把 `msg.richTokens` 透传给 `<MessageBubble richTokens={msg.richTokens} ...>`

#### AgentPanel.handleEdit

签名扩 `(msgId, newContent, attachments?, richTokens?)`，dispatch(editMessage({ ..., richTokens }))。

#### 持久化

**`electron/database.ts:188-199`**：紧跟 `attachments` 之后加 `ensureColumn(db, 'messages', 'rich_tokens', 'TEXT');`（懒迁移、幂等、旧库自动补列、旧行 NULL）。

**`electron/ipc/conversation.ts`**：
- `mapMessage`（114-130）加 `richTokens: fromJson(row.rich_tokens),`
- `message:add`（395-425）：入参类型加 `richTokens?: unknown[];`，INSERT 列加 `rich_tokens`、`?` 占位符加一个、run() 实参加 `toJson(msg.richTokens)`
- `message:replaceConversation`（440-491）：同样三处对齐

⚠️ **占位符与列、值三者数量必须严格一致**（17 列 17 ? → 18 列 18 ?）。漏一个 better-sqlite3 直接抛。

**Web 端**（platform/index.ts:439-451）整对象存取 localStorage，零改动。
**conversationPersistence.ts / sanitizeMessagesForPersistence** `...msg` 全量保留，零改动。

#### 向后兼容

旧消息（DB rich_tokens NULL / Web 无该字段）→ `fromJson(undefined)` 返回 undefined → `buildRichParts(content, undefined)` 首行 `if (!richTokens || richTokens.length===0) return [content];` → 退回 `setContent([content])`——与当前纯文本回填**逐字节等价**，不崩、不算回归。

#### 风险

| 风险 | 防御 |
|---|---|
| INSERT 列/?/值三处数量不齐 | 改时逐处数清，最好同行加 |
| TOKEN_INLINE 重复定义漂移 | export 单一真相源 |
| 占位串歧义（用户手打 `@对话:xxx` 撞到真 token 占位） | 游标 indexOf 顺序唯一不回头，极端边角接受 |
| 编辑提交用旧 richTokens 而非新 extract | handleSubmitEdit 必须 `editRichRef.extract().tokens` |
| refillInputFromUserMessage 调用方收口 | grep 所有调用点逐一对齐 |
| MessageBubble richTokens prop 透传链 | 确认父组件已透传 |
| sanitize 未来改成显式列举字段漏掉 richTokens | 注释提醒 |

#### 测试

- 编译：双编译 build + electron:build
- 真机 1（D1 核心）：发含 @文件+@对话+@工作流 混排消息 → DevTools 查 DB messages.rich_tokens 列有 JSON → 编辑 → atomic 块原样还原（不是纯文本「@对话:xxx」）→ 退格能整块删 → 再发送注入正确
- 真机 2（settings token）：发带 @设置 token 消息（占位空串）→ 编辑 → settings atomic 块仍还原（证明靠 richTokens 而非 content）
- 真机 3（旧消息降级）：D1 之前的旧对话带 `@对话:xxx` 字面文本 → 编辑 → 安静降级为纯文本，不报错
- 真机 4（回溯/分支回填）：对带 token 历史消息回溯/分支 → 底部输入框回填 token 还原
- 真机 5（编辑增删 token 后再发）：编辑删一个 token + 加一个新 token → 落库 richTokens 是最新集合
- 持久化往返：完全关闭重启 app → 编辑该消息 → token 仍能还原

## 五、流程

1. **C1 联动①** → 双编译 → 真机测场景 #1/#2/#3 → commit/push
2. **C2 TokenSpec + LOW-2 + 联动②** → 双编译 → 真机测 LOW-2（含空格 mode 名）+ 联动②（AI view_file 主路径）→ commit/push
3. **C3 D1 持久化** → 双编译 → 真机测 D1 5 个测试点 + 持久化往返 → commit/push
4. **5-lens adversarial review**（workflow，全改动一起审）→ 修问题 → 补 commit
5. **更新 [Plan_5_M6_富文本输入框.md](Plan_5_M6_富文本输入框.md) 小本本**：D1/LOW-2/联动①/联动② 全 ✓

**电脑会受影响的时点**：
- C1/C2 不动持久化/DB，重启 dev server 即可（electron:dev 自动热更新或手动重启）
- C3 加 DB 列 + 改 reducer → 必须重启 electron 真机验
- 5-lens review 期间不动代码

## 六、待复核 / 小本本

- [ ] WorkflowEditor 用户自定义 mode.id 是否允许空格？（LOW-2 风险）→ 实施前 grep 确认
- [ ] MessageBubble 父组件 richTokens prop 透传点是哪个文件？→ 实施前 grep 确认
- [ ] refillInputFromUserMessage 所有调用点清单 → 实施前 grep 出清单
- [ ] 联动② Windows 反斜杠 / Web 模式 demo 路径 token.value 形态 → 实施时手测覆盖

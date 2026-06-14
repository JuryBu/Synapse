<!-- 🔒 STAGE GUARD ACTIVE — 请勿手动移除此标记 -->

# Codex 任务文档：Synapse Plan_3 功能实装修复

> ⚠️ 本文档是你的核心任务指引。请**完整阅读后**再开始修改代码。

---

## 零、强制工作规则（必须遵守）

### 📖 文件阅读要求（强制，非建议）
在动手修改任何代码之前，你**必须**阅读以下文件以充分理解项目背景、设计意图和问题根因。遇到不清楚的地方，**必须回到原文确认**，不得凭猜测修改。

**必读文件（按优先级排序）**:
1. `Plan/Plan_3/Plan_3_功能差距_代码审计.md` — ★ 所有问题的代码级分析，含行号
2. `Plan/Plan_3/Plan_3.md` — Plan_3 总纲
3. `Plan/Plan_3/Plan_3_3_AI对话系统.md` — AI 对话 8 个问题详述
4. `Plan/Plan_3/Plan_3_2_设置系统.md` — 设置系统 4 个问题
5. `Plan/Plan_3/Plan_3_4_终端与编辑器.md` — 终端与文件查看器 3 个问题
6. `Plan/Plan_3/Plan_3_5_知识概要与欢迎页.md` — 知识概要和欢迎页 2 个问题
7. `Plan/Plan_3/Plan_3_1_工作区管理.md` — 文件树操作 2 个问题
8. `Record/record_1.md` — 项目 14 个 Phase 的完整历史记录
9. `Task.md` — 当前任务进度

**扩展参考（需要时查阅）**:
10. `Plan/Plan_1/Plan_1.md` — 原始架构总纲
11. `Plan/Plan_1/Plan_1_前端架构.md` — 前端设计规范
12. `Plan/Plan_1/Plan_1_AI交互层.md` — AI 交互层原始设计
13. `Plan/Plan_1/Plan_1_设置系统.md` — 设置系统原始设计意图
14. `Plan/Plan_1/Plan_1_后端架构.md` — 后端 IPC 架构
15. `Plan/Plan_2/Plan_2.md` — Plan_2 审计总纲
16. `Plan/Plan_2/Plan_2_功能差距.md` — Plan_2 功能差距分析
17. `Plan/Plan_2/Plan_2_代码审计.md` — Plan_2 代码审计结论
18. `Report/` 目录下的全部 8 个报告文件 — 详细的组件级技术调研

> **Plan 冲突规则**：当 Plan_1、Plan_2、Plan_3 中出现冲突内容时，**以编号靠后的 Plan 为准**（Plan_3 > Plan_2 > Plan_1）。

### 📸 用户问题截图（必看）
用户实测截图已放在 `docs/screenshots/` 目录下（共 20 张），命名为 `issue_screenshot_1.png` 到 `issue_screenshot_20.png`。
这些截图展示了用户遇到的真实问题：输入框无法选中、设置不生效、终端不可用、模型选择器无响应等。请在修复前查看对应截图理解问题原貌。

### 📝 双文件输出要求（强制）
你必须持续维护**两份文件**，而非最后一次性写入：

1. **`Record/Record_codex_1.md`** — 工作过程记录
   - 每完成一个修复项就立即追加记录
   - 格式：`## P0-1: 输入框修复` → 修改了什么文件、什么行、为什么这样改
   - 遇到意外问题也要记录
   - **不能等到最后统一写**，防止中途中断导致记录丢失

2. **`docs/报告_Plan3_Codex_Review.md`** — 最终修复报告
   - 同样实时更新，每完成一批修复就更新一次
   - 包含：修复清单、编译验证结果、未修复项及原因

### 🧪 自主测试要求（强制）
- 每完成一批修复后必须运行 `npx tsc -b` 和 `npm run build` 验证编译
- 可以启动 `npm run dev` 并使用浏览器子代理查看实际 UI 效果
- **不得仅凭代码逻辑判断修复成功，必须通过构建验证**

### 🎨 设计意图保护（强制）
- 不得扭曲或简化现有 UI 设计
- 不得删除现有功能（即使当前是占位的）
- 修复原则是"让已有 UI 真正工作"，而非"重新设计 UI"
- 强调色、布局、动画等视觉设计不得随意更改

### 🤖 子代理能力
你可以使用自己的子代理来并行处理任务。

---

## 一、项目背景

### 什么是 Synapse
Synapse 是一个 **AI 驱动的交互式学习平台**，基于 Electron + Vite + React + TypeScript + Redux Toolkit 构建。它参考了 VS Code / Cursor 的布局理念，提供文件管理、代码编辑、AI 对话、终端、知识概要等功能面板。

### 项目目录结构
```
c:\Users\Stardust\Desktop\VC工具包\Synapse\
├── synapse-app/                    ← 核心源码
│   ├── electron/                   ← Electron 主进程
│   │   ├── main.ts                 ← 主进程入口
│   │   ├── preload.ts              ← IPC 桥接
│   │   ├── database.ts             ← SQLite (better-sqlite3)
│   │   ├── ipc/                    ← IPC Handler 模块
│   │   │   ├── config.ts           ← 配置持久化
│   │   │   ├── conversation.ts     ← 对话持久化
│   │   │   ├── workspace.ts        ← 工作区操作
│   │   │   ├── file.ts             ← 文件读写
│   │   │   ├── command.ts          ← 命令执行
│   │   │   └── mcp.ts              ← MCP 协议
│   │   └── mcp/
│   │       └── MCPServerProcess.ts ← MCP JSON-RPC 通信
│   ├── src/                        ← 渲染进程 (React)
│   │   ├── App.tsx                 ← 主应用
│   │   ├── store/                  ← Redux Store
│   │   │   ├── index.ts            ← Store 配置
│   │   │   └── slices/             ← Redux Slices
│   │   │       ├── conversation.ts
│   │   │       ├── agentSettings.ts
│   │   │       ├── notifications.ts
│   │   │       ├── conversationHistory.ts
│   │   │       └── ...
│   │   ├── services/               ← 业务服务
│   │   │   ├── agentLoop.ts        ← AI Agent 循环
│   │   │   ├── aiClient.ts         ← OpenAI API 客户端
│   │   │   ├── fileSystem.ts       ← 文件系统服务 ★关键
│   │   │   ├── toolRegistry.ts     ← 工具注册
│   │   │   ├── systemPrompt.ts     ← 系统提示构建
│   │   │   ├── synopsisEngine.ts   ← 知识概要引擎
│   │   │   └── extensionManager.ts ← 插件管理
│   │   ├── components/             ← 组件
│   │   │   ├── layout/
│   │   │   │   ├── AgentPanel.tsx   ← AI 对话面板 ★关键 (464L)
│   │   │   │   ├── Sidebar.tsx      ← 侧边栏
│   │   │   │   └── StatusBar.tsx    ← 状态栏 (72L)
│   │   │   ├── chat/
│   │   │   │   ├── MessageBubble.tsx ← 消息气泡 (304L)
│   │   │   │   └── ToolCallCard.tsx
│   │   │   ├── editor/
│   │   │   │   ├── WelcomePage.tsx   ← 欢迎页 (157L)
│   │   │   │   ├── CodeEditor.tsx
│   │   │   │   ├── PdfViewer.tsx
│   │   │   │   └── DocxViewer.tsx
│   │   │   ├── settings/
│   │   │   │   └── SettingsPanel.tsx ← 设置面板 ★关键
│   │   │   ├── terminal/
│   │   │   │   └── TerminalPanel.tsx ← 终端 (166L)
│   │   │   ├── sidebar/
│   │   │   │   ├── FileTree.tsx      ← 文件树 (300L)
│   │   │   │   └── SynopsisPanel.tsx ← 知识概要
│   │   │   └── ui/
│   │   │       └── ContextMenu.tsx
│   │   ├── platform/
│   │   │   └── index.ts             ← isElectron 判断
│   │   └── styles/
│   │       ├── index.css             ← 主样式
│   │       ├── wizard.css
│   │       └── editor.css
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
├── Plan/Plan_3/                     ← 本次修复参考
│   ├── Plan_3.md                    ← 总纲
│   ├── Plan_3_功能差距_代码审计.md    ← ★核心参考文件
│   ├── Plan_3_1_工作区管理.md
│   ├── Plan_3_2_设置系统.md
│   ├── Plan_3_3_AI对话系统.md
│   ├── Plan_3_4_终端与编辑器.md
│   └── Plan_3_5_知识概要与欢迎页.md
├── Task.md                          ← 任务进度
└── Record/record_1.md               ← 项目历史记录
```

### 技术栈
- **前端**: React 18 + TypeScript + Redux Toolkit + Vite
- **后端**: Electron 29 + better-sqlite3 + node-pty (未完成)
- **AI**: OpenAI API (streaming chat completions) + tool calling
- **渲染**: react-markdown + remark-gfm + remark-math + rehype-katex + mermaid
- **IPC**: Electron contextBridge + ipcMain/ipcRenderer

---

## 二、当前项目状态

### 构建状态
- `npx tsc -b` → **0 errors** ✅
- `npm run build` → **通过** ✅
- `npm run dev` → Web 模式 dev server 可启动 ✅

### 核心问题总结
经过用户实际测试和代码审计，发现**大量 UI 组件虽然渲染正确但功能未真实实装**。具体有 **15 个问题**分为 P0/P1/P2 三级。

---

## 三、修复任务清单（按优先级排序）

### 🔴 P0 — 阻塞使用（必须修复）

#### P0-1：输入框被 disabled 导致无法输入
**文件**: `src/components/layout/AgentPanel.tsx`
**行号**: L419
**现状代码**:
```tsx
<textarea
  className="agent-input"
  placeholder={hasApiKey ? "输入消息... (Ctrl+Enter 发送)" : "请先配置 API Key..."}
  rows={1}
  value={input}
  onChange={e => setInput(e.target.value)}
  onKeyDown={handleKeyDown}
  disabled={!hasApiKey}  // ← 这行导致未配置 Key 时完全不能输入
/>
```
**修复方案**: 
- 移除 `disabled={!hasApiKey}`
- 改为在 `handleSend` 中检查 hasApiKey，不满足时弹 notification 提示去设置
- 发送按钮保持 `disabled={!input.trim() || !hasApiKey}` 即可

#### P0-2：AI 对话通信链路验证与修通
**涉及文件**: 
- `src/components/layout/AgentPanel.tsx` L44-73（AgentLoop 初始化）
- `src/services/agentLoop.ts`（AI 循环核心）
- `src/services/aiClient.ts`（API 客户端）
- `src/store/slices/agentSettings.ts`
- `src/components/settings/SettingsPanel.tsx`（API Key 保存）

**现状**: 
- 设置面板中 API Key 保存到 Redux → localStorage
- `AgentPanel` L47 检查 `aiClient` 是否存在来决定是否创建 AgentLoop
- `aiClient` 来自 `useAppSelector` → 但**需要验证 store 里 aiClient 是否真正被初始化**
- 如果 aiClient 为 null → agentLoopRef.current = null → handleSend 弹 "未配置 API" → 永远无法对话

**修复方案**:
1. 追踪 `aiClient` 的创建链路：agentSettings slice → 是否在 Key 变更后自动创建 AIClient 实例
2. 如果 aiClient 在 Redux 中是通过中间件创建的，确保 SettingsPanel 保存 Key 后触发 AIClient 初始化
3. 如果是组件内创建，确保 useEffect 自动响应 apiKey 变更
4. 验证 streaming 请求能否正常发出和接收

#### P0-3：文件查看器无法加载文件
**文件**: `src/services/fileSystem.ts`
**现状**: 
- L30-70: `DEMO_FILE_TREE` 硬编码虚拟路径 `/workspace/xxx`
- L164-172 `readFile()`: 只从 `memoryFiles` Map 或 `DEMO_FILES` 读取
- 双击文件树中的文件后，编辑器显示"无法加载文件"
- **根因**: 文件路径都是 `/workspace/README.md` 这种虚拟路径，非真实磁盘路径

**修复方案**:
1. Web 模式下：当用户通过 WelcomePage 导入真实文件（File API）时，将其内容存入 `memoryFiles`，确保 readFile 能读到
2. 确保 fileSystem 的 `uploadFile()` 方法（L283-308）正确工作
3. CodeEditor 打开文件时调用 `fileSystem.readFile()` 并处理错误

---

### 🔴 P1 — 核心功能缺失

#### P1-1：设置通用界面不生效
**文件**: `src/components/settings/SettingsPanel.tsx` + `src/styles/index.css`

**需要实装**:
1. **字号**: Redux 值变化 → 注入 CSS 变量 `document.documentElement.style.setProperty('--app-font-size', value + 'px')`
2. **主题**: 深色/浅色 → 切换 `document.body.dataset.theme = 'light' | 'dark'` + 对应的 CSS 变量集
3. **强调色**: 选色后 → 更新 `--syn-accent` / `--syn-primary` 等 CSS 变量（当前大量组件硬编码紫色 `#a78bfa` 等，需全部改为 `var(--syn-accent)`）
4. **语言**: 可以暂不实装 i18n，但切换后至少应有 notification 提示"即将支持"

**CSS 变量注入位置**: 在 `App.tsx` 或 `SettingsPanel` 中添加 useEffect，监听 settings 变化并实时更新 `document.documentElement.style`

#### P1-2：壁纸功能实装
**文件**: `src/styles/index.css` + `src/App.tsx` + `SettingsPanel.tsx`

**需要实装**:
1. 在 `App.tsx` 最外层添加一个 `div.app-wallpaper` 背景层
2. 读取 settings.wallpaper 配置 → 设置 `background-image: url(...)`
3. 磨砂度 → 面板容器添加 `backdrop-filter: blur(Xpx)`
4. 面板透明度 → 面板背景设为 `rgba(var(--syn-bg-rgb), alpha)`
5. 图片存储：Web 模式用 `URL.createObjectURL()` 或 base64

#### P1-3：模型选择器实装
**文件**: `src/components/layout/AgentPanel.tsx` L447-457

**现状**: `<span className="model-label clickable">` 有 `cursor:pointer` 但无 `onClick`

**修复方案**:
1. 点击模型标签 → 展开一个浮动下拉列表组件
2. 下拉列表显示从 Redux 中的 `availableModels`（由 SettingsPanel 的"获取模型"按钮填充）
3. 选择模型后 dispatch 更新 `conversation.model`
4. 如果模型列表为空，显示"请在设置中获取模型列表"

#### P1-4：Token 计数真实化
**文件**: `src/components/layout/StatusBar.tsx` + `src/services/agentLoop.ts`

**现状**: StatusBar L24-26 使用 `estimateTokens()` 粗估

**修复方案**:
1. `agentLoop.ts` 的 streaming 完成回调中解析 API response 的 `usage` 字段
2. dispatch 一个 action 更新 Redux 中的 `tokenCount`
3. StatusBar 从 Redux 读取真实值

#### P1-5：连接状态真实化
**文件**: `src/components/layout/StatusBar.tsx` L66

**现状**: 硬编码 `<Wifi style={{ color: 'var(--syn-success)' }} /> 已连接`

**修复方案**:
1. 检查 `settings.apiKeys?.openai` 是否存在
2. 如有 Key，可选：在 mount 时做一次轻量 API 调用（如 list models）验证连通性
3. 根据结果显示 `已连接` / `未配置` / `连接失败`
4. 最简方案：有 Key 显示"已配置"（绿），无 Key 显示"未配置"（灰）

#### P1-6：终端 Web 模式修复
**文件**: `src/components/terminal/TerminalPanel.tsx`

**现状**: 终端代码实际上有基本命令模拟（L56-93: help/clear/ls/echo/date 等），但用户报告"无法输入"

**可能原因**:
- CSS 层叠问题：终端输入区域可能被其他面板遮挡
- `form.onSubmit` 可能未正确触发
- `autoFocus` 在面板切换时可能失效

**修复方案**:
1. 检查终端区域的 CSS `z-index` 和 `pointer-events`
2. 确保输入框 `input` 元素可以获取焦点
3. 在终端面板激活时调用 `inputRef.current?.focus()`

---

### 🟡 P2 — 功能不完整

#### P2-1：设置 Tab 栏窄屏截断
**文件**: `src/components/settings/SettingsPanel.tsx` 的 Tab 容器 CSS

**修复方案**: 
- Tab 容器添加 `overflow-x: auto; scrollbar-width: thin;`
- 或实现左右箭头按钮

#### P2-2：Fast/Plan 模式行为差异
**文件**: `src/services/systemPrompt.ts` + `src/services/agentLoop.ts`

**修复方案**:
- Fast 模式：systemPrompt 精简为"直接回答，不要使用工具除非必要"
- Plan 模式：systemPrompt 加入"先给出思考步骤和计划，再逐步执行"
- 可选：Fast 模式禁用部分工具

#### P2-3：欢迎页卡片功能完善
**文件**: `src/components/editor/WelcomePage.tsx`

**现状**:
- L98 `打开工作区` → `handleOpenWorkspace('default')` 传硬编码 → 应改为弹出文件选择 dialog（Web 模式用 `input[type="file"]` + `webkitdirectory`）
- L101 `AI 助手` → 无 onClick → 应当 focus 到 AgentPanel 的输入框

#### P2-4：知识概要真实化
**文件**: `src/components/sidebar/SynopsisPanel.tsx`

**修复方案**:
- 从实际 fileSystem 中的课件文件动态生成列表
- "已完成"/"待处理"状态要反映真实处理情况
- "生成"按钮可以暂时标注"功能开发中"但不能显示虚假完成状态

#### P2-5：设置各 Tab 硬编码占位清理
**文件**: `src/components/settings/SettingsPanel.tsx`

对于当前无后端支持的 Tab（安全、Synopsis、MultiAI、插件 等），应：
- 将开关/toggle 的值正确持久化到 Redux/localStorage
- 无法实装的功能标注"即将推出"而非假装可用
- 保留 AI 设置中测试连接/获取模型的真实功能

#### P2-6：Git 分支硬编码
**文件**: `src/components/layout/StatusBar.tsx` L55

**现状**: 硬编码 `main`
**修复**: 简单方案 — 移除整个 Git 分支显示；或者改为显示运行模式（Web/Electron）

---

## 四、修复注意事项

### 代码规范
1. TypeScript 严格类型，尽量减少 `any`
2. React 函数组件 + Hooks
3. Redux Toolkit 的 slice 模式
4. CSS 变量统一使用 `--syn-` 前缀

### 样式变量（当前已定义，在 index.css 中）
```css
--syn-accent: #a78bfa;      /* 紫色 — 需要被强调色设置覆盖 */
--syn-primary: #7c3aed;
--syn-primary-light: #a78bfa;
--syn-bg-primary: #0a0a0f;
--syn-bg-secondary: #12121a;
--syn-text-primary: #e5e5e5;
--syn-text-muted: #6b7280;
--syn-success: #10b981;
--syn-error: #ef4444;
--syn-warning: #f59e0b;
```

### 关键 Redux Slices 结构
- `conversation`: messages[], model, isStreaming, streamingContent, tokenCount
- `agentSettings`: mode ('fast'|'planning'), apiKeys, apiEndpoints, safety, temperature, maxTokens, availableModels
- `notifications`: 通知队列
- `conversationHistory`: 对话历史列表

### 不要修改的文件
- `electron/main.ts` — 已经过多轮修复，改动需谨慎
- `electron/database.ts` — 数据库 Schema 已稳定
- `electron/mcp/MCPServerProcess.ts` — MCP 通信核心
- `vite.config.ts` / `tsconfig.json` — 构建配置

---

## 五、验证方法

### 自动验证
```bash
cd c:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app
npx tsc -b                    # TypeScript 编译，必须 0 errors
npm run build                 # 生产构建必须通过
```

### 手动验证（Web 模式）
```bash
cd c:\Users\Stardust\Desktop\VC工具包\Synapse\synapse-app
npm run dev                   # 启动 dev server
# 然后在浏览器中打开 http://localhost:5173
```

#### 验证清单
1. **输入框**: 未配置 API Key 时，输入框应可选中、可输入，但发送按钮灰色并提示配置 Key
2. **设置-字号**: 调整字号滑块后，全局文字大小应立即变化
3. **设置-强调色**: 选择不同颜色后，所有紫色元素（按钮、滑块、图标）应跟随变化
4. **终端**: 底部终端输入框应可选中并输入命令，输入 `help` 应显示帮助信息
5. **状态栏**: 未配 Key 时显示"未配置"（灰色），配了 Key 显示"已配置"（绿色）
6. **设置 Tab**: 窄屏下 Tab 栏应可横向滚动
7. **模型选择器**: 底部模型标签可点击展开下拉列表（即使列表为空也应展开）
8. **欢迎页**: "AI 助手"卡片点击后应 focus 到对话输入框

---

## 六、文件阅读清单（已在第零节强制要求）

详见第零节的文件阅读要求。此处汇总全部可用文件：

### 必读（修复前必须阅读）

| 文件路径 | 内容说明 | 优先级 |
|----------|----------|--------|
| `Plan/Plan_3/Plan_3_功能差距_代码审计.md` | 15 个问题的代码行号级分析 | ★★★ |
| `Plan/Plan_3/Plan_3.md` | Plan_3 总纲：12 个 Stage 规划 | ★★★ |
| `Plan/Plan_3/Plan_3_3_AI对话系统.md` | AI 对话系统 8 个子问题 | ★★★ |
| `Plan/Plan_3/Plan_3_2_设置系统.md` | 设置系统 4 个子问题 | ★★ |
| `Plan/Plan_3/Plan_3_4_终端与编辑器.md` | 终端+编辑器 3 个问题 | ★★ |
| `Plan/Plan_3/Plan_3_5_知识概要与欢迎页.md` | Synopsis+欢迎页 2 个问题 | ★★ |
| `Plan/Plan_3/Plan_3_1_工作区管理.md` | 文件树+工作区 2 个问题 | ★★ |
| `Record/record_1.md` | 项目 14 Phase 完整历程 | ★★ |
| `Task.md` | 任务进度追踪 | ★ |

### 扩展参考（遇到不确定时查阅）

| 文件路径 | 内容说明 |
|----------|----------|
| `Plan/Plan_1/Plan_1.md` | 原始架构总纲 |
| `Plan/Plan_1/Plan_1_前端架构.md` | 前端设计规范·组件层次 |
| `Plan/Plan_1/Plan_1_AI交互层.md` | AI Agent 循环·工具调用·系统提示 |
| `Plan/Plan_1/Plan_1_设置系统.md` | 设置系统完整设计意图·各 Tab 功能定义 |
| `Plan/Plan_1/Plan_1_后端架构.md` | Electron IPC·数据库·preload 桥接 |
| `Plan/Plan_1/Plan_1_Synopsis引擎.md` | 知识概要 RAG 管线设计 |
| `Plan/Plan_1/Plan_1_MultiAI系统.md` | 多 AI 协作系统（未实装） |
| `Plan/Plan_1/Plan_1_可扩展系统.md` | 插件·MCP·SKILL·WORKFLOW 架构 |
| `Plan/Plan_1/Plan_1_展示模式.md` | 展示模式设计 |
| `Plan/Plan_1/Plan_1_测试策略.md` | 测试方案 |
| `Plan/Plan_1/Plan_1_增补.md` | 补充说明 |
| `Plan/Plan_2/Plan_2.md` | Plan_2 审计总纲 |
| `Plan/Plan_2/Plan_2_功能差距.md` | Plan_2 功能差距分析 |
| `Plan/Plan_2/Plan_2_代码审计.md` | Plan_2 代码审计（P0/P1/P2 建议） |
| `Report/Report_1_整体架构与技术栈.md` | 技术栈调研 |
| `Report/Report_1_布局系统与Webview架构.md` | 布局系统 |
| `Report/Report_2_工具注册与插件系统.md` | 工具注册 |
| `Report/Report_3_代码执行与沙箱环境.md` | 沙箱环境 |
| `Report/Report_4_AI对话界面与Agent架构.md` | Agent 架构调研 |
| `Report/Report_深度1_MCP系统实现细节.md` | MCP 技术细节 |
| `Report/Report_深度2_SKILL_WORKFLOW_RULES系统.md` | 扩展系统 |
| `Report/Report_深度3_工具Schema与系统提示构建.md` | 工具 Schema |

### 用户截图（必看）

`docs/screenshots/` 目录下 20 张截图，展示了用户遇到的真实问题界面。

---

## 七、输出要求（强制双文件 + 实时更新）

### 输出文件 1：`Record/Record_codex_1.md`（工作过程记录）
- **格式**: 按修复项分节，`## P0-1: xxx` `## P1-2: xxx`
- **内容**: 修改了哪些文件、哪些行、为什么这样改、遇到什么问题
- **节奏**: 每完成一个修复项就立即追加，不等到最后
- **意外记录**: 如发现文档未提及的额外 Bug 也要记录

### 输出文件 2：`docs/报告_Plan3_Codex_Review.md`（修复报告）
- **内容**: 
  - 修复清单表格（问题ID | 文件 | 修改摘要 | 状态）
  - TypeScript 编译验证结果（`npx tsc -b`）
  - 生产构建验证结果（`npm run build`）
  - 未修复项目及原因
  - 建议后续改进

### 通用要求
- 代码格式保持与现有风格一致
- 不要引入新 npm 依赖（除非绝对必要且说明理由）
- 不得删除现有功能或扭曲 UI 设计意图

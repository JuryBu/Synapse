# Report 4: AI 对话界面、Agent 架构与上下文注入

> Experiment 4 核心报告 — Cascade 面板实现、Agent 执行循环、上下文注入机制。

---

## 1. Cascade 面板架构

### 面板实现方式

Cascade（内部代号 **JetskiAgent**）不是普通的 VSCode Sidebar Panel，而是一个**独立的 Electron BrowserWindow**。

```
主窗口 (Workbench Window)
  └── 通过 IPC/MessagePort 通信

Agent 窗口 (JetskiAgent Window) 
  ├── HTML: workbench-jetski-agent.html
  ├── 引导: jetskiAgent.js → jetskiAgent/main.js (11.2MB)
  ├── CSS: tw-base.tailwind.css + jetskiMain.tailwind.css
  └── 面板挂载点: cascade-panel.html → <div id="react-app">
```

### 技术栈

- **渲染框架**: Preact (@preact/compat) — React API 兼容，体积更小
- **状态管理**: Redux Toolkit + react-redux
- **输入框**: Lexical + lexical-beautiful-mentions（@提及系统）
- **Markdown**: react-markdown + remark-gfm + rehype-raw/sanitize + highlight.js + KaTeX + Mermaid
- **样式**: TailwindCSS 4.x + classnames
- **图标**: lucide-react
- **通信**: ConnectRPC + @bufbuild/protobuf（与 LS 通信）
- **浮动UI**: @floating-ui/dom（Tooltip、下拉菜单等）

---

## 2. Redux Store 结构（32 个 Slices）

JetskiAgent 的全局状态由 **32 个 Redux Slices** 管理：

### 核心对话
| Slice | 功能 | 关键 Action |
|---|---|---|
| `conversation` | 对话核心状态 | `setCascadeId` — 设置当前对话 ID |
| `messageHistory` | 消息历史记录 | — |
| `pendingConvo` | 待处理的对话 | — |
| `convoPicker` | 对话选择器 | `setOpen` |

### Agent 控制
| Slice | 功能 |
|---|---|
| `agentScript` | Agent 脚本/执行状态 |
| `agentTab` | Agent 标签页管理 |
| `submittedCommandLines` | 已提交的命令行 |

### UI 布局
| Slice | 功能 |
|---|---|
| `layout` | 布局状态（auxSideBarOpen 等）|
| `sideBar` | 侧边栏 |
| `auxContentArea` | 辅助内容区 |
| `sectionDisplay` | 段落显示控制 |
| `findInPane` | 面板内搜索 |
| `modal` | 模态对话框 |
| `readOnlyTrajectoryModal` | 只读轨迹视窗 |

### 模型与设置
| Slice | 功能 |
|---|---|
| `modelSelector` | 模型选择器（isModelSelectorOpen） |
| `settingsScreen` | 设置界面 |
| `customizationTab` | 自定义选项卡 |
| `debugMode` | 调试模式 |
| `dev` | 开发者模式 |
| `devRerenderEffects` | 开发重渲染效果 |

### 文件与工作区
| Slice | 功能 |
|---|---|
| `filePicker` | 文件选择器（@file 提及） |
| `fileComments` | 文件注释 |
| `fileUserInteraction` | 文件用户交互 |
| `watchedFiles` | 文件监视 |
| `workspaceSelector` | 工作区选择器 |

### 其他
| Slice | 功能 |
|---|---|
| `knowledge` | 知识系统 |
| `terminal` | 终端 |
| `liveTerminals` | 活动终端 |
| `playground` | Playground |
| `networkConnection` | 网络连接 |
| `lastSidebarFocusedConversation` | 上次侧边栏焦点对话 |

---

## 3. Agent 模式与执行循环

### Planning Mode vs Fast Mode

通过 Redux action 切换：
```javascript
// setPlanningMode action
dispatch({ type: "setPlanningMode", mode: "planning" | "fast" })
```

在 `AgentMode`（15处引用）中管理：
- **Planning Mode**: Agent 先规划再执行，多步推理
- **Fast Mode**: 直接执行，快速响应

### Agent 执行循环（executorLoop）

```
用户输入 → [系统提示组装] → [模型调用] → [解析响应]
                                              ↓
                            ┌─── 纯文本 → 渲染消息 → 结束
                            │
                            └─── 工具调用 → [执行工具] → [返回结果] → 继续循环
                                              ↓
                                    ┌─── file_edit → DiffView
                                    ├─── run_command → Terminal
                                    ├─── view_file → 文件内容
                                    └─── browser_subagent → 浏览器
```

关键实现：
- `executorLoop`（4处引用）— 循环执行 Agent 步骤
- `agentStep`（3处引用）— 单步执行
- `conversationId`（39处引用）— 对话标识
- `streaming`（28处引用）— 流式传输
- `ToolCall`（2处引用）— 工具调用判断

### 模型特性检测

```javascript
// 模型能力检查
X.modelFeatures?.supportsToolCalls   // 是否支持工具调用
X.modelFeatures?.supportsThinking    // 是否支持思考过程
```

---

## 4. 上下文注入机制

### 自动注入的上下文类型

从 extension.js 分析，以下上下文信息会被自动注入到 AI 请求中：

| 上下文类型 | 引用次数 | 说明 |
|---|---|---|
| `selectionRange` | 12x | 用户当前选中的代码范围 |
| `diagnostics` | 37x | 编辑器诊断信息（错误、警告） |
| `WorkspaceEdit` | 19x | 工作区编辑操作 |
| `visibleRanges` | 1x | 当前可见的代码范围 |
| `workspaceFolders` | 10x | 工作区文件夹列表 |

### EPHEMERAL 消息

`CacheControlType.EPHEMERAL = 1` — 这是系统注入的临时消息，用户不可见：
- 活动文件信息
- 光标位置
- 打开的文件列表
- 工作区结构
- 系统提示片段

### @提及系统

通过 Lexical 的 `lexical-beautiful-mentions` 插件实现：
- `@file` — 文件提及
- `@folder` — 文件夹提及
- `@conversation` — 对话引用
- 其他自定义 mention 类型

`filePicker` Redux slice 管理文件选择器的状态。

---

## 5. MCP 配置 Schema

```json
{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
        "mcpServers": {
            "type": "object",
            "additionalProperties": {
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "args": { "type": "array", "items": { "type": "string" } },
                    "env": { "type": "object", "additionalProperties": { "type": "string" } },
                    "serverUrl": { "type": "string" },
                    "disabled": { "type": "boolean" },
                    "disabledTools": { "type": "array", "items": { "type": "string" } },
                    "headers": { "type": "object", "additionalProperties": { "type": "string" } }
                }
            }
        }
    }
}
```

MCP 服务器支持两种模式：
- **stdio 模式**: `command` + `args` + `env`
- **HTTP SSE 模式**: `serverUrl` + `headers`

---

## 6. 工作区模型

### 工作区初始化

```javascript
// 工作区文件夹管理
get workspaceFolders() { return this.folders }
initialize(config) {
    this.folders = config.workspaceFolders ?? [];
}
```

### 对话初始化流程

```
用户打开 Cascade面板
  → InitializeCascadePanelStateRequest (proto)
  → 加载对话历史 (ConversationHistory)
  → 设置当前 cascadeId
  → 注入工作区上下文
  → 准备 Agent 服务 (AgentServiceContextProvider)
```

---

## 7. Synapse 对话系统设计建议

### 推荐架构

```
Synapse Agent 系统
├── 对话 UI (Preact + Redux)
│    ├── MessageList — 消息渲染 (react-markdown 管线)
│    ├── InputBox — Lexical 富文本输入 (支持 @提及)
│    ├── ModelSelector — 模型选择器 (API 动态获取)
│    └── ModeSwitch — Planning / Fast 模式切换
│
├── Agent 控制层
│    ├── executorLoop — 工具调用循环
│    ├── contextAssembler — 上下文组装器
│    │    ├── 课件索引概要 (RAG 结果)
│    │    ├── 当前活动文件
│    │    ├── 用户选区
│    │    └── 工作区结构
│    └── toolExecutor — 工具执行器
│
├── AI 通信层 (直接 API/KEY)
│    ├── 流式响应处理
│    ├── 多模态输入支持
│    └── 模型能力检测
│
└── 持久化
     ├── 对话历史存储
     ├── 工作区配置
     └── 模型/API 配置
```

### 关键差异点

| 原 IDE | Synapse |
|---|---|
| 通过 LS (ConnectRPC) 通信 | 直接调用 API/KEY |
| LS 管理上下文注入 | 自行组装上下文 |
| 代码工作区 | 课程工作区 (课件索引) |
| 代码编辑工具 | 知识展示/渲染工具 |

### 复杂度评估

| 功能 | 难度 | 说明 |
|---|---|---|
| 消息渲染 UI | ⭐ 简单 | 直接复用 react-markdown 管线 |
| Lexical 输入框 | ⭐⭐ 中等 | 需要定制 @提及逻辑 |
| 模型选择器 | ⭐ 简单 | API 获取模型列表 |
| Planning/Fast 切换 | ⭐ 简单 | Redux 状态切换 |
| Agent 执行循环 | ⭐⭐⭐ 困难 | 工具调用+结果解析+循环控制 |
| 上下文组装 | ⭐⭐ 中等 | 需要实现 RAG 课件索引注入 |
| 对话持久化 | ⭐ 简单 | JSON/SQLite 存储 |
| 流式响应 | ⭐⭐ 中等 | SSE/WebSocket 处理 |

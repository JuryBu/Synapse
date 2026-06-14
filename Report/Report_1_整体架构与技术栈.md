# Report 1: Antigravity IDE 整体架构与技术栈

> **Experiment 1** 的核心报告，为 Synapse 项目提供架构蓝图。

---

## 1. 运行时架构

### Electron 39.2.3

Antigravity IDE 基于 **Electron 39.2.3**（Chromium 134+），是一个标准的多进程桌面应用：

```
┌─────────────────────────────────────────────────────────┐
│                    Main Process                          │
│  入口: out/main.js (8.4MB)                              │
│  职责: 窗口管理、文件系统、进程管理、IPC 中继           │
│    ├── Electron BrowserWindow: Workbench (主窗口)       │
│    │     workbench.html → workbench.js                  │
│    │     → vs/workbench/workbench.desktop.main.js (23MB)│
│    ├── Electron BrowserWindow: JetskiAgent (独立窗口)   │
│    │     workbench-jetski-agent.html → jetskiAgent.js   │
│    │     → jetskiAgent/main.js (11MB)                   │
│    ├── Extension Host Process × N                       │
│    │     入口: out/bootstrap-fork.js                    │
│    └── Language Server Process (LS)                     │
│          独立进程，通过 ConnectRPC/Protobuf 通信        │
└─────────────────────────────────────────────────────────┘
```

### 关键文件路径

| 文件 | 路径 | 大小 | 功能 |
|---|---|---|---|
| 主进程入口 | `out/main.js` | 8.4MB | Electron 主进程 |
| 工作台入口HTML | `out/vs/code/electron-browser/workbench/workbench.html` | 1.7KB | 渲染进程页面 |
| 工作台引导JS | `out/vs/code/electron-browser/workbench/workbench.js` | 25KB | 加载 workbench.desktop.main |
| 工作台核心 | `out/vs/workbench/workbench.desktop.main.js` | 23.8MB | VSCode 工作台全部代码 |
| 工作台CSS | `out/vs/workbench/workbench.desktop.main.css` | 1.1MB | 608个CSS变量 |
| Agent面板入口HTML | `out/vs/code/electron-browser/workbench/workbench-jetski-agent.html` | 1.8KB | Agent独立窗口 |
| Agent面板引导JS | `out/vs/code/electron-browser/workbench/jetskiAgent.js` | 19KB | 加载 jetskiAgent/main |
| Agent面板核心 | `out/jetskiAgent/main.js` | 11.2MB | Cascade UI 全部代码 |
| Agent面板CSS | `out/jetskiAgent/main.css` | 90KB | Agent面板样式 |
| Tailwind基础CSS | `out/tw-base.tailwind.css` | 17KB | Tailwind 基础样式 |
| Tailwind Agent CSS | `out/jetskiMain.tailwind.css` | 97KB | Agent 面板 Tailwind |
| 扩展入口 | `extensions/antigravity/dist/extension.js` | 3MB | 核心扩展逻辑 |

---

## 2. 前端技术栈

### 核心框架

| 技术 | 作用 | 备注 |
|---|---|---|
| **Preact** (`@preact/compat`) | React 兼容层，渲染 Agent UI | 以 `react`/`react-dom` 别名引入 |
| **Redux Toolkit** | 全局状态管理 | Agent 面板的核心状态 |
| **Lexical** | 富文本编辑器 | 对话输入框，支持 @提及等 |
| **TailwindCSS 4.x** | 样式框架 | Agent 面板使用 |
| **xterm.js** (`@xterm/xterm`) | 终端模拟器 | 内置终端面板 |
| **node-pty** | 终端进程 | PTY 后端 |
| **Monaco Editor** | 代码编辑器 | VSCode 核心编辑器 |

### Markdown 渲染栈

Agent 面板的消息渲染使用了一个完整的 unified/remark 栈：

```
react-markdown
  ├── remark-parse (解析 Markdown AST)
  ├── remark-gfm (GFM 扩展：表格、删除线等)
  ├── remark-github-blockquote-alert (> [!NOTE] 等 Alert 块)
  ├── remark-stringify (序列化)
  ├── rehype-raw (允许 HTML 穿透)
  ├── rehype-sanitize (XSS 防护)
  ├── rehype-slug (标题锚点)
  ├── highlight.js (代码语法高亮，支持 170+ 语言)
  ├── KaTeX (数学公式渲染)
  └── Mermaid (图表渲染)
```

### 通信协议

| 协议 | 库 | 用途 |
|---|---|---|
| **ConnectRPC** | `@connectrpc/connect` | Agent ↔ LS 通信 |
| **Protobuf** | `@bufbuild/protobuf` | 消息序列化 |
| **IPC** | Electron IPC | 主进程 ↔ 渲染进程 |
| **WebSocket** | 原生 | 实时流式传输 |

### Protobuf Schema（关键proto）

从 `@exa/proto-ts` 可以看到 Agent 通信的数据结构：
- `agent_manager_pb` — Agent 管理
- `language_server_pb` — LS 通信
- `cortex_pb` / `jetski_cortex_pb` — AI 推理核心
- `chat_pb` / `chat_client_server_pb` — 对话消息
- `cascade_plugins_pb` — 级联插件
- `diff_action_pb` — Diff 操作
- `reactive_component_pb` — 响应式组件
- `unified_state_sync_pb` — 状态同步

---

## 3. 模块加载系统

### ES Module Import Maps

Agent 面板使用 **Import Maps** 管理模块依赖（在 `jetskiAgent.js` 中动态构建）：

```json
{
  "imports": {
    "react": "../node_modules/preact/compat/dist/compat.mjs",
    "preact": "../node_modules/preact/dist/preact.mjs",
    "@reduxjs/toolkit": "../node_modules/@reduxjs/toolkit/dist/redux-toolkit.browser.mjs",
    "lexical": "../node_modules/lexical/Lexical.prod.mjs",
    "react-markdown": "../node_modules/react-markdown/index.js",
    "mermaid": "../node_modules/mermaid/dist/mermaid.esm.mjs",
    ...（100+ 模块映射）
  }
}
```

### CSS 动态加载

通过 `globalThis._VSCODE_CSS_LOAD` 函数动态注入 CSS `@import` 语句：
```js
const styleEl = document.createElement("style");
styleEl.id = "vscode-css-loading";
document.head.appendChild(styleEl);
globalThis._VSCODE_CSS_LOAD = function(url) {
    styleEl.textContent += `@import url(${url});\n`;
};
```

---

## 4. 内置扩展生态

Antigravity 内置了 **约100个扩展**，分三类：

### 核心扩展
- `antigravity` — AI 功能核心（Cascade 面板、自动补全、Agent）
- `antigravity-browser-launcher` — 浏览器子代理
- `antigravity-code-executor` — 代码执行

### VSCode 原生扩展
- 语言支持：python, javascript, typescript, java, cpp, go, rust, etc.
- 功能模块：git, github-authentication, debug, terminal-suggest, etc.
- 主题：theme-abyss, theme-monokai, theme-synthwave, theme-tokyo-night, etc.

### 特殊扩展
- `chrome-devtools-mcp` — Chrome DevTools MCP
- `simple-browser` — 内置简易浏览器
- `mermaid-chat-features` — Mermaid 图表集成
- `prompt-basics` — Prompt 基础功能

---

## 5. Synapse 可行性分析

### 可直接复用

| 技术 | 复用方式 | 难度 |
|---|---|---|
| Electron 运行时 | 直接使用 | 简单 |
| Preact + Redux | 直接使用 | 简单 |
| react-markdown 渲染栈 | 完整复用 remark/rehype 管线 | 简单 |
| highlight.js | 直接使用 | 简单 |
| KaTeX / Mermaid | 直接使用 | 简单 |
| xterm.js + node-pty | 直接使用 | 中等 |
| Lexical 富文本 | 复用并定制 @提及系统 | 中等 |
| TailwindCSS | 直接使用 | 简单 |

### 需要重新实现

| 功能 | 原因 | 难度 |
|---|---|---|
| LS 通信层 | Synapse 用 API/KEY 直接调用 | 中等 |
| Agent 循环逻辑 | 需要自己实现 Tool Calling 循环 | 困难 |
| 工具执行框架 | 需要自己实现沙箱和文件操作 | 困难 |
| 扩展加载系统 | 需要实现类似 Extension Host 的机制 | 困难 |

### 推荐架构

```
Synapse App (Electron)
  ├── Main Process
  │     ├── 窗口管理
  │     ├── 文件系统 API
  │     ├── MCP Server 生命周期管理
  │     └── 本地服务器管理
  ├── Workbench Window (渲染进程 1)
  │     ├── Monaco-like 布局框架 (split-view + grid-view)
  │     ├── Activity Bar + Sidebar + Editor + Panel
  │     └── 设置系统
  └── Agent Panel Window (渲染进程 2)
        ├── Preact + Redux 状态管理
        ├── Lexical 输入框
        ├── react-markdown 渲染
        └── API/KEY 直接调用 AI 模型
```

---

## 附录 A: 关键入口文件引用

- 主进程：[main.js](file:///C:/Users/Stardust/AppData/Local/Programs/Antigravity/resources/app/out/main.js)
- 工作台 HTML：[workbench.html](file:///C:/Users/Stardust/AppData/Local/Programs/Antigravity/resources/app/out/vs/code/electron-browser/workbench/workbench.html)
- Agent 面板 HTML：[workbench-jetski-agent.html](file:///C:/Users/Stardust/AppData/Local/Programs/Antigravity/resources/app/out/vs/code/electron-browser/workbench/workbench-jetski-agent.html)
- 扩展 package.json：[package.json](file:///C:/Users/Stardust/AppData/Local/Programs/Antigravity/resources/app/extensions/antigravity/package.json)
- 应用 package.json：[package.json](file:///C:/Users/Stardust/AppData/Local/Programs/Antigravity/resources/app/package.json)

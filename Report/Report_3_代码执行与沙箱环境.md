# Report 3: 代码执行、沙箱环境与文件预览

> Experiment 3 核心报告 — 终端集成、sandbox MCP、本地服务器、文件预览。

---

## 1. 集成终端

### 技术栈

| 组件 | 库 | 版本 |
|---|---|---|
| 终端模拟器 | `@xterm/xterm` | 5.6.0-beta.136 |
| WebGL 加速渲染 | `@xterm/addon-webgl` | 0.19.0-beta |
| 搜索 | `@xterm/addon-search` | 0.16.0-beta |
| Unicode | `@xterm/addon-unicode11` | — |
| 序列化 | `@xterm/addon-serialize` | — |
| 图片支持 | `@xterm/addon-image` | — |
| 无头终端 | `@xterm/headless` | 用于后台命令 |
| PTY 后端 | `node-pty` | 1.1.0-beta35 |

### 终端创建流程

```
Extension 调用 vscode.window.createTerminal(options)
  → Extension Host 发送 IPC 消息到主进程
  → 主进程 spawn node-pty 子进程 (shell: PowerShell/bash)
  → 创建 xterm.js 实例 (渲染进程)
  → 建立 PTY ↔ xterm 的数据流管道
  → 用户看到终端面板
```

### Synapse 终端方案

**直接复用:**
```json
{
    "dependencies": {
        "@xterm/xterm": "^5.6.0",
        "@xterm/addon-webgl": "^0.19.0",
        "@xterm/addon-search": "^0.16.0",
        "node-pty": "^1.1.0"
    }
}
```

---

## 2. 代码执行沙箱 (sandbox MCP)

### 架构

sandbox 是一个 **Node.js MCP 服务器**，位于 `~/.gemini/antigravity/mcp-sandbox/`。

```
Antigravity IDE
  └── MCP Client (LS/Extension Host)
       └── stdio 连接
            └── sandbox MCP Server (node process)
                 ├── sandbox_exec — 一次性代码执行
                 ├── sandbox_session — 有状态 REPL
                 ├── sandbox_batch — 并行批量执行
                 ├── sandbox_codex — Codex CLI 调用
                 ├── sandbox_launch — 长时间脱离执行
                 └── sandbox_status — 系统状态查看
```

### 执行隔离

- **Python**: 启动独立 Python 子进程
- **Node.js**: 启动独立 Node 子进程
- **PowerShell/Bash**: 启动 Shell 子进程
- **超时管理**: 硬超时自动杀进程
- **内存限制**: 进程级内存上限
- **输出截断**: 防止输出爆炸

### Synapse 代码执行建议

| 方案 | 优点 | 缺点 |
|---|---|---|
| **复用 sandbox MCP** | 成熟稳定，功能完整 | 依赖外部进程 |
| **自建轻量执行器** | 完全可控 | 需重新实现安全措施 |
| **推荐: 复用 + 扩展** | 最佳平衡 | — |

---

## 3. 本地开发服务器

### Synapse "展示模式" 设计

```
AI 生成 HTML/JS 代码
  → 写入工作区临时目录
  → 启动本地 HTTP 服务器 (http-server / express)
  → 中间面板 Webview 加载 localhost:PORT
  → 用户可交互/查看

技术方案:
  1. 内置轻量级 HTTP 服务器 (serve-static)
  2. 端口动态分配 (避免冲突)
  3. HMR: 文件变更时自动刷新 iframe
  4. 生命周期: 面板关闭时自动停止服务器
```

### simple-browser 扩展参考

Antigravity 内置了 `simple-browser` 扩展，提供了一个简易浏览器 Panel，可用作 Synapse 展示面板的参考。

---

## 4. 文件预览与渲染器

### VSCode 内置预览能力

| 文件类型 | 内置支持 | 实现方式 |
|---|---|---|
| 图片 | ✅ | 内置图片查看器 |
| Markdown | ✅ | markdown-language-features 扩展 |
| PDF | ❌ | 需要第三方扩展 (pdf.js) |
| PPT/PPTX | ❌ | 需要自定义 |
| DOCX | ❌ | 需要自定义 |

### Synapse 多格式渲染方案

```
课件文件
  ├── PDF → pdf.js (Webview 渲染)
  ├── PPTX → pptx.js / LibreOffice 转换
  ├── DOCX → mammoth.js 转 HTML
  ├── Images → <img> 原生渲染
  ├── Markdown → react-markdown (已有)
  ├── HTML → iframe 沙箱运行
  ├── Video → <video> 原生播放器
  └── 其他 → 纯文本/Hex 查看器
```

---

## 5. Synapse 整体技术推荐

### 即时可用的技术栈

```json
{
    "核心框架": "Electron 39.x",
    "UI 框架": "Preact + Redux Toolkit",
    "样式": "TailwindCSS 4.x",
    "对话输入": "Lexical",
    "消息渲染": "react-markdown + remark/rehype 全套",
    "代码高亮": "highlight.js",
    "数学公式": "KaTeX",
    "图表": "Mermaid",
    "终端": "xterm.js + node-pty",
    "图标": "lucide-react",
    "Tooltip": "@floating-ui + react-tooltip",
    "PDF 渲染": "pdf.js",
    "文件转换": "mammoth.js (DOCX→HTML)",
    "代码执行": "sandbox MCP 或自建",
    "AI 通信": "直接 HTTP/SSE 调用 API"
}
```

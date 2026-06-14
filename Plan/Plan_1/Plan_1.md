# Synapse 项目 Plan_1: 总纲领

> **Synapse** — AI 驱动的交互式学习平台，反向 Antigravity IDE 架构，以突触般的知识连接为核心理念。

---

## 0. 项目元信息

| 属性 | 值 |
|---|---|
| **项目名** | Synapse |
| **定位** | AI Canvas / Vibe Coding IDE 风格的学习辅助桌面应用 |
| **技术栈** | Electron + React 18 + Redux Toolkit + Vite + TypeScript |
| **设计风格** | Glassmorphism 磨砂玻璃 + 自定义背景图 |
| **项目路径** | `C:\Users\Stardust\Desktop\VC工具包\Synapse\` |
| **工程路径** | `Synapse/synapse-app/` |

### Plan 文件索引

| 文件 | 内容 |
|---|---|
| **Plan_1.md**（本文件） | 总纲领：Stage 概览、项目结构、技术架构 |
| **Plan_1_Synopsis引擎.md** | Synopsis 引擎升级方案（多模态 Map-Reduce） |
| **Plan_1_前端架构.md** | 前端布局、组件、状态管理详细设计 |
| **Plan_1_后端架构.md** | Electron 主进程、MCP 管理、文件系统 |
| **Plan_1_AI交互层.md** | Agent 循环、系统提示构建、API 通信 |
| **Plan_1_可扩展系统.md** | MCP/SKILL/WORKFLOW/RULES 实现 |
| **Task.md** | 各 Stage 的详细执行检查清单 |

---

## 1. 核心架构

### 1.1 进程模型

```
┌─────────────────────────────────────────────────────────────┐
│                    Synapse Main Process                      │
│  Electron 主进程                                             │
│  职责: 窗口管理、文件系统、MCP 管理、本地服务器管理          │
│                                                              │
│    ├── 单窗口 BrowserWindow (唯一渲染进程)                   │
│    │     三栏布局: Activity Bar + Sidebar + Editor/Preview   │
│    │     + 右侧 AI 面板 (全部在同一 React 应用中)            │
│    │     技术: React 18 + Redux Toolkit + Vite               │
│    │     布局: react-resizable-panels (参考 Levitate)        │
│    │     渲染: react-markdown + KaTeX + Mermaid + highlight  │
│    │     输入: Lexical 富文本 (支持 @提及/文件附件)          │
│    │                                                         │
│    ├── MCP Server 子进程 × N                                 │
│    │     stdio JSON-RPC 通信                                 │
│    │     生命周期: stdin断开 + ppid心跳 双层防线             │
│    │                                                         │
│    └── Local Server 子进程（展示模式）                       │
│          管理 AI 生成的 HTML/应用预览                        │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 三栏布局

```
┌────┬──────────────────────────────┬─────────────────────────┐
│    │                              │                         │
│ A  │         Editor / Preview     │     Agent Panel          │
│ c  │                              │     (AI 对话)            │
│ t  │   ┌──────────────────────┐   │                         │
│ i  │   │ 文件编辑 / 课件预览  │   │  ┌─────────────────┐   │
│ v  │   │ + 展示模式(iframe)   │   │  │  消息流渲染     │   │
│ i  │   └──────────────────────┘   │  │  (Markdown/      │   │
│ t  │                              │  │   Code/LaTeX/    │   │
│ y  │   ┌──────────────────────┐   │  │   Mermaid)       │   │
│    │   │ 终端 / 输出面板      │   │  └─────────────────┘   │
│ B  │   └──────────────────────┘   │  ┌─────────────────┐   │
│ a  │                              │  │ Lexical 输入框   │   │
│ r  ├──────────────────────────────┤  │ (多模态+@提及)   │   │
│    │         Sidebar              │  └─────────────────┘   │
│    │   文件树 / 课件索引 /        │                         │
│    │   Synopsis 概要面板          │                         │
└────┴──────────────────────────────┴─────────────────────────┘
```

### 1.3 技术栈全景

| 层次 | 技术 | 参考来源 |
|---|---|---|
| **运行时** | Electron (最新稳定版) | IDE |
| **UI框架** | React 18 | Aether Reader / Levitate |
| **构建工具** | Vite 7 + @vitejs/plugin-react | Aether Reader |
| **状态管理** | Redux Toolkit | IDE (精简为 ~20 Slices) |
| **样式** | TailwindCSS 4.x + 自定义 CSS变量 | IDE + Levitate |
| **面板布局** | react-resizable-panels | Levitate |
| **对话输入** | Lexical + @提及插件 | IDE |
| **消息渲染** | react-markdown + remark-gfm + rehype-raw + highlight.js + KaTeX + Mermaid | IDE |
| **终端** | xterm.js + node-pty | IDE |
| **代码编辑** | Monaco Editor | IDE / Levitate |
| **图标** | lucide-react | IDE / Levitate |
| **浮动UI** | @floating-ui | IDE |
| **文件解析** | pdf.js, mammoth(DOCX), pptx-parser, ffmpeg(视频), tesseract.js(OCR) | Aether Reader + 新增 |
| **AI通信** | OpenAI-compatible API + SSE streaming | 新增 |
| **数据库** | better-sqlite3 (对话历史/学习记录) + JSON (轻量配置) | 新增 |
| **RAG引擎** | Map-Reduce Synopsis 引擎 (多模态) | Aether Reader 升级 |
| **打包分发** | electron-builder (NSIS/DMG/AppImage) | Levitate |

---

## 2. Stage 概览

### Stage 1: 基础设施（Foundation）
> 工程初始化、Electron 骨架、构建系统

- 初始化 Electron + React 18 + TypeScript 项目
- 配置 Vite + TailwindCSS 4
- 实现启动画面（参考 Aether Reader 的 Bootloader）
- IPC 基础通信层

### Stage 2: 布局引擎（Layout Engine）
> 三栏布局、面板管理、拖拽分割

- Activity Bar 图标栏
- Sidebar 侧边栏（收展、树形视图）
- Editor 区域（多 Tab、分屏）
- Panel 底部面板（终端、输出）
- 布局状态持久化

### Stage 3: 设计系统（Design System）
> Glassmorphism 磨砂风格、主题、背景管理

- CSS 变量体系（参考 Levitate 的 `globals.css`）
- 磨砂玻璃效果（`backdrop-filter: blur()`）
- 背景管理面板（上传、轮播、模糊度调节）
- 深色/浅色主题切换
- 主题色选择（Violet / Sky Blue / Emerald / Sakura / Orange）

### Stage 4: 文件系统与工作区（Filesystem & Workspace）
> 文件管理、课程工作区模型

- 文件树组件（TreeView + 虚拟列表）
- 课程工作区创建/切换/删除
- 文件操作 API（CRUD + 拖放）
- 工作区状态持久化
- 最近工作区列表

### Stage 5: AI 通信层（AI Communication）
> API/KEY 配置、模型管理、SSE 流式

- 设置面板：API Base + KEY 配置
- 自动获取可用模型列表
- Thinking Model / Fast Model / Drawing Model 三类模型配置
- SSE Streaming 实时响应
- Token 计数与用量展示

### Stage 6: Agent 循环引擎（Agent Loop）
> 工具调用解析、执行、结果返回、多轮循环

- Tool Calling JSON 解析
- Tool 执行器框架（注册 + 调度 + 沙箱）
- Planning / Fast 模式切换
- Agent 循环控制（多轮工具调用 → 最终回复）
- 上下文窗口管理（截断/压缩策略）

### Stage 7: 对话界面（Chat Interface）
> 消息渲染、输入框、对话管理

- react-markdown 渲染管线
- Lexical 多模态输入（文本 + 图片 + 文件 + @提及）
- 工具调用折叠展示
- 代码块语法高亮 + 一键复制
- 对话历史存储/加载/搜索
- Streaming 实时渲染

### Stage 8: 内置工具集（Built-in Tools）
> 文件操作、搜索、命令执行等核心工具

- `view_file` / `write_to_file` / `replace_file_content`
- `list_dir` / `find_by_name` / `grep_search`
- `run_command` / `command_status`（审批机制）
- `generate_image`（调用 Drawing Model）
- `search_web` / `read_url_content`

### Stage 9: Synopsis 引擎（RAG Core）
> 多模态课件概要生成、知识索引

- 课件解析器（PDF/PPTX/DOCX/Markdown/图片/视频）
- Map-Reduce 概要生成引擎（详见 Plan_1_Synopsis引擎.md）
- 知识索引存储与检索
- 上下文注入（课程概要 → 系统提示）
- Synopsis 面板 UI

### Stage 10: 可扩展系统（Extensibility）
> MCP/SKILL/WORKFLOW/RULES 四大系统

- MCP 客户端（stdio JSON-RPC + Zod schema）
- MCP 服务器生命周期管理
- SKILL 目录扫描 + 系统提示注入
- WORKFLOW slash-command + turbo 注解
- RULES 全局/工作区规则加载
- 详见 Plan_1_可扩展系统.md

### Stage 11: 展示模式（Showcase Mode）
> 中间面板增强：课件预览、应用运行、交互式内容

- PDF 嵌入式查看器（pdf.js）
- PPT/DOCX 预览渲染
- Sandbox iframe（运行 AI 生成的 HTML/JS）
- 本地开发服务器管理器
- 展示模式切换 UI

### Stage 12: 终端与代码执行（Terminal & Execution）
> 集成终端、代码沙箱

- xterm.js + node-pty 终端
- 代码沙箱执行环境（Python/Node/Shell）
- 超时 + 内存限制
- 输出捕获与截断

### Stage 13: 系统提示构建（System Prompt）
> 完整的提示工程体系

- 身份提示模板
- 课程上下文注入（Synopsis 概要）
- RULES/SKILL/WORKFLOW/Tools 注入
- EPHEMERAL 动态注入（当前查看的课件）
- 上下文压缩（CHECKPOINT 机制）

### Stage 14: 打磨与优化（Polish）
> 动画、性能、无障碍、国际化

- 微动画和过渡效果
- 虚拟列表性能优化
- 快捷键系统
- 拖拽交互优化
- 错误处理与崩溃恢复

### Stage 15+: 未来扩展（Future）
> 协作、云同步、移动端等

- 多人协作学习
- 云端工作区同步
- 移动端适配（PWA？）
- 插件市场
- AI 模型本地运行(Ollama 集成)
- 学习数据分析（知识图谱可视化）

---

## 3. 项目目录结构

```
Synapse/
├── Plan_1.md                      # 总纲领（本文件）
├── Plan_1_Synopsis引擎.md          # RAG 引擎设计
├── Plan_1_前端架构.md              # 前端详细设计
├── Plan_1_后端架构.md              # 后端详细设计
├── Plan_1_AI交互层.md              # AI 通信与 Agent 设计
├── Plan_1_可扩展系统.md            # MCP/SKILL/WORKFLOW/RULES
├── Task.md                         # 执行检查清单
├── Experiment_*.md                 # IDE 逆向探索任务
├── Report_*.md                     # IDE 逆向研究报告
│
└── synapse-app/                    # 工程代码目录
    ├── package.json
    ├── electron/
    │   ├── main.ts                 # Electron 主进程
    │   ├── preload.ts              # 预加载脚本
    │   ├── ipc/                    # IPC 处理器
    │   ├── mcp/                    # MCP 服务器管理
    │   └── servers/                # 本地服务器管理
    ├── src/
    │   ├── main.tsx                # 渲染进程入口
    │   ├── App.tsx                 # 根组件
    │   ├── store/                  # Redux Store
    │   │   ├── index.ts
    │   │   └── slices/             # 各功能 Slice
    │   ├── components/
    │   │   ├── layout/             # 布局组件
    │   │   ├── sidebar/            # 侧边栏
    │   │   ├── editor/             # 编辑器/预览
    │   │   ├── agent/              # AI 对话面板
    │   │   ├── terminal/           # 终端
    │   │   ├── settings/           # 设置面板
    │   │   └── synopsis/           # Synopsis 面板
    │   ├── services/
    │   │   ├── ai/                 # AI 通信服务
    │   │   ├── synopsis/           # Synopsis 引擎
    │   │   ├── tools/              # 内置工具
    │   │   ├── mcp/                # MCP 客户端
    │   │   ├── skills/             # SKILL 加载
    │   │   ├── workflows/          # WORKFLOW 加载
    │   │   └── rules/              # RULES 加载
    │   ├── hooks/                  # 自定义 Hooks
    │   ├── types/                  # TypeScript 类型
    │   └── styles/                 # 全局样式 + CSS 变量
    ├── skills/                     # 内置技能
    ├── workflows/                  # 内置工作流
    └── public/                     # 静态资源
```

---

## 4. 设计准则

1. **参考为王**：开发前必须参考对应的 Report 文件和 Aether Reader/Levitate 实现
2. **风格对齐**：Glassmorphism 磨砂风格，CSS 变量统一管理
3. **渐进增强**：每个 Stage 产出可运行的增量版本
4. **代码质量**：TypeScript 严格模式，组件解耦，服务分层
5. **性能优先**：虚拟列表、懒加载、Worker 并发
6. **安全意识**：Webview CSP、沙箱隔离、API Key 本地加密存储

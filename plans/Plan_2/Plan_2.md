# Synapse Plan_2: 全面排查总纲

> **排查日期**：2026-04-25
> **排查方式**：自主代码审计 + Codex 5.4 独立 Review（双轮）
> **目标**：评估项目一个月停滞后的真实状态，确定 Plan_2 阶段推进路线

---

## 0. Plan_2 文件索引

| 文件 | 内容 |
|---|---|
| **Plan_2.md**（本文件） | 排查总纲：整体现状、差距总览、推进路线 |
| **Plan_2_代码审计.md** | 代码质量、架构问题、安全风险、改进建议 |
| **Plan_2_功能差距.md** | Task.md 每个 Stage 的实际完成度详细分析 |

---

## 1. 项目整体现状

### 1.1 基本信息
- **技术栈**：Electron 41 + React 19 + Vite 8 + TypeScript 5.9 + TailwindCSS 4 + Redux Toolkit
- **代码规模**：30 组件 + 11 Redux Slices + 10 服务模块 + 9 CSS 文件
- **构建状态**：✅ `tsc -b --noEmit` 通过（0 errors）
- **上次工作**：2026-03-23/24（约一个月前）

### 1.2 已实现功能总览

| 类别 | 已实现 | 备注 |
|---|---|---|
| **UI 壳体** | 三栏布局、Activity Bar、面板 resize、标签页系统 | 基本完整 |
| **设计系统** | CSS 变量体系、暗色主题、基础磨砂效果 | 磨砂/响应式待打磨 |
| **AI 对话** | AIClient SSE、AgentLoop 25轮循环、SystemPrompt XML 构建 | 核心链路可用 |
| **工具系统** | 8 个内置工具 + ToolRegistry + 审批机制 | Web 模式 Mock |
| **渲染引擎** | react-markdown + KaTeX + Mermaid + 代码高亮 | 完整 |
| **通知/交互** | Toast 5种 + 命令面板 + 快捷键 + QuickOpen + 右键菜单 | 基本完整 |
| **对话管理** | 对话历史列表 + 导出(MD/JSON) + 消息编辑/回溯/删除 | 仅内存 |
| **扩展系统** | ExtensionManager(7 SKILL + 2 Workflow) + SystemPrompt 注入 | 静态定义 |
| **Multi-AI** | AgentOrchestrator + Redux Slice + 2 内置模式 | 框架完整 |
| **查看器** | 图片/Markdown/媒体播放器 + ShowcaseFrame(iframe) | 部分完成 |
| **文件系统** | FileSystemService + Web 模式内存模拟 + 演示文件树 | Web Mock |
| **终端** | TerminalPanel Web 模拟基础命令 | 仅模拟 |

### 1.3 未实现核心功能

| 类别 | 缺失项 | 严重程度 |
|---|---|---|
| **数据持久化** | SQLite + better-sqlite3 + FTS5 全文搜索 | 🔴 核心 |
| **IPC 通信** | Electron 主进程 IPC handler 全部未实现 | 🔴 核心 |
| **真实文件系统** | Node.js fs 操作、文件树虚拟滚动、文件拖拽 | 🔴 核心 |
| **MCP 客户端** | stdio JSON-RPC 通信、服务器生命周期管理 | 🟡 重要 |
| **Synopsis RAG** | PDF/PPTX/DOCX 解析、Map-Reduce 引擎 | 🟡 重要 |
| **Monaco Editor** | 代码编辑器集成 | 🟡 重要 |
| **xterm.js 终端** | node-pty + IPC 桥接 | 🟡 重要 |
| **完整设置面板** | 16 分类设置 UI + 首次使用向导 | 🟢 可延后 |
| **PDF/DOCX 查看器** | pdf.js Canvas 渲染、mammoth HTML | 🟢 可延后 |
| **Electron 打包** | electron-builder NSIS/DMG | 🟢 最后阶段 |

---

## 2. 架构分析

### 2.1 当前架构的优点
1. **服务分层清晰**：services/ 下各模块职责明确，单例模式统一管理
2. **Redux 状态设计合理**：11 个 Slice 覆盖了核心状态域，类型安全
3. **AI 链路完整**：AIClient → AgentLoop → ToolRegistry → SystemPrompt 四层完整
4. **Multi-AI 前瞻设计**：AgentOrchestrator + SubagentConfig 架构先进
5. **平台适配层**：isElectron 判断 + Web 模式降级方案明确

### 2.2 架构问题与风险

| 编号 | 问题 | 严重度 | 详情 |
|---|---|---|---|
| A-1 | Electron 主进程几乎为空壳 | 🔴 P0 | `electron/main.ts` 和 `preload.ts` 只有基本窗口创建，无 IPC handler |
| A-2 | 数据全部存在内存/localStorage | 🔴 P0 | 关闭页面即丢失，不适合生产使用 |
| A-3 | API Key 明文存储在 Redux | 🔴 P0 | `settings.apiKeys` 直接 localStorage，无 safeStorage 加密 |
| A-4 | SKILL/WORKFLOW 只有静态定义 | 🟡 P1 | 无文件系统扫描，无 SKILL.md 实际加载 |
| A-5 | compressContext 非 AI 摘要 | 🟡 P1 | CHECKPOINT 压缩只截取文本前200字，非调用模型生成摘要 |
| A-6 | AgentPanel 448行大组件 | 🟡 P1 | 输入/消息列表/模式切换/导出全在一个组件 |
| A-7 | 无错误边界覆盖全局 | 🟡 P1 | ErrorBoundary.tsx 存在但未包裹关键组件 |
| A-8 | fileSystem 硬编码演示数据 | 🟢 P2 | Web 模式的 DEMO_FILE_TREE 是静态的 |

---

## 3. 推进路线建议

### 方案 A：补齐核心后端（继续原 Plan_1 路线）

按 Stage 3后半 → 4 → 5 → 7 → 8 顺序补齐 Electron 核心功能。
- 优点：延续既有设计，Plan 文件不浪费
- 缺点：工程量大，需 Electron 主进程大量开发

### 方案 B：Web-First 精简版

先做一个纯 Web 版可用 MVP（放弃 Electron 特有功能），再逐步增强。
- 优点：快速可演示，可部署到线上
- 缺点：无法使用本地文件系统、终端、MCP

### 方案 C：重新评估定位

1. 一个月来技术环境变化（新 AI API/工具），重新审视需求
2. 可能缩减范围到「AI 学习助手」而非「完整 IDE」
3. 保留已有 AI 对话核心 + Synopsis 概念，砍掉 IDE 功能

> [!IMPORTANT]
> 推荐由用户决定后续方向。无论选择哪个方案，当前代码的 UI 壳体和 AI 核心链路都可复用。

---

## 4. Codex 审计状态

- Codex 5.4 独立 Review 已后台启动（codex-001）
- 审查范围：全部 src/ 源码，对照 Plan_1.md 和 Task.md
- 报告将输出到：`synapse-app/报告_Plan2全面审计_Codex.md`
- 完成后将整合到 Plan_2_代码审计.md


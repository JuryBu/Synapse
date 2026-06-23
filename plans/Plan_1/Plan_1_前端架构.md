# Plan_1_前端架构: 布局、组件与状态管理

> 技术栈：React 18 + Vite + Redux Toolkit + TailwindCSS 4 + react-resizable-panels
> 参考 Antigravity IDE 架构 + Levitate UI 设计。

---

## 1. 窗口架构

### 单窗口方案（推荐）

与 IDE 的双 BrowserWindow 不同，Synapse 采用**单窗口内多区域**方案：

**理由**：
- IDE 的 Agent Panel 是独立窗口因为它是后来追加的（Windsurf fork VSCode 后添加 Cascade）
- Synapse 从零构建，可以原生集成对话面板，不需要独立窗口
- 单窗口更简洁，状态共享更直接（无需 IPC 同步）

```
┌─ Electron BrowserWindow ──────────────────────────────────────┐
│  ┌──────┬─────────────────────────┬──────────────────────────┐ │
│  │      │                         │                          │ │
│  │  AB  │    SB    │   Editor     │      Agent Panel          │ │
│  │      │          │   Area       │                          │ │
│  │ 42px │  var     │             │        var               │ │
│  │      │          │             │                          │ │
│  │      │          ├─────────────┤                          │ │
│  │      │          │   Bottom    │                          │ │
│  │      │          │   Panel     │                          │ │
│  └──────┴─────────────────────────┴──────────────────────────┘ │
│  └─ Status Bar (22px) ──────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘

AB = Activity Bar (42px, 固定)
SB = Sidebar (默认收起, 可拖拽调宽)
Editor Area = 中间编辑器/展示区域 (弹性)
Agent Panel = AI 对话面板 (默认 35% 宽度, 可拖拽)
Bottom Panel = 终端/输出 (默认折叠)
```

### 布局引擎（react-resizable-panels）

使用 Levitate 同款 `react-resizable-panels` 库（非自实现 splitview）：

```tsx
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

function AppLayout() {
  return (
    <div className="app-shell">
      <ActivityBar />  {/* 固定 42px，不参与面板分割 */}
      <PanelGroup direction="horizontal" className="main-area">
        <Panel defaultSize={18} minSize={12} maxSize={30} collapsible>
          <Sidebar />
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel defaultSize={47} minSize={30}>
          <PanelGroup direction="vertical">
            <Panel defaultSize={75}>
              <EditorArea />
            </Panel>
            <PanelResizeHandle className="resize-handle" />
            <Panel defaultSize={25} collapsible>
              <BottomPanel />
            </Panel>
          </PanelGroup>
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel defaultSize={35} minSize={20} collapsible>
          <AgentPanel />
        </Panel>
      </PanelGroup>
      <StatusBar />
    </div>
  );
}
```

**优势**：
- 开箱即用的拖拽分割线，无需自己处理鼠标事件
- 内置 `collapsible` 面板折叠支持
- `minSize`/`maxSize` 约束
- Panel 状态可持久化到 localStorage

---

## 2. Redux Store 设计

参考 IDE 的 32 个 Slice，Synapse 需要约 20 个 Slice：

### 核心 Slices

```typescript
// store/slices/

// === 对话相关 ===
conversation.ts         // 当前对话状态（messages, streaming, model）
conversationHistory.ts  // 对话历史列表
pendingMessage.ts       // 待发送消息缓存

// === Agent 相关 ===
agentLoop.ts           // Agent 执行循环状态
agentSettings.ts       // Planning/Fast 模式、当前模型
toolExecution.ts       // 工具调用状态和结果

// === 布局相关 ===
layout.ts              // 布局状态（面板大小、可见性）
sideBar.ts             // 侧边栏状态（当前视图、宽度）

// === 文件相关 ===
fileExplorer.ts        // 文件树状态
editorTabs.ts          // 编辑器标签页
workspaceState.ts      // 工作区信息

// === Synopsis 相关 ===
synopsis.ts            // Synopsis 引擎状态（进度、结果）
courseContext.ts        // 课程上下文（注入到 AI）

// === 模型与设置 ===
modelConfig.ts         // 模型配置（API/KEY、模型列表）
settings.ts            // 全局设置

// === 可扩展系统 ===
mcpServers.ts          // MCP 服务器状态
skills.ts              // 已加载的 SKILL 列表
workflows.ts           // 已加载的 WORKFLOW 列表

// === UI 状态 ===
modal.ts               // 弹窗状态
notifications.ts       // 通知/Toast
theme.ts               // 主题状态
```

---

## 3. 核心组件架构

### 3.1 Activity Bar

```
components/layout/ActivityBar.tsx
├── ActivityBarIcon.tsx         # 单个图标按钮
├── activityBarItems.ts         # 图标注册表
└── styles/activityBar.css
```

**注册方式**（静态 + MCP 动态）：
```typescript
const builtinItems: ActivityBarItem[] = [
  { id: 'explorer', icon: FolderTree, tooltip: '课件管理', view: 'FileExplorer' },
  { id: 'synopsis', icon: Brain, tooltip: '知识概要', view: 'SynopsisPanel' },
  { id: 'search', icon: Search, tooltip: '搜索', view: 'SearchPanel' },
  { id: 'settings', icon: Settings, tooltip: '设置', view: 'SettingsPanel' },
];
```

### 3.2 Sidebar 视图

```
components/sidebar/
├── SidebarContainer.tsx        # 侧边栏容器
├── FileExplorer/               # 文件资源管理器
│   ├── FileTree.tsx            # 树形组件
│   ├── FileTreeItem.tsx        # 树节点
│   └── useFileTree.ts          # 文件树 Hook
├── SynopsisPanel/              # Synopsis 概要面板
│   ├── SynopsisOverview.tsx    # 工作区概要总览
│   ├── FileSynopsisCard.tsx    # 文件概要卡片
│   └── ChunkDetail.tsx         # Chunk 详情
├── SearchPanel/                # 搜索面板
└── SettingsPanel/              # 设置面板
    ├── ModelConfig.tsx          # 模型配置
    ├── ThemeConfig.tsx          # 主题/背景设置
    ├── SynopsisConfig.tsx       # Synopsis 引擎设置
    └── MCPConfig.tsx            # MCP 服务器管理
```

### 3.3 Editor 区域

```
components/editor/
├── EditorContainer.tsx         # 编辑器容器（Tab 管理）
├── EditorTabs.tsx              # 标签栏
├── editors/
│   ├── MonacoEditor.tsx        # Monaco 代码编辑器
│   ├── PdfViewer.tsx           # PDF 嵌入查看器 (pdf.js)
│   ├── PptxViewer.tsx          # PPT 预览 (渲染为图片序列)
│   ├── DocxViewer.tsx          # Word 预览 (mammoth → HTML)
│   ├── MarkdownPreview.tsx     # Markdown 预览
│   ├── ImageViewer.tsx         # 图片查看器
│   ├── VideoPlayer.tsx         # 视频播放器
│   └── ShowcaseFrame.tsx       # 展示模式 (iframe)
└── BottomPanel/
    ├── TerminalPanel.tsx        # 终端面板 (xterm.js)
    └── OutputPanel.tsx          # 输出面板
```

### 3.4 Agent Panel（AI 对话）

```
components/agent/
├── AgentPanel.tsx              # 对话面板容器
├── MessageList.tsx             # 消息流列表
├── messages/
│   ├── UserMessage.tsx         # 用户消息
│   ├── AssistantMessage.tsx    # AI 消息（Markdown 渲染）
│   ├── ToolCallMessage.tsx     # 工具调用折叠展示
│   ├── ImageMessage.tsx        # 图片消息
│   └── StreamingIndicator.tsx  # 流式打字指示
├── input/
│   ├── ChatInput.tsx           # Lexical 输入框容器
│   ├── MentionPlugin.tsx       # @提及插件
│   ├── FileAttachPlugin.tsx    # 文件附件插件
│   └── ModelSelector.tsx       # 模型选择器
├── toolbar/
│   ├── ModeSwitch.tsx          # Planning/Fast 切换
│   ├── ConversationPicker.tsx  # 对话列表切换
│   └── TokenCounter.tsx        # Token 用量展示
└── renderers/
    ├── MarkdownRenderer.tsx    # react-markdown 配置
    ├── CodeBlock.tsx           # 代码块（highlight.js + 复制）
    ├── MathBlock.tsx           # 数学公式（KaTeX）
    └── DiagramBlock.tsx        # 图表（Mermaid）
```

---

## 4. 设计系统

### 4.1 CSS 变量体系

```css
:root {
  /* === 主题颜色 === */
  --syn-primary: 250 87% 65%;          /* 主色(HSL) */
  --syn-primary-glow: rgba(124, 77, 255, 0.3);
  --syn-accent: 280 100% 70%;
  --syn-bg: 220 20% 8%;               /* 背景色 */
  --syn-surface: 220 20% 12%;         /* 面板色 */
  --syn-text: 0 0% 95%;
  --syn-text-secondary: 0 0% 65%;
  --syn-border: 0 0% 100% / 0.08;

  /* === 磨砂玻璃 === */
  --glass-bg: rgba(15, 15, 25, 0.75);
  --glass-blur: 20px;
  --glass-border: 1px solid rgba(255, 255, 255, 0.08);
  --glass-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);

  /* === 布局尺寸 === */
  --activity-bar-width: 42px;
  --status-bar-height: 22px;
  --sidebar-default-width: 240px;
  --agent-panel-min-width: 280px;

  /* === 动画 === */
  --transition-fast: 150ms ease;
  --transition-normal: 250ms ease;
  --transition-slow: 400ms cubic-bezier(0.4, 0, 0.2, 1);
}

/* 磨砂面板基础类 */
.glass-panel {
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  border: var(--glass-border);
  box-shadow: var(--glass-shadow);
}
```

### 4.2 背景系统

```typescript
interface BackgroundConfig {
  type: 'image' | 'gradient' | 'solid';
  imagePath?: string;
  gradientCSS?: string;
  opacity: number;        // 背景不透明度 (0.1-1.0)
  blur: number;           // 背景模糊度 (0-30px)
}
```

背景图作为 `<body>` 的 `::before` 伪元素，上面的面板都是半透明磨砂效果。

---

## 5. 响应式行为

| 窗口宽度 | Sidebar | Agent Panel | Editor |
|---|---|---|---|
| > 1400px | 显示 | 并排显示 | 正常 |
| 1000-1400px | 收起 | 并排显示（窄） | 正常 |
| < 1000px | 收起 | 全屏覆盖 | 让位 |

Agent Panel 可以通过双击分割线切换"全屏对话"模式。

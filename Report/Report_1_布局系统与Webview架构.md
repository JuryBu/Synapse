# Report 1-2: 布局系统与 Webview 架构

> Experiment 1 第二部分 — 三栏布局、Webview、主题系统的逆向分析。

---

## 1. 三栏布局系统

### 布局组件层次

```
body
  └── #monaco-parts-splash （启动画面，加载后移除）
  └── .monaco-workbench （主工作台容器）
       ├── .part.titlebar          (标题栏)
       ├── .part.banner            (横幅通知)
       ├── .activitybar            (Activity Bar, 42px 宽)
       ├── .part.sidebar           (Side Bar, 可变宽)
       ├── .editor-group-container (Editor Group, 弹性占满)
       │    ├── .tabs-container    (Tab 标签栏)
       │    ├── .editor-container  (编辑器内容区)
       │    └── .monaco-progress-container
       ├── .part.auxiliarybar      (Secondary Side Bar, 可选)
       ├── .part.panel             (底部/右侧面板)
       └── .part.statusbar         (状态栏, 22px 高)
```

### 布局策略

**核心使用 `split-view-container` + `grid-view-container`：**

```css
/* SplitView：水平/垂直分割容器 */
.split-view-container {
    width: 100%;
    height: 100%;
    white-space: nowrap;
    position: relative;
}
.split-view-container > .split-view-view {
    white-space: initial;
    position: absolute;  /* 绝对定位，JS 计算位置 */
}

/* GridView：嵌套分割 */
.grid-view-container {
    width: 100%;
    height: 100%;
}
```

**关键点：布局不是纯 CSS Flexbox/Grid，而是 JS 驱动的绝对定位！**
- VSCode 的 `SplitView` 通过 JS 计算每个 part 的 position/size
- 拖拽分割线时实时更新 `style.left`、`style.width`、`style.height`
- 持久化布局状态到 `settings.json`（`partsSplash.layoutInfo`）

### 启动画面（Splash Screen）布局参数

从 `workbench.js` 的 splash screen 代码反向出的布局参数：

```javascript
// 从配置中读取的布局信息
layoutInfo = {
    titleBarHeight: number,      // 标题栏高度
    activityBarWidth: number,    // Activity Bar 宽度 (默认42px)
    sideBarWidth: number,        // Side Bar 宽度 (用户可调)
    sideBarSide: "left" | "right", // Side Bar 位置
    auxiliaryBarWidth: number,   // 辅助侧边栏宽度
    editorPartMinWidth: number,  // 编辑器区最小宽度
    statusBarHeight: number,     // 状态栏高度 (22px)
    windowBorder: boolean,
    windowBorderRadius: string
};

// 颜色信息
colorInfo = {
    titleBarBackground: string,
    titleBarBorder: string,
    activityBarBackground: string,
    activityBarBorder: string,
    sideBarBackground: string,
    sideBarBorder: string,
    statusBarBackground: string,
    statusBarNoFolderBackground: string,
    statusBarBorder: string,
    editorBackground: string,
    foreground: string,
    windowBorder: string
};
```

### 面板类型与 CSS

```css
/* Activity Bar - 最左侧图标栏 */
.activitybar { width: 42px; height: 100%; }
.activitybar.bordered:before { /* 右侧1px边框 */ }

/* Sidebar - 侧边栏 */
.sidebar > .title { background-color: var(--vscode-sideBarTitle-background); }
.monaco-workbench.nosidebar > .part.sidebar { display: none !important; }

/* Editor Group - 编辑器区 */
.editor-group-container { height: 100%; }
.editor-group-container.empty { opacity: .5; }

/* Auxiliary Bar - 辅助侧边栏（Cascade 可能在此） */
.auxiliarybar > .title { background-color: var(--vscode-sideBarTitle-background); }

/* Status Bar - 状态栏 */
.statusbar {
    box-sizing: border-box;
    width: 100%; height: 22px;
    font-size: 12px;
    display: flex; overflow: hidden;
    transition: background-color .15s ease-out;
}
```

---

## 2. Cascade 面板架构

### 关键发现：Cascade 是一个**独立的 Electron BrowserWindow**

从文件结构可以看出，Cascade/Agent 面板并非 VSCode 的 Webview Panel，而是一个**独立的渲染进程窗口**：

```
渲染进程 1 (Workbench):
  workbench.html → workbench.js → workbench.desktop.main.js
  加载: workbench.desktop.main.css (1.1MB)
  
渲染进程 2 (JetskiAgent/Cascade):
  workbench-jetski-agent.html → jetskiAgent.js → jetskiAgent/main.js
  加载: tw-base.tailwind.css + jetskiMain.tailwind.css
```

两个窗口可能通过 Electron IPC 或 MessagePort 通信。

### Agent 面板的 HTML 入口

```html
<!-- workbench-jetski-agent.html -->
<head>
    <!-- CSP 安全策略 -->
    <link rel="stylesheet" href="../../../../tw-base.tailwind.css">
    <link rel="stylesheet" href="../../../../jetskiMain.tailwind.css">
</head>
<body aria-label="">
</body>
<script src="./jetskiAgent.js" type="module"></script>
```

而扩展的 `cascade-panel.html`：
```html
<body style="margin: 0">
    <div id="react-app" class="react-app-container"></div>
</body>
```

### Agent UI 技术栈详情

Agent 面板通过 Import Maps 引入了完整的前端工具链：

| 类别 | 库 | 用途 |
|---|---|---|
| **UI框架** | Preact + @preact/compat | React 兼容层 |
| **状态管理** | Redux Toolkit + react-redux | 全局状态 |
| **输入框** | Lexical + lexical-beautiful-mentions | 富文本 @提及 |
| **渲染** | react-markdown + remark + rehype套件 | Markdown |
| **样式** | TailwindCSS + classnames | 样式框架 |
| **图标** | lucide-react | 图标库 |
| **通信** | @connectrpc + @bufbuild/protobuf | RPC 通信 |
| **图表** | Mermaid | 图表渲染 |
| **Tooltip** | react-tooltip + @floating-ui | 浮动提示 |
| **差异** | diff | 文本差异 |
| **安全** | DOMPurify | XSS 防护 |

---

## 3. 自定义编辑器 (Custom Editor)

### 注册方式

通过 `antigravity` 扩展的 `package.json` 的 `contributes.customEditors`：

```json
{
    "customEditors": [
        {
            "viewType": "antigravity.workflowEditor",
            "displayName": "Workflow Editor",
            "selector": [
                {"filenamePattern": "**/.agent/workflows/**/*.md"},
                {"filenamePattern": "**/_agent/workflows/**/*.md"},
                {"filenamePattern": "**/.agents/workflows/**/*.md"},
                {"filenamePattern": "**/_agents/workflows/**/*.md"},
                {"filenamePattern": "**/.gemini/jetski*/global_workflows/*.md"},
                {"filenamePattern": "**/.gemini/antigravity*/global_workflows/*.md"}
            ],
            "priority": "default"
        },
        {
            "viewType": "antigravity.ruleEditor",
            "displayName": "Rule Editor",
            "selector": [
                {"filenamePattern": "**/.agent/rules/**/*.md"},
                {"filenamePattern": "**/_agent/rules/**/*.md"},
                {"filenamePattern": "**/.agents/rules/**/*.md"},
                {"filenamePattern": "**/_agents/rules/**/*.md"}
            ],
            "priority": "default"
        }
    ]
}
```

### Webview 的 Custom Editor 实现

自定义编辑器位于 `extensions/antigravity/customEditor/`：
- `utils.js` — Webview 通用工具
- `media/` — 编辑器媒体资源

Custom Editor 使用 VSCode 的 `CustomEditorProvider` API：
1. 注册 `viewType` 和文件模式匹配
2. 当用户打开匹配的文件时，VSCode 调用 `resolveCustomEditor()`
3. 编辑器在 Webview（iframe）中渲染内容
4. 通过 `postMessage` 与 Extension Host 通信

---

## 4. 主题与 CSS 变量系统

### CSS 变量规模

工作台 CSS 中共定义了 **608 个** `--vscode-*` CSS 变量，完全控制了所有 UI 元素的外观。

### 核心变量分类

| 分类 | 示例变量 | 数量（约） |
|---|---|---|
| **Activity Bar** | `--vscode-activityBar-background`, `-foreground`, `-activeBorder` | 10+ |
| **Side Bar** | `--vscode-sideBar-background`, `--vscode-sideBarTitle-background` | 10+ |
| **Editor** | `--vscode-editor-background`, `-foreground`, `-findMatch*` | 80+ |
| **Status Bar** | `--vscode-statusBar-background`, `-noFolderBackground` | 10+ |
| **Tab** | `--vscode-tab-*` | 20+ |
| **List/Tree** | `--vscode-list-*`, `--vscode-tree-*` | 30+ |
| **Input** | `--vscode-input-*` | 10+ |
| **Button** | `--vscode-button-*` | 10+ |
| **Chat** | `--vscode-chat-list-background` | 5+ |

### 主题切换机制

1. 主题定义在 JSON 配置中（颜色 token → 具体色值）
2. 加载主题时，VSCode 将颜色映射转换为 CSS 变量
3. 动态修改 `<style>` 标签中的 `:root` 变量值
4. 所有 UI 组件通过 `var(--vscode-xxx)` 引用，立即生效

### 背景与磨砂效果

VSCode 原生**不支持**背景图。要实现 Synapse 的 Glassmorphism 风格：

```css
/* 推荐的磨砂面板实现方案 */
.synapse-panel {
    background: rgba(30, 30, 46, 0.75);   /* 半透明背景 */
    backdrop-filter: blur(20px);           /* 磨砂模糊 */
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
}

/* 全局背景图 */
.synapse-workbench {
    background-image: url('user-background.jpg');
    background-size: cover;
    background-position: center;
}
```

---

## 5. 设置系统

### 设置注册

通过扩展的 `contributes.configuration`：

```json
{
    "title": "Antigravity Editor",
    "properties": {
        "antigravity.marketplaceExtensionGalleryServiceURL": {
            "type": "string",
            "default": "https://open-vsx.org/vscode/gallery"
        },
        "antigravity.searchMaxWorkspaceFileCount": {
            "type": "integer",
            "default": 5000
        },
        "antigravity.persistentLanguageServer": {
            "type": "boolean",
            "default": false
        }
    }
}
```

### 配置分层

```
默认值 (package.json 中的 default)
  ↓ 覆盖
用户全局设置 (~/.config/Antigravity/User/settings.json)
  ↓ 覆盖
工作区设置 (.vscode/settings.json)
```

### Synapse 的设置系统设计

建议实现方式：
1. **UI**：使用 Preact 组件渲染设置面板（参考 Aether Reader 的设置系统）
2. **存储**：JSON 文件存储配置（用户级 + 课程工作区级）
3. **API/KEY 管理**：专门的安全存储（可用 Electron 的 `safeStorage`）
4. **背景图管理**：复用 Aether Reader 的背景管理面板代码

---

## 6. Synapse 整体可行性总结

| 能力 | 复用来源 | 工作量评估 |
|---|---|---|
| 三栏布局 | 参考 VSCode 的 split-view 但简化实现 | ⭐⭐ 中等 |
| Cascade 面板 | 可参考但需重写 AI 通信层 | ⭐⭐⭐ 困难 |
| Custom Editor / Webview | 参考 VSCode API 设计 | ⭐⭐ 中等 |
| 主题系统 | CSS 变量 + 磨砂效果 | ⭐ 简单 |
| 设置系统 | 自建 Preact 组件 | ⭐ 简单 |
| Markdown 渲染 | 完整复用 remark/rehype 管线 | ⭐ 简单 |
| 富文本输入框 | 复用 Lexical | ⭐⭐ 中等 |
| 终端集成 | xterm.js + node-pty | ⭐ 简单 |

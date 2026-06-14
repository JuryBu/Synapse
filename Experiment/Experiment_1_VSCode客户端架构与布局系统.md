# Experiment 1: VSCode 客户端架构与布局系统逆向

## 目标

逆向分析 Antigravity IDE（基于 Windsurf/VSCode 的 fork）的客户端架构，理解其三栏布局系统、面板管理、以及编辑器区域的实现方式。**目的是为 Synapse 项目复刻类似的 IDE 风格界面提供技术蓝图。**

> **注意**：我们不需要逆向 LS（Language Server）通信机制，因为 Synapse 使用用户配置的 API/KEY 直接与 AI 模型交互。我们需要的是**纯客户端层面的架构**。

---

## 1. 整体客户端架构

### 需要探索的内容

1. **应用框架**：
   - Antigravity/Windsurf 是基于 Electron 还是什么运行时？
   - 主进程(Main Process)和渲染进程(Renderer Process)的分工
   - IPC 通信的主要模式

2. **前端框架**：
   - 渲染层用的是什么？原生 DOM？React？Lit？
   - VSCode 的 Workbench 是如何构建的（MonacoEditor 的角色）
   - 组件系统是怎样的

3. **构建系统**：
   - 源码是如何编译打包的
   - 扩展(Extension)的加载机制概览

### 报告要求
- 画出客户端的主要模块关系图
- 列出关键的入口文件和配置文件路径

---

## 2. 三栏布局系统

这是 Synapse 最核心的参考对象。VSCode 的经典布局是：
```
[Activity Bar] [Side Bar] [Editor Group] [Panel(底部)] [Secondary Sidebar(可选)]
```

### 需要探索的内容

1. **Activity Bar（最左侧图标栏）**：
   - 图标是如何注册的？（Extensions 的 `contributes.viewsContainers`？）
   - 点击图标如何切换 SideBar 内容？
   - 图标栏的渲染实现（是 DOM 还是 Canvas？）
   - Badge（通知角标）是如何实现的？

2. **Side Bar（侧边栏）**：图标栏的渲染实现（是 DOM 还是 Canvas？）
   - 文件资源管理器（Explorer）的树形结构实现
   - 侧边栏的收展动画和宽度调节（拖拽分割线）
   - 多个 View 如何在侧边栏堆叠和折叠
   - 侧边栏视图的注册和切换机制

3. **Editor Group（编辑器区域）**：
   - Tab 系统的实现（多标签页管理）
   - 编辑器分屏（Split Editor）的实现
   - 不同类型的编辑器（代码编辑器 vs 自定义编辑器 vs Webview）如何共存
   - **Webview Panel**：这是 Synapse 展示模式的关键——Extensions 如何注册和使用 Webview

4. **Panel（底部面板）**：
   - 终端(Terminal)、输出(Output)、问题(Problems) 等面板的注册方式
   - 面板的拖拽和大小调节
   - 面板的显示/隐藏动画

5. **布局持久化**：
   - 布局状态（各面板大小、位置）是如何保存和恢复的
   - WorkbenchLayout 相关的 API 或服务

### 报告要求
- 提供布局系统的 DOM 结构截图或示意图
- 标注关键的 CSS class 名和布局策略（Flexbox? Grid?）
- 列出布局相关的核心服务/类名

---

## 3. 自定义编辑器与 Webview

Synapse 的中间面板需要展示 PPT、PDF、运行中的 HTML 应用等，对应 VSCode 的 Custom Editor 和 Webview 能力。

### 需要探索的内容

1. **Webview API**：
   - `vscode.window.createWebviewPanel()` 的内部实现
   - Webview 的安全沙箱机制（CSP、iframe 隔离等）
   - Webview 与 Extension Host 之间的消息传递机制
   - Webview 的资源访问（本地文件、网络资源）权限模型

2. **Custom Editor Provider**：
   - `vscode.window.registerCustomEditorProvider()` 的工作原理
   - 自定义编辑器如何接管特定文件类型的渲染
   - 编辑器的 resolve/save/revert 生命周期

3. **Webview 的 DOM 结构**：
   - Webview 是用 `<iframe>` 还是 `<webview>` 标签？
   - 多个 Webview 并存时的性能影响
   - Webview 的主题集成（是否能感知 VSCode 的主题变化）

### 报告要求
- 给出 Webview 创建到销毁的完整生命周期
- 确认 Webview 的隔离级别和安全模型
- 估算在 Synapse 中实现类似机制的复杂度

---

## 4. 主题与外观系统

Synapse 需要实现 Glassmorphism 磨砂风格 + 自定义背景图，需要理解 VSCode 的主题机制。

### 需要探索的内容

1. **CSS 变量系统**：
   - VSCode 使用了哪些核心 CSS 变量来定义主题颜色？
   - 主题切换是如何实现的（动态修改 CSS 变量？）
   - 自定义主题的加载机制

2. **背景定制**：
   - VSCode 是否原生支持背景图？
   - Antigravity/Windsurf 是如何在 VSCode 基础上添加自定义背景的（如果有的话）
   - 实现全局背景图 + 磨砂透明面板的 CSS 策略

### 报告要求
- 列出关键的 CSS 变量名
- 提供主题加载和切换的流程图

---

## 5. 设置系统（Settings）

Synapse 需要一个设置面板来配置 API/KEY、模型、主题、背景等。

### 需要探索的内容

1. **Settings UI**：
   - VSCode 的设置页面是如何渲染的（原生 DOM？Webview？）
   - 设置项是如何定义和注册的（`contributes.configuration`？）
   - 设置的搜索和分类机制

2. **配置存储**：
   - 用户设置存储在哪里（`settings.json`）
   - 工作区设置 vs 用户全局设置的优先级
   - 配置变更的监听机制

### 报告要求
- 给出配置系统的分层架构（默认 → 用户 → 工作区）
- 标注配置文件的存储路径和格式

---

## 通用要求

1. **所有报告写到 `Synapse/Report_1_xxx.md` 系列文件中**
2. **附带代码片段、截图、和文件路径引用**
3. **重点关注"Synapse 如何实现"的可行性分析**，而不只是"VSCode 是怎么做的"
4. **优先级**：布局系统 > Webview > 工具系统 > 主题 > 设置（按 Synapse 的核心需求排序）
5. **在记忆系统（MCP memory-store）中记录关键发现**，方便本窗口的 AI 读取

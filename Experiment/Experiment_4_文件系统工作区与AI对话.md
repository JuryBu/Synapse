# Experiment 4: 文件系统、工作区与 AI 对话逆向

## 目标

逆向分析 Antigravity IDE 的文件系统管理、工作区模型、以及 AI 对话界面（Cascade）的实现。**Synapse 需要一个课程工作区管理系统和一个强大的 AI 对话界面。**

---

## 1. 文件资源管理器 (File Explorer)

### 需要探索的内容

1. **树形视图 (TreeView)**：
   - VSCode 的 Explorer 使用什么 TreeView 实现？
   - 树节点的数据模型（TreeItem）
   - 虚拟列表的滚动性能优化
   - 文件图标主题（File Icon Theme）的实现

2. **文件操作**：
   - 文件的创建、删除、重命名、移动操作的 API
   - 拖放(Drag & Drop)的实现
   - 多选和批量操作
   - 文件变更的监听机制（FileSystemWatcher）

3. **搜索系统**：
   - 文件搜索（Quick Open, Ctrl+P）的实现
   - 内容搜索（Search across files, Ctrl+Shift+F）的实现
   - 搜索索引的构建策略

### 报告要求
- 给出 TreeView 组件的核心 API
- 标注文件操作的事件流
- 评估 Synapse 的课件文件管理方案

---

## 2. 工作区模型 (Workspace Model)

Synapse 的"课程工作区"是核心概念——对应 VSCode 的 Workspace。

### 需要探索的内容

1. **工作区的定义**：
   - 单文件夹工作区 vs 多根工作区（Multi-root Workspace）
   - `.code-workspace` 文件的格式和加载机制
   - 工作区的打开/切换流程

2. **工作区状态管理**：
   - 工作区级别的配置隔离
   - 工作区的持久化存储（扩展的 `workspaceState`）
   - 最近使用的工作区列表

3. **工作区事件**：
   - 工作区打开/关闭事件
   - 文件夹添加/移除事件（多根工作区）
   - 工作区配置变更事件

### 报告要求
- 给出工作区模型的完整数据结构
- 画出工作区切换的状态机
- 设计 Synapse 的"课程工作区"数据模型

---

## 3. AI 对话界面 (Cascade Panel)

Synapse 的右侧是 AI 对话区域，对应 Antigravity 的 Cascade 面板。这是最重要的 UI 参考。

### 需要探索的内容

1. **Cascade 面板的架构**：
   - Cascade 是以什么形式存在的？（Sidebar View? Webview? 独立面板?）
   - 面板的 DOM 结构
   - 对话消息的渲染方式（Markdown 渲染器、代码高亮、LaTeX 等）

2. **输入框系统**：
   - 多模态输入的实现（文本 + 图片 + 文件）
   - 输入框的富文本编辑（@提及、文件引用等）
   - Planning / Fast 模式切换的 UI 实现
   - 模型选择器的 UI

3. **消息流渲染**：
   - Streaming 响应的实时渲染
   - 工具调用的折叠展示
   - 代码块的语法高亮和一键复制
   - 图片和文件附件的展示

4. **对话管理**：
   - 对话历史的存储和加载
   - 新建对话 / 切换对话的流程
   - 对话的导出和搜索

### 报告要求
- 截图并标注 Cascade 面板的各个 UI 元素
- 给出消息渲染的组件层次结构
- 推荐 Synapse 对话界面的技术方案（React 组件库 + Markdown 渲染器选型）

---

## 4. AI Agent 的 Planning/Fast 模式

Synapse 需要支持两种 Agent 执行模式。

### 需要探索的内容

1. **模式差异**：
   - Planning 模式和 Fast 模式在 AI 行为上的具体差异
   - 模式是如何传达给 AI 的（系统提示不同？温度不同？模型不同？）
   - 用户切换模式的 UI 交互

2. **Agent 架构**：
   - AI 的单轮执行流程（用户输入 → 系统提示组装 → 模型调用 → 工具执行 → 结果返回）
   - 多轮 Agentic 循环的控制逻辑（AI 可以连续调用多个工具）
   - 上下文窗口管理（对话过长时的截断/压缩策略）
   - Token 使用的追踪和展示

### 报告要求
- 给出 Agent 单轮执行的序列图
- 分析 Planning vs Fast 模式的具体实现差异
- 推荐 Synapse 的 Agent 循环实现架构

---

## 5. 上下文注入机制

Synapse 的核心区别：AI 需要感知当前工作区的课件内容。

### 需要探索的内容

1. **系统提示的构建**：
   - Antigravity 的系统提示是如何构建的？
   - 哪些上下文信息会被自动注入？（打开的文件？光标位置？工作区结构？）
   - 注入的优先级和截断策略

2. **@提及系统**：
   - `@file`、`@folder`、`@conversation` 等提及的实现
   - 提及内容的解析和注入方式
   - 自动补全(Autocomplete)的触发和渲染

3. **隐式上下文（EPHEMERAL_MESSAGE）**：
   - 系统自动注入的上下文消息
   - 这些消息在用户界面中是否可见
   - 注入的时机和条件

### 报告要求
- 画出系统提示的完整构建流程
- 列出所有自动注入的上下文类型
- 设计 Synapse 的课件上下文注入策略

---

## 通用要求

1. **报告文件**：`Synapse/Report_4_xxx.md` 系列
2. **截图**：所有 UI 相关内容附带截图
3. **重点**：AI 对话界面 + 上下文注入是最高优先级
4. **记忆标签**：`synapse`, `ide-reverse`, `experiment-4`, `cascade`, `workspace`
5. **优先级**：AI 对话界面 > 上下文注入 > 工作区 > 文件管理

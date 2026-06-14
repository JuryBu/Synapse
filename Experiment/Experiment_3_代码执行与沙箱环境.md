# Experiment 3: 代码执行与沙箱环境逆向

## 目标

逆向分析 Antigravity IDE 的代码执行环境，理解终端集成、代码沙箱、本地服务器管理的实现方式。**Synapse 需要一个安全的代码执行环境，让 AI 能运行代码生成可视化内容。**

---

## 1. 集成终端 (Integrated Terminal)

### 需要探索的内容

1. **终端模拟器**：
   - VSCode 使用的终端模拟器是什么？（xterm.js？）
   - 终端进程的创建和管理
   - 多终端实例的并发管理
   - 终端的输入输出流处理

2. **终端与扩展的集成**：
   - `vscode.window.createTerminal()` 的内部实现
   - 扩展如何向终端发送命令
   - 终端输出的捕获和解析
   - `run_command` 工具实际是如何创建和管理终端的

3. **终端 Profile**：
   - 不同 Shell（PowerShell、CMD、Bash）的选择机制
   - 默认 Shell 的配置
   - 环境变量的注入

### 报告要求
- 画出终端创建到销毁的完整流程
- 标注关键的进程管理 API
- 评估 Synapse 集成终端的方案（xterm.js + node-pty？）

---

## 2. 代码执行沙箱

Antigravity 有 MCP sandbox 工具来执行代码片段。我们需要理解这个沙箱的实现。

### 需要探索的内容

1. **sandbox MCP 的架构**：
   - sandbox 是作为独立进程运行的 MCP 服务器
   - 查看 sandbox MCP 的源码位置和实现语言
   - 代码执行的隔离级别（是否使用 VM / Docker / subprocess？）

2. **代码执行机制**：
   - Python 代码执行：是否启动独立 Python 进程？
   - Node.js 代码执行：是否使用 `vm` 模块或独立进程？
   - 超时管理和内存限制的实现
   - 输出的捕获和截断策略

3. **REPL Session**：
   - `sandbox_session` 是如何维护有状态的交互式会话的
   - 进程池的管理
   - 会话的超时清理

4. **安全模型**：
   - 沙箱代码能访问文件系统吗？网络呢？
   - 有没有白名单/黑名单机制
   - 崩溃恢复和资源泄漏防护

### 报告要求
- 给出 sandbox 的进程架构图
- 列出支持的编程语言和对应的执行方式
- 推荐 Synapse 的代码执行方案（重用 sandbox MCP？还是自己实现？）

---

## 3. 本地开发服务器管理

Synapse 的"展示模式"需要能运行本地的 Web 应用（HTML/JS），并在中间面板的 iframe 中展示。

### 需要探索的内容

1. **端口管理**：
   - VSCode 的端口转发(Port Forwarding)机制
   - 如何检测本地服务器启动完成
   - 端口冲突的处理

2. **Live Server 类扩展的原理**：
   - 诸如 Live Server 扩展是如何工作的
   - 静态文件服务器的实现（express？http-server？）
   - 热重载(HMR)的机制

3. **Webview 嵌入本地应用**：
   - 如何在 Webview 中加载 `localhost` 上的应用
   - 跨域限制和 CSP 策略
   - WebSocket 连接的转发

### 报告要求
- 给出"AI 生成 HTML → 启动本地服务器 → iframe 预览"的完整流程设计
- 推荐轻量级的本地服务器框架
- 评估安全风险和缓解方案

---

## 4. 文件预览与渲染器

VSCode 内置了多种文件预览器，Synapse 需要类似能力来渲染课件。

### 需要探索的内容

1. **图片预览**：
   - 内置图片查看器的实现
   - 支持的图片格式

2. **PDF 预览**：
   - VSCode 是否内置 PDF 预览？还是依赖扩展？
   - PDF 预览扩展的实现原理（pdf.js？）

3. **Markdown 预览**：
   - 内置 Markdown 预览的渲染引擎
   - Markdown 扩展（如 MathJax/KaTeX）的集成方式

4. **自定义预览器注册**：
   - 如何为新文件类型注册预览器
   - 预览器 vs 编辑器的区别
   - 只读预览 vs 可交互预览

### 报告要求
- 列出 VSCode 内置的所有文件预览器
- 给出为 PPT/DOCX 注册自定义预览器的方案
- 推荐 Synapse 的多格式渲染架构

---

## 通用要求

1. **报告文件**：`Synapse/Report_3_xxx.md` 系列
2. **代码与截图**：附带实现代码片段和架构截图
3. **重点**：可行性评估 + Synapse 推荐方案
4. **记忆标签**：`synapse`, `ide-reverse`, `experiment-3`, `sandbox`, `terminal`
5. **优先级**：代码执行沙箱 > 终端 > 本地服务器 > 文件预览

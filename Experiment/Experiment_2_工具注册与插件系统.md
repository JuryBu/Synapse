# Experiment 2: 工具注册与插件系统逆向

## 目标

逆向分析 Antigravity IDE 的工具注册机制和插件生态系统，理解 MCP、SKILL、WORKFLOW、RULES 四大系统的运行原理。**Synapse 需要实现一套等价的可扩展 AI 工具生态。**

---

## 1. VSCode 扩展系统基础

### 需要探索的内容

1. **Extension Host 架构**：
   - Extension Host 进程是如何启动的
   - 扩展的激活(Activation)机制（`activationEvents`）
   - 扩展的沙箱隔离级别（Extension Host 是否在独立进程中？）
   - 扩展之间的通信方式

2. **扩展 API 表面**：
   - `vscode` 命名空间下的核心 API 分类
   - 扩展如何注册命令（`registerCommand`）
   - 扩展如何注册视图（`registerTreeDataProvider`、`registerWebviewViewProvider`）
   - 扩展如何访问文件系统
   - 扩展如何注册语言特性（Language Features）

3. **扩展生命周期**：
   - `activate()` 和 `deactivate()` 的调用时机
   - 扩展的状态持久化（`globalState`、`workspaceState`）
   - 扩展的错误处理和崩溃恢复

4. **VSIX 打包与安装**：
   - 扩展的打包格式（VSIX）
   - 扩展的安装目录和加载流程
   - 扩展市场（Marketplace）的集成方式

### 报告要求
- 画出扩展加载流程图
- 列出扩展 manifest (`package.json`) 中与 Synapse 相关的关键 `contributes` 字段
- 评估 Synapse 实现类似扩展系统的可行方案

---

## 2. 工具系统（Tools）

Antigravity 的 AI Agent 使用一系列"工具"（view_file、replace_file_content、run_command 等）与工作区交互。我们需要理解这些工具是如何定义、注册和执行的。

### 需要探索的内容

1. **工具定义层**：
   - 工具的 Schema 是在哪里定义的？（Extension 的 `package.json`？LS 内部？）
   - 每个工具的参数类型定义
   - 工具的发现机制（AI 是如何知道有哪些工具可用的？）

2. **工具执行层**：
   - 工具调用从 AI 返回后，是如何触发执行的？
   - 执行结果是如何返回给 AI 的？
   - 工具执行的权限控制（SafeToAutoRun 等审批机制）

3. **核心内置工具分析**（以下每个工具都需要分析其实现原理）：
   - `view_file` — 文件读取
   - `replace_file_content` / `multi_replace_file_content` — 文件编辑
   - `write_to_file` — 文件创建
   - `run_command` — 命令执行
   - `find_by_name` — 文件搜索（fd）
   - `grep_search` — 内容搜索（ripgrep）
   - `list_dir` — 目录列表
   - `browser_subagent` — 浏览器操作

4. **工具结果的 UI 展示**：
   - 工具调用在 Cascade 面板中是如何渲染的（折叠、展开、高亮等）
   - Diff View 是如何生成的（文件修改的差异展示）
   - Auto Accept 机制的实现

### 报告要求
- 列出所有已知工具的名称、参数、返回值格式
- 画出工具调用的完整链路（AI输出 → 解析 → 执行 → 结果返回 → UI展示）
- 标注哪些工具可以在 Synapse 中复用，哪些需要重新实现

---

## 3. MCP（Model Context Protocol）系统

MCP 是 Antigravity 的核心扩展机制之一。Synapse 需要实现等价的 MCP 集成。

### 需要探索的内容

1. **MCP 服务器发现与启动**：
   - MCP 配置文件的位置和格式（`mcp.json` 等）
   - MCP 服务器的启动方式（stdio / HTTP SSE）
   - 服务器进程的生命周期管理
   - 多个 MCP 服务器的并发管理

2. **MCP 协议实现**：
   - Tool 的注册和调用协议
   - Resource 的发布和订阅协议
   - Prompt 的注册和使用
   - MCP 服务器与客户端的消息格式

3. **MCP 在 Cascade 中的集成**：
   - MCP 工具是如何暴露给 AI 的（系统提示注入？动态工具列表？）
   - MCP 工具调用结果的处理
   - MCP 服务器的健康检查和重连机制

4. **配置管理**：
   - 全局 MCP 配置 vs 工作区 MCP 配置
   - MCP 服务器的环境变量传递
   - MCP 服务器的权限配置

### 报告要求
- 给出 MCP 配置文件的完整 schema
- 画出 MCP 服务器的生命周期图
- 提供一个最小化 MCP 服务器的实现示例
- 评估 Synapse 集成 MCP 的架构方案

---

## 4. SKILL 系统

SKILL 是指令增强系统——一组技能文件夹，包含 `SKILL.md` 和辅助脚本/模板。

### 需要探索的内容

1. **SKILL 的发现与加载**：
   - SKILL 文件夹的搜索路径（全局？工作区？）
   - `SKILL.md` 的 frontmatter 格式（name, description 等）
   - SKILL 是如何被 AI 选择和触发的（基于 description 的模糊匹配？精确匹配？）

2. **SKILL 的执行模式**：
   - AI 读取 SKILL.md 后如何执行其中的指令
   - 辅助脚本（scripts/）是如何被调用的
   - SKILL 的上下文注入机制

3. **SKILL 的目录结构**：
   ```
   skills/
     skill-name/
       SKILL.md          # 必须，主指令文件
       scripts/           # 可选，辅助脚本
       examples/          # 可选，参考实现
       resources/         # 可选，额外资源
   ```
   验证这个结构是否正确，是否有其他约定

### 报告要求
- 确认 SKILL 系统的完整实现流程
- 给出 SKILL.md 的最小模板
- 分析 Synapse 中 SKILL 系统与学习场景的适配方案

---

## 5. WORKFLOW 系统

WORKFLOW 是预定义的步骤序列，用 `/slash-command` 触发。

### 需要探索的内容

1. **WORKFLOW 的定义格式**：
   - frontmatter 中的字段（description 等）
   - 步骤的编写规范
   - `// turbo` 和 `// turbo-all` 注解的实现

2. **WORKFLOW 的触发与执行**：
   - 用户输入 `/command` 时如何匹配到对应 workflow
   - 步骤是逐步执行还是一次性注入
   - 步骤执行中的变量替换和条件分支

3. **存储位置**：
   - `{.agents,.agent,_agents,_agent}/workflows/` 的发现机制

### 报告要求
- 给出 WORKFLOW 的完整 schema
- 分析 Synapse 中 WORKFLOW 的应用场景（如"一键生成课程笔记"等学习相关工作流）

---

## 6. RULES 系统

RULES 是注入 AI 系统提示的用户自定义规则。

### 需要探索的内容

1. **RULES 的加载机制**：
   - 全局规则文件位置（`.gemini/` 下？用户目录下？）
   - 工作区规则文件位置
   - 规则文件的格式和命名约定

2. **RULES 的注入方式**：
   - 规则是如何被注入到 AI 的系统提示中的
   - 多条规则的优先级和冲突处理
   - 规则的实时生效机制（修改后是否需要重启？）

### 报告要求
- 找到所有规则文件的位置和格式
- 确认规则注入的时机（每次对话？每次请求？）
- 设计 Synapse 中 RULES 系统的等价物（如"课程特定的 AI 行为规则"）

---

## 通用要求

1. **报告文件**：`Synapse/Report_2_xxx.md` 系列
2. **代码片段**：附带关键实现的源码片段和文件路径
3. **可行性评估**：每个小节都需要给出 Synapse 实现该功能的推荐方案和难度评估（简单/中等/困难）
4. **记忆系统**：关键发现写入 MCP memory-store，workspace 设为 `C:\Users\Stardust\Desktop\VC工具包`，标签包含 `synapse`, `ide-reverse`, `experiment-2`
5. **优先级排序**：MCP > 工具系统 > SKILL > WORKFLOW > RULES > 扩展基础

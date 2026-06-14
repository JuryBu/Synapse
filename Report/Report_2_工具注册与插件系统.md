# Report 2: 工具注册、MCP 与插件系统

> Experiment 2 核心报告 — Extension Host、工具系统、MCP/SKILL/WORKFLOW/RULES。

---

## 1. VSCode 扩展系统架构

### Extension Host 进程模型

```
Main Process
  └── Extension Host Process (独立 Node.js 进程)
       ├── bootstrap-fork.js (159KB) — 扩展加载器
       ├── 加载 antigravity 扩展 → dist/extension.js (3MB)
       ├── 加载内置扩展 × ~100
       └── 加载用户安装扩展
```

### 扩展激活机制

`antigravity` 扩展使用 `"activationEvents": ["*"]`（始终激活）。

标准流程：
1. Extension Host 进程启动
2. 读取扩展的 `package.json`
3. 检查 `activationEvents` 条件
4. 调用扩展的 `activate()` 函数
5. 注册 commands、views、providers 等
6. IDE 关闭时调用 `deactivate()`

### 扩展 API 表面

从 extension.js 使用情况统计：
- `registerCommand` — 命令注册（22个命令）
- `registerCustomEditorProvider` — 自定义编辑器（workflowEditor, ruleEditor）
- `WorkspaceEdit` (19处) — 工作区文件操作
- `selectionRange` (12处) — 选区获取
- `diagnostics` (37处) — 诊断信息
- `createTerminal` (3处) — 终端创建
- `sendText` (5处) — 终端命令发送
- `openTextDocument` — 打开文本文档

---

## 2. 内置工具系统

### 工具定义与执行链路

```
AI 模型输出
  → LS 解析 tool_call JSON
  → Extension Host 接收工具调用请求
  → 执行对应的工具处理函数
  → 返回结果给 LS
  → LS 将结果注入下一轮对话
```

### 核心内置工具清单

| 工具 | 功能 | 实现层 |
|---|---|---|
| `view_file` | 读取文件内容 | Extension Host (fs.readFile) |
| `replace_file_content` | 替换文件内容 | Extension Host (WorkspaceEdit) |
| `multi_replace_file_content` | 多处替换 | Extension Host (WorkspaceEdit) |
| `write_to_file` | 创建新文件 | Extension Host (fs.writeFile) |
| `run_command` | 执行终端命令 | Extension Host (createTerminal + sendText) |
| `find_by_name` | 文件搜索 | fd 命令行工具 |
| `grep_search` | 内容搜索 | @vscode/ripgrep |
| `list_dir` | 目录列表 | Extension Host (fs.readdir) |
| `browser_subagent` | 浏览器操作 | antigravity-browser-launcher 扩展 |
| `read_url_content` | URL 内容获取 | HTTP 请求 |
| `generate_image` | 图片生成 | AI API 调用 |
| `search_web` | 网页搜索 | 搜索 API |
| `notify_user` | 用户通知 | UI 层 |
| `task_boundary` | 任务边界 | UI 层 |

### 工具审批机制

- `SafeToAutoRun: true` — 自动执行
- `SafeToAutoRun: false` — 需要用户确认（弹出审批 UI）
- Diff View 展示文件修改差异

---

## 3. MCP 系统

### 配置文件位置

**全局配置**: `~/.gemini/antigravity/mcp_config.json`

实际配置示例：
```json
{
    "mcpServers": {
        "web-fetcher": {
            "command": "node",
            "args": ["~/.gemini/antigravity/mcp-web-fetcher/dist/index.js"],
            "env": {},
            "disabled": false
        },
        "sequential-thinking": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"],
            "env": {}
        },
        "memory-store": {
            "command": "node",
            "args": ["~/.gemini/antigravity/mcp-memory-store/dist/index.js"],
            "env": {},
            "disabled": false
        },
        "sandbox": {
            "command": "node",
            "args": ["~/.gemini/antigravity/mcp-sandbox/dist/index.js"],
            "env": {}
        }
    }
}
```

### MCP 服务器生命周期

```
IDE 启动 / 对话开始
  → 读取 mcp_config.json
  → 对每个未 disabled 的服务器:
       → spawn(command, args, { env, stdio: 'pipe' })
       → stdio 模式: JSON-RPC over stdin/stdout
       → 注册服务器的 tools, resources, prompts
  → AI 对话中:
       → 工具列表动态包含 MCP 工具
       → AI 调用 MCP 工具时 → JSON-RPC 请求 → MCP 服务器处理 → 返回结果
  → 对话结束 / IDE 关闭
       → 终止 MCP 服务器进程
```

### MCP 配置 Schema

```json
{
    "mcpServers": {
        "<serverName>": {
            "command": "string",         // stdio 模式：启动命令
            "args": ["string"],          // 命令参数
            "env": {"KEY": "VALUE"},     // 环境变量
            "serverUrl": "string",       // HTTP SSE 模式：服务器 URL
            "disabled": false,           // 是否禁用
            "disabledTools": ["string"], // 禁用的工具列表
            "headers": {"KEY": "VALUE"}  // HTTP 请求头
        }
    }
}
```

---

## 4. SKILL 系统

### 存储位置

**全局**: `~/.gemini/antigravity/skills/`

当前安装的技能（17个）：
```
skills/
  ├── algorithmic-art/SKILL.md
  ├── brand-guidelines/SKILL.md
  ├── canvas-design/SKILL.md
  ├── doc-coauthoring/SKILL.md
  ├── docx/SKILL.md
  ├── frontend-design/SKILL.md
  ├── internal-comms/SKILL.md
  ├── mcp-builder/SKILL.md
  ├── pdf/SKILL.md
  ├── pptx/SKILL.md
  ├── skill-creator/SKILL.md
  ├── slack-gif-creator/SKILL.md
  ├── theme-factory/SKILL.md
  ├── web-artifacts-builder/SKILL.md
  ├── webapp-testing/SKILL.md
  └── xlsx/SKILL.md
```

### 工作原理

1. IDE 启动时扫描 `skills/` 目录
2. 读取每个 `SKILL.md` 的 frontmatter（name, description）
3. 构建技能清单注入系统提示
4. AI 根据用户请求匹配 description，决定是否调用技能
5. 调用时 AI 使用 `view_file` 读取完整 SKILL.md 指令
6. 按照指令中的步骤执行

### SKILL.md 模板

```yaml
---
name: skill-name
description: 何时使用此技能的描述
---

# 技能名称

## 使用场景
...

## 执行步骤
1. ...
2. ...
```

---

## 5. WORKFLOW 系统

### 存储位置

- **全局**: `~/.gemini/antigravity/global_workflows/`
- **工作区**: `{.agents,.agent,_agents,_agent}/workflows/`

### Custom Editor 集成

Workflow 文件被 `antigravity.workflowEditor` 自定义编辑器接管：
```json
"filenamePattern": "**/.agent/workflows/**/*.md"
```

### 工作原理

1. AI 系统提示中包含可用 workflow 列表
2. 用户输入 `/command` 触发匹配
3. AI 使用 `view_file` 读取对应 workflow 文件
4. 按步骤执行，`// turbo` 标注的步骤自动执行

---

## 6. RULES 系统

### 存储位置

- **全局**: `~/.gemini/GEMINI.md`（20KB）— 用户全局规则
- **工作区**: `{.agents,.agent}/rules/**/*.md`

### Custom Editor

Rules 文件被 `antigravity.ruleEditor` 自定义编辑器接管：
```json
"filenamePattern": "**/.agent/rules/**/*.md"
```

### 注入机制

全局规则在每次对话开始时注入到 AI 系统提示的 `<user_rules>` 段中。

---

## 7. Synapse 可行性评估

### 推荐实现方案

| 功能 | Synapse 方案 | 难度 |
|---|---|---|
| Extension Host | 简化为 Plugin Manager，不需要完整 VSCode API | ⭐⭐ |
| 内置工具 | 直接实现 view_file/write_file/run_command 等 | ⭐⭐ |
| MCP 集成 | 复用 MCP 协议，实现 stdio/HTTP 客户端 | ⭐⭐ |
| SKILL 系统 | 完整复用文件夹+SKILL.md 模式 | ⭐ |
| WORKFLOW 系统 | 完整复用 frontmatter+步骤 模式 | ⭐ |
| RULES 系统 | 全局+工作区规则注入 | ⭐ |
| Custom Editor | Webview 渲染自定义内容 | ⭐⭐ |

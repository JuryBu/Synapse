# Report 深度-3: 工具系统 Schema 与系统提示构建

> 内置工具完整参数表、系统提示组装流程和 Synapse 实现路线图。

---

## 1. 内置工具完整 Schema

### 文件操作类

#### `view_file`
```json
{
    "AbsolutePath": "string (必须)",
    "StartLine": "integer (可选, 1-indexed)",
    "EndLine": "integer (可选, 1-indexed, 包含)"
}
```
- 首次读取新文件强制 800 行
- 单次最多 800 行
- 支持二进制文件（图片/视频）

#### `write_to_file`
```json
{
    "TargetFile": "string (必须, 第一个参数)",
    "Overwrite": "boolean",
    "CodeContent": "string",
    "EmptyFile": "boolean",
    "Description": "string",
    "Complexity": "integer (1-10)",
    "IsArtifact": "boolean",
    "ArtifactMetadata": { "Summary": "string", "ArtifactType": "enum" }
}
```

#### `replace_file_content` (单块替换)
```json
{
    "TargetFile": "string (必须)",
    "TargetContent": "string (精确匹配)",
    "ReplacementContent": "string",
    "StartLine": "integer",
    "EndLine": "integer",
    "AllowMultiple": "boolean",
    "Description": "string",
    "Complexity": "integer (1-10)",
    "Instruction": "string",
    "CodeMarkdownLanguage": "string"
}
```

#### `multi_replace_file_content` (多块替换)
```json
{
    "TargetFile": "string (必须)",
    "ReplacementChunks": [
        {
            "TargetContent": "string",
            "ReplacementContent": "string",
            "StartLine": "integer",
            "EndLine": "integer",
            "AllowMultiple": "boolean"
        }
    ],
    "Instruction": "string",
    "Description": "string",
    "Complexity": "integer (1-10)"
}
```

#### `list_dir`
```json
{
    "DirectoryPath": "string (绝对路径)"
}
```
返回：每个子项的相对路径、类型(file/dir)、大小、递归子项数

#### `find_by_name`
```json
{
    "SearchDirectory": "string (必须)",
    "Pattern": "string (glob 格式)",
    "Extensions": ["string"],
    "Type": "enum(file,directory,any)",
    "MaxDepth": "integer",
    "Excludes": ["string (glob)"],
    "FullPath": "boolean"
}
```
底层使用 `fd` 命令行工具。

#### `grep_search`
```json
{
    "SearchPath": "string (必须)",
    "Query": "string (必须)",
    "Includes": ["string (glob)"],
    "MatchPerLine": "boolean",
    "CaseInsensitive": "boolean",
    "IsRegex": "boolean"
}
```
底层使用 `@vscode/ripgrep`。

### 命令执行类

#### `run_command`
```json
{
    "CommandLine": "string (必须)",
    "Cwd": "string (必须)",
    "SafeToAutoRun": "boolean",
    "WaitMsBeforeAsync": "integer (最大10000)"
}
```
关键：SafeToAutoRun=false 时需要用户审批。

#### `command_status`
```json
{
    "CommandId": "string (必须)",
    "WaitDurationSeconds": "integer (必须, 最大300)",
    "OutputCharacterCount": "integer"
}
```

#### `send_command_input`
```json
{
    "CommandId": "string (必须)",
    "Input": "string (可选, 含换行符)",
    "Terminate": "boolean (可选)",
    "WaitMs": "integer (500-10000)",
    "SafeToAutoRun": "boolean"
}
```

#### `read_terminal`
```json
{
    "ProcessID": "string (必须)",
    "Name": "string (必须)"
}
```

### AI 交互类

#### `notify_user`
```json
{
    "Message": "string (必须)",
    "PathsToReview": ["string (绝对路径)"],
    "BlockedOnUser": "boolean",
    "ShouldAutoProceed": "boolean"
}
```
只有通过此工具才能在任务模式中与用户通信。

#### `task_boundary`  
```json
{
    "TaskName": "string (第一个参数)",
    "Mode": "string (PLANNING/EXECUTION/VERIFICATION)",
    "TaskSummary": "string",
    "TaskStatus": "string",
    "PredictedTaskSize": "integer"
}
```

#### `browser_subagent`
```json
{
    "TaskName": "string",
    "Task": "string (详细任务描述)",
    "TaskSummary": "string",
    "RecordingName": "string (下划线分隔)",
    "MediaPaths": ["string"],
    "ReusedSubagentId": "string"
}
```
启动独立的 Flash 模型浏览器代理，自动录制 WebP 视频。

### 网络类

#### `read_url_content`
```json
{
    "Url": "string (必须)"
}
```
HTTP 获取，转换为 Markdown，无 JS 执行。

#### `search_web`
```json
{
    "query": "string (必须)",
    "domain": "string (可选，优先域名)"
}
```

#### `generate_image`
```json
{
    "Prompt": "string (必须)",
    "ImageName": "string (下划线命名)",
    "ImagePaths": ["string (最多3张，用于编辑)"]
}
```

### Resource 类

#### `read_resource`
```json
{
    "ServerName": "string",
    "Uri": "string"
}
```

#### `list_resources`
```json
{
    "ServerName": "string"
}
```

---

## 2. 系统提示构建流程

### 完整系统提示结构

```xml
<!-- 身份 -->
<identity>
You are Antigravity, a powerful agentic AI...
</identity>

<!-- 当前环境信息 -->
<user_information>
OS, 工作区 URI, CorpusName 映射
</user_information>

<!-- MCP 服务器列表 -->
<mcp_servers>
# memory-store
# sandbox  
# sequential-thinking
# web-fetcher
</mcp_servers>

<!-- Artifact 目录 -->
<artifacts>
Artifact Directory Path: ~/.gemini/antigravity/brain/{conversation-id}
</artifacts>

<!-- 用户规则（来自 GEMINI.md + 工作区 rules） -->
<user_rules>
<RULE[user_global]>
GEMINI.md 完整内容...
</RULE[user_global]>
</user_rules>

<!-- Workflow 列表 -->
<workflows>
- /codex: 后台调用 Codex CLI 执行任务
</workflows>

<!-- 技能列表 -->
<skills>
Available skills:
- docx (path): description...
- pdf (path): description...
...
</skills>

<!-- 知识发现系统 -->
<knowledge_discovery>
KI 系统使用说明...
</knowledge_discovery>

<!-- 历史对话摘要 -->
<persistent_context>
对话恢复机制说明...
</persistent_context>

<!-- 工具定义（每个工具完整 JSON Schema） -->
<functions>
<function>{"name":"view_file","parameters":{...}}</function>
<function>{"name":"write_to_file","parameters":{...}}</function>
...（所有内置工具 + MCP 工具）
</functions>

<!-- EPHEMERAL 实时注入 -->
<EPHEMERAL_MESSAGE>
活跃文件、光标位置、打开文件列表等
</EPHEMERAL_MESSAGE>
```

### 动态注入的上下文

每次 AI 调用时，以下上下文被动态注入：

| 上下文 | 注入方式 | 内容 |
|---|---|---|
| 活跃文档 | EPHEMERAL | 当前编辑的文件路径和语言 |
| 光标位置 | EPHEMERAL | 行号 |
| 打开文档列表 | EPHEMERAL | 所有打开的标签页 |
| 时间戳 | EPHEMERAL | 用户本地时间 |
| 对话历史 | Content | 最近的对话轮次 |
| CHECKPOINT 摘要 | Content | 压缩后的历史摘要 |
| 知识项目摘要 | Content | 相关 KI 的概要信息 |
| Artifact 列表 | Content | 已创建的 artifact 文件 |
| 编辑/查看文件记录 | Content | 最近操作的文件列表和学习记录 |

---

## 3. Synapse 系统提示构建路线图

### 推荐的系统提示结构

```xml
<identity>
你是 Synapse 学习助手，帮助用户理解课件内容...
</identity>

<user_information>
用户信息、课程工作区
</user_information>

<course_context>
当前课程概要、章节结构、RAG 索引摘要
</course_context>

<learning_rules>
<RULE[global]>
用户全局学习偏好 (SYNAPSE.md)
</RULE[global]>
<RULE[course]>
课程特定规则
</RULE[course]>
</learning_rules>

<skills>
课件分析、出题、笔记等技能清单
</skills>

<workflows>
/start-course, /review, /practice, /export
</workflows>

<functions>
内置工具 + MCP 工具 Schema
</functions>

<EPHEMERAL>
当前查看的课件页面/章节
</EPHEMERAL>
```

---

## 4. Synapse 技术实现优先级

| 优先级 | 系统 | 复杂度 | 方案 |
|---|---|---|---|
| P0 | **AI 通信层** | ⭐⭐⭐ | 直接 API/KEY 调用，SSE 流式 |
| P0 | **系统提示构建** | ⭐⭐ | 模板 + 动态注入 |
| P0 | **消息渲染** | ⭐ | react-markdown 管线直接复用 |
| P1 | **MCP 客户端** | ⭐⭐ | stdio JSON-RPC，复用 SDK |
| P1 | **RULES 注入** | ⭐ | 读取 Markdown 注入提示 |
| P1 | **SKILL 系统** | ⭐ | 扫描目录 + frontmatter |
| P1 | **WORKFLOW 系统** | ⭐ | frontmatter + turbo 注解 |
| P2 | **工具执行框架** | ⭐⭐⭐ | 工具调用解析 + 结果返回 + 循环 |
| P2 | **终端集成** | ⭐⭐ | xterm.js + node-pty |
| P3 | **Extension Host** | ⭐⭐⭐⭐ | 简化版插件管理器 |

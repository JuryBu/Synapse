# Report 深度-2: SKILL / WORKFLOW / RULES 系统实现

> 深度分析三大可扩展系统的文件格式、加载链路、注入机制和触发逻辑。

---

## 1. 系统资源类型枚举

从 extension.js 中发现的完整资源类型枚举：

```javascript
// 资源类型枚举 (Proto 定义)
enum ResourceType {
    UNSPECIFIED = 0,
    RULES = 1,
    WORKFLOWS = 2,
    GLOBAL_WORKFLOWS = 3,
    SKILLS = 4,
    GLOBAL_SKILLS = 5,
    AGENT = 6,
    GLOBAL_AGENT = 7,
    PLUGIN = 8,
    GLOBAL_PLUGIN = 9
}
```

**关键发现：** 所有可扩展资源分为**工作区级**和**全局级**两个层次。

---

## 2. SKILL 系统

### 文件格式

```yaml
---
name: skill-name
description: "触发条件描述，AI 根据此决定是否使用此技能"
license: Proprietary. LICENSE.txt has complete terms
---

# 技能标题

## Overview
技能概述...

## Quick Reference
| Task | Approach |
|------|----------|
| 读取 | 方法 A |
| 创建 | 方法 B |

## 详细步骤
1. 步骤一...
2. 步骤二...
```

### 存储位置

| 级别 | 路径 | 类型枚举 |
|---|---|---|
| 全局 | `~/.gemini/antigravity/skills/` | `GLOBAL_SKILLS = 5` |
| 工作区 | *未使用* | `SKILLS = 4` |

### 加载链路

```
IDE 启动
  → GetAllSkillsRequest (Proto RPC)
  → LS 扫描 ~/.gemini/antigravity/skills/ 目录
  → 每个子目录读取 SKILL.md 的 frontmatter
  → 提取 name + description
  → GetAllSkillsResponse → 返回技能清单
  → 清单注入 AI 系统提示 <skills> 段
```

### 系统提示注入格式

```xml
<skills>
Available skills:
- algorithmic-art (path/to/SKILL.md): Creating algorithmic art...
- docx (path/to/SKILL.md): Use this skill whenever the user wants...
- pdf (path/to/SKILL.md): Use this skill whenever the user wants...
...
</skills>
```

### 触发机制

1. AI 收到用户请求
2. AI 对比 `<skills>` 列表中每个技能的 description
3. 如果匹配，AI 调用 `view_file` 读取完整 SKILL.md
4. 按 SKILL.md 中的步骤执行

### 技能结构（实际已安装 17 个）

| 技能名 | 类型 | 额外资源 |
|---|---|---|
| `algorithmic-art` | 代码生成 | `templates/generator_template.js`, `viewer.html` |
| `brand-guidelines` | 设计规范 | — |
| `canvas-design` | 视觉设计 | `canvas-fonts/` (30+ 字体文件) |
| `doc-coauthoring` | 文档协作 | — |
| `docx` | Word 文档 | — |
| `frontend-design` | 前端设计 | — |
| `internal-comms` | 内部沟通 | — |
| `mcp-builder` | MCP 开发 | — |
| `pdf` | PDF 处理 | — |
| `pptx` | 演示文稿 | — |
| `skill-creator` | 技能创建 | — |
| `slack-gif-creator` | GIF 制作 | — |
| `theme-factory` | 主题工厂 | — |
| `web-artifacts-builder` | Web 组件 | — |
| `webapp-testing` | Web 测试 | `scripts/with_server.py` |
| `xlsx` | 电子表格 | — |

### Synapse 复用方案

**完全复用**此模式：
1. 在 Synapse 中创建 `skills/` 目录
2. 每个技能一个子目录 + SKILL.md
3. 系统启动时扫描并构建清单
4. 清单注入到系统提示

---

## 3. WORKFLOW 系统

### 文件格式

```yaml
---
description: 工作流描述（用于 AI 匹配）
---

# 工作流标题

## 步骤

1. 步骤一描述
// turbo
2. 步骤二（自动执行，不需用户确认）
3. 步骤三
// turbo-all  ← 如果出现此注解，所有步骤都自动执行
```

### 存储位置

| 级别 | 路径 | 类型枚举 |
|---|---|---|
| 全局 | `~/.gemini/antigravity/global_workflows/` | `GLOBAL_WORKFLOWS = 3` |
| 工作区 | `.agents/workflows/*.md` 或 `.agent/workflows/*.md` | `WORKFLOWS = 2` |

### 加载链路

```
IDE 启动 / 工作区切换
  → 扫描全局 global_workflows/ 目录
  → 扫描工作区 .agents/workflows/ 目录
  → 读取每个 .md 文件的 frontmatter
  → 提取文件名(去 .md) 作为 slash command 名
  → 提取 description 作为匹配描述
  → 构建 workflow 清单
  → 注入到 AI 系统提示 <workflows> 段
```

### 系统提示注入格式

```xml
<workflows>
- /codex: 后台调用 Codex CLI 执行任务（非阻塞）
</workflows>
```

### 触发方式

1. **用户触发**: 输入 `/codex` 等 slash command
2. **AI 匹配**: AI 根据 description 自动决定是否使用
3. AI 调用 `view_file` 读取完整 workflow 文件
4. 按步骤执行，`// turbo` 标注的 `run_command` 步骤自动执行

### `// turbo` 注解实现

```
解析 workflow Markdown：
  for each step:
    if 前一行是 "// turbo":
      → SafeToAutoRun = true （自动执行，不需用户确认）
    if 文件中任何位置有 "// turbo-all":
      → 所有 run_command 步骤都 SafeToAutoRun = true
```

### 实际 Workflow 示例：`codex.md`

YAML frontmatter:
```yaml
description: 后台调用 Codex CLI 执行任务（非阻塞）
```

主要内容：
- Codex 特性说明（适合审核/重构/跨文件分析）
- 避免过拟合原则
- 任务文档模板（目标/背景/相关文件/输出要求）
- 执行步骤（创建文档 → 启动 Codex → 轮询结果）

---

## 4. RULES 系统

### 文件格式

**全局规则 (`GEMINI.md`)：** 纯 Markdown，内容直接注入系统提示。

```markdown
这里是用户全局规则内容...
所有内容都会被注入到 <user_rules><RULE[user_global]> 段中
```

**工作区规则：** 同样是 Markdown，位于 `.agent/rules/*.md`

### 存储位置

| 级别 | 路径 | 大小 |
|---|---|---|
| 全局 | `~/.gemini/GEMINI.md` | 20,165 bytes |
| 工作区 | `.agent/rules/**/*.md` 或 `.agents/rules/**/*.md` | 可变 |

### Custom Editor 集成

规则文件被 `antigravity.ruleEditor` 自定义编辑器接管：

```javascript
class RuleEditorProvider extends BaseCustomEditorProvider {
    viewType = "antigravity.ruleEditor";
    getEditorHTML(ext, webview, nonce) {
        return getRuleEditorHTML(ext, webview, nonce);
    }
}
```

编辑器渲染使用了 `RULE_FRONTMATTER` 常量和 `NON_CONDITIONAL_CONTENT_PLACEHOLDER`，说明规则支持条件化内容。

### 加载链路

```
IDE 启动 / 对话开始
  → GetAllRulesRequest (Proto RPC)
  → LS 读取 ~/.gemini/GEMINI.md  
  → LS 扫描工作区 .agent/rules/ 目录
  → GetAllRulesResponse → 返回所有规则内容
  → 全局规则注入 <user_rules><RULE[user_global]> 段
  → 工作区规则注入 <user_rules><RULE[workspace]> 段
```

### 系统提示注入格式

```xml
<user_rules>
<RULE[user_global]>
GEMINI.md 的完整内容
</RULE[user_global]>
</user_rules>
```

---

## 5. Proto RPC 接口

从 extension.js 中提取的关键 Proto Schema：

| Proto Schema | 功能 |
|---|---|
| `GetAllSkillsRequestSchema` | 获取所有技能 |
| `GetAllSkillsResponseSchema` | 技能列表响应 |
| `GetAllRulesRequestSchema` | 获取所有规则 |
| `GetAllRulesResponseSchema` | 规则内容响应 |
| `CopyBuiltinWorkflowToWorkspaceRequestSchema` | 复制内置 workflow 到工作区 |
| `CopyBuiltinWorkflowToWorkspaceResponseSchema` | 复制结果 |
| `GetAllCustomAgentConfigsResponseSchema` | 自定义 Agent 配置 |
| `ListMcpResourcesRequestSchema` | 列出 MCP 资源 |
| `ListMcpResourcesResponseSchema` | MCP 资源列表 |
| `InitializeCascadePanelStateRequestSchema` | 初始化 Cascade 面板 |
| `InitializeCascadePanelStateResponseSchema` | 面板状态 |
| `StartCascadeRequestSchema` | 启动 Cascade 对话 |

---

## 6. Synapse 可扩展系统设计建议

### SKILL 系统（推荐完全复用）

```
synapse/skills/
  ├── course-analyzer/SKILL.md    — 课件分析技能
  ├── quiz-generator/SKILL.md     — 出题技能
  ├── note-taker/SKILL.md         — 笔记整理技能
  ├── concept-mapper/SKILL.md     — 概念图生成技能
  └── code-tutor/SKILL.md         — 代码教学技能
```

### WORKFLOW 系统（推荐复用 + 教学化）

```
synapse/workflows/
  ├── start-course.md     — /start-course 开始新课程
  ├── review-chapter.md   — /review 复习章节
  ├── practice.md         — /practice 练习模式
  └── export-notes.md     — /export 导出笔记
```

### RULES 系统（推荐简化版）

```
~/.synapse/SYNAPSE.md     — 全局规则（学习偏好、AI 交互风格）
course/.synapse/rules/    — 课程级规则（特定学科的教学要求）
```

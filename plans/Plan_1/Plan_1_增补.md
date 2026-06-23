# Plan_1_增补: 用户审查后新增需求与架构升级

> 本文件集中记录用户最终审查中提出的 9 项新需求和 Plan 缺口。
> 详细的 Multi-AI 设计见独立文件 `Plan_1_MultiAI系统.md`。

---

## 1. VSCode 扩展完全兼容 🔴

### 方案
读取 `~/.vscode/extensions/` 目录，按兼容性分类加载：
- **✅ 完全兼容**：主题(themes)、语法高亮(grammars)、代码片段(snippets)、语言定义(languages)、文件图标(iconThemes)、调试器(debuggers/DAP)
- **⚠️ 部分兼容**：命令(commands，简单的)
- **❌ 不兼容**：TreeView、WebviewView、扩展激活事件、自定义 API

### 设置面板
新增 "🔌 VSCode 扩展" 分类：扩展列表 + 兼容性标记 + 启用/禁用 + 自动同步开关

**影响**：Plan_1_可扩展系统.md, Plan_1_设置系统.md

---

## 2. Debug 调试器（DAP 协议） 🔴

复用 VSCode 扩展中的 Debug Adapter，实现标准 DAP 客户端：
- Monaco 编辑器 gutter 断点设置
- 底部面板新增 **调试** 标签页（变量/堆栈/Watch/Console）
- 支持 Python / Node.js / C/C++ 等（取决于已安装的 DAP 扩展）
- 设置面板新增 "🐛 调试器" 分类

**影响**：Plan_1_展示模式.md, Plan_1_后端架构.md

---

## 3. Multi-AI 协作引擎 🔴

**独立文件**: 详见 `Plan_1_MultiAI系统.md`

核心要点：
- Mode.md 配置体系（全局 `~/.synapse/multi-ai/` + 工作区 `.synapse/multi-ai/`）
- 用户可创建命名模式（如 "对抗式vibe-coding"），保存复用
- mode.json 定义 Agent 拓扑（主 Agent + N 个 Subagent 节点）
- 每个节点绑定 Mode.md 角色文件 + 独立模型 + 工具白名单 + 触发时机
- 系统自带 Mode_main_agent.md / Mode_subagent.md
- 设置面板新增 "🤝 Multi-AI 协作" 分类
- AI 面板多标签（主对话 + 各子代理）

**影响**：Plan_1_AI交互层.md, Plan_1_前端架构.md, Plan_1_设置系统.md

---

## 4. 全局 / 工作区 两级设计 🔴

> **所有可配置系统都分全局和工作区两级**，工作区覆盖全局。

| 系统 | 全局位置 | 工作区位置 | 覆盖规则 |
|---|---|---|---|
| RULES | `~/.synapse/SYNAPSE.md` | `工作区/.synapse/rules.md` | 合并注入，工作区追加 |
| WORKFLOW | `~/.synapse/workflows/` | `工作区/.synapse/workflows/` | 合并，同名工作区优先 |
| SKILL | `~/.synapse/skills/` | `工作区/.synapse/skills/` | 合并，同名工作区优先 |
| MCP | `~/.synapse/mcp_config.json` | `工作区/.synapse/mcp_config.json` | 合并，工作区可增删 |
| Multi-AI | `~/.synapse/multi-ai/modes/` | `工作区/.synapse/multi-ai/` | 工作区可覆盖全局模式 |
| 设置 | `~/.synapse/settings.json` | `工作区/.synapse/settings.json` | 工作区部分覆盖全局 |

**影响**：Plan_1_可扩展系统.md, Plan_1_设置系统.md, Plan_1_后端架构.md

---

## 5. IDE 模式与教学模式切换 🟡

### 四种预设模式（设置中 "📌 系统提示注入" 类别）

| 模式 | 系统提示特征 | 默认工具 |
|---|---|---|
| 📚 教学模式 | 教学身份 + Synopsis 概要 + 学习 SKILL | 全部 |
| 💻 IDE 模式 | 开发者助手身份 + 编码规范 | 全部 |
| 🔬 研究模式 | 研究助手身份 + 文献索引 | 读取+搜索 |
| ⚙ 自定义 | 纯 SYNAPSE.md 规则 | 用户配置 |

### 注入开关（设置面板 "📌 系统提示注入"）

```typescript
interface PromptInjectionSettings {
  preset: 'teaching' | 'ide' | 'research' | 'custom';
  injectIdentity: boolean;          // AI 身份说明
  injectToolSchemas: boolean;       // 工具定义
  injectSkillList: boolean;         // 技能列表
  injectCourseContext: boolean;     // Synopsis 课件概要
  injectUserRules: boolean;         // SYNAPSE.md 规则
  injectWorkflowList: boolean;      // 工作流列表
  injectExtensionInfo: boolean;     // VSCode 扩展信息
  customSystemPrompt: string;       // 追加自定义提示
}
```

**影响**：Plan_1_设置系统.md, Plan_1_可扩展系统.md, Plan_1_AI交互层.md

---

## 6. 对话回溯与消息管理 🔴

| 操作 | UI | 实现 |
|---|---|---|
| 编辑用户消息 | ✏️ 按钮 | 修改后从该消息重发，删除后续消息 |
| 重新生成 | 🔄 按钮 | 删除该 AI 回复，重新请求 |
| 回溯到某轮 | 对话时间线 | 删除该轮之后所有消息 |
| 分支对话 | 🌿 按钮 | 从该消息分叉新对话线 |
| 文件回滚 | 回溯弹窗 | AI 每次写文件前创建 snapshot → 回溯时可同时回滚文件 |

文件快照存储在 `工作区/.synapse/snapshots/`。

**影响**：Plan_1_AI交互层.md, Plan_1_前端架构.md

---

## 7. AI 教学规划能力 🟡

### AI 自用文件系统
```
工作区/.synapse/
├── ai_plan.md          # AI 教学计划（自动生成）
├── ai_notes.md         # AI 知识笔记（跨对话持久）
├── tmp/                # 临时脚本
└── snapshots/          # 文件修改快照
```

### 内置 teaching-planner SKILL
AI 自动读取 Synopsis → 制定教学计划 → 写入 ai_plan.md → 按计划授课 → 标记进度

**影响**：Plan_1_AI交互层.md, Plan_1_可扩展系统.md

---

## 8. 工具审批 Auto Approve 🟡

设置面板新增 "🛡 安全与审批" 分类：

```typescript
interface SafetySettings {
  fileReadApproval: 'always' | 'ask' | 'never';     // 默认 always（自动）
  fileWriteApproval: 'always' | 'ask' | 'never';    // 默认 ask
  commandApproval: 'always' | 'ask' | 'never';      // 默认 ask
  networkApproval: 'always' | 'ask' | 'never';      // 默认 ask
  globalAutoApprove: boolean;                         // 默认 false
  sandboxTimeout: number;                             // 命令超时秒数 (默认 30)
  sandboxMaxMemoryMB: number;                         // 内存限制 (默认 256)
}
```

**影响**：Plan_1_设置系统.md, Plan_1_后端架构.md

---

## 9. 背景图多图管理与轮播 🟢

```typescript
interface BackgroundSettings {
  enabled: boolean;
  images: string[];                     // 多张图路径
  displayMode: 'static' | 'carousel' | 'random';
  carouselInterval: number;             // 轮播间隔秒数 (默认 300)
  transitionDuration: number;           // 切换动画 ms (默认 1000)
  transitionEffect: 'fade' | 'slide';
  blur: number;                         // 0-30px
  opacity: number;                      // 0.1-1.0
  panelOpacity: number;                 // 0.5-0.95
}
```

**影响**：Plan_1_设置系统.md

---

## 10. Fast/Planning 模式教学差异 🟡

系统提示中明确：
- **Fast**: 速通回答，基础 Markdown，不主动调用工具
- **Planning**: 深度教学，主动用 Mermaid/KaTeX/代码可视化/Showcase，主动 spawn subagent

**影响**：Plan_1_AI交互层.md

---

## 📋 设置面板总计

更新后共 **16 个分类**（之前 10 个，新增 6 个）：

| # | 分类 | 状态 |
|---|---|---|
| 1 | 🤖 AI 模型 | 原有 (已补 drawingModel) |
| 2 | 🔑 API 配置 | 原有 |
| 3 | 🤝 **Multi-AI 协作** | 🆕 新增 |
| 4 | 💬 对话管理 | 原有 |
| 5 | 📌 **系统提示注入** | 🆕 新增 |
| 6 | 🛡 **安全与审批** | 🆕 新增 |
| 7 | 🎨 外观与主题 | 原有 |
| 8 | 🖼 背景管理 | 原有 (已补轮播) |
| 9 | 📊 Synopsis 引擎 | 原有 |
| 10 | 🧩 插件与 MCP | 原有 |
| 11 | 🔌 **VSCode 扩展** | 🆕 新增 |
| 12 | 🐛 **调试器** | 🆕 新增 |
| 13 | ⌨ 快捷键 | 原有 |
| 14 | 📁 工作区 | 原有 |
| 15 | 📤 数据管理 | 原有 |
| 16 | ℹ 关于 | 原有 |

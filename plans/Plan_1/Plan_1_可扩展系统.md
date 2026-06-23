# Plan_1_可扩展系统: MCP / SKILL / WORKFLOW / RULES 实现

> 四大可扩展系统的 Synapse 适配方案，基于 IDE 逆向成果。

---

## 1. 系统总览

```
┌────────────────────────────────────────────────────────────┐
│                    AI 系统提示组装器                         │
│                                                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │   RULES   │  │  SKILLS  │  │WORKFLOWS │  │   TOOLS   │  │
│  │  规则注入  │  │  技能发现 │  │ 工作流    │  │ 内置+MCP │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
│       ↑              ↑              ↑              ↑       │
│  SYNAPSE.md     skills/        workflows/     mcp_config   │
│  + 工作区规则   SKILL.md        *.md          .json        │
└────────────────────────────────────────────────────────────┘
```

---

## 2. MCP 客户端实现

### 2.1 配置格式

```json
// ~/.synapse/mcp_config.json
{
  "servers": {
    "sandbox": {
      "command": "node",
      "args": ["~/.synapse/mcp-sandbox/dist/index.js"],
      "env": {},
      "disabled": false,
      "disabledTools": []
    },
    "web-fetcher": {
      "command": "node",
      "args": ["~/.synapse/mcp-web-fetcher/dist/index.js"],
      "env": {}
    },
    "memory-store": {
      "command": "node",
      "args": ["~/.synapse/mcp-memory-store/dist/index.js"],
      "env": {}
    }
  }
}
```

### 2.2 MCP 管理器（Electron 主进程）

```typescript
// electron/mcp/mcpManager.ts

class MCPManager {
  private servers: Map<string, MCPServerProcess> = new Map();
  
  // 启动所有配置的 MCP 服务器
  async startAll(): Promise<void>;
  
  // 启动单个服务器
  async startServer(name: string, config: MCPServerConfig): Promise<void>;
  
  // 调用工具
  async callTool(serverName: string, toolName: string, params: any): Promise<any>;
  
  // 列出服务器的所有工具
  async listTools(serverName: string): Promise<ToolDefinition[]>;
  
  // 列出所有服务器的资源
  async listResources(serverName: string): Promise<Resource[]>;
  
  // 关闭所有服务器
  async shutdownAll(): Promise<void>;
}

class MCPServerProcess {
  private proc: ChildProcess;
  private transport: StdioClientTransport;
  
  // stdin 写入 JSON-RPC request
  async sendRequest(method: string, params: any): Promise<any>;
  
  // 健康检查（ppid 心跳）
  isAlive(): boolean;
  
  // 优雅关闭
  async shutdown(): Promise<void>;
}
```

### 2.3 工具注入到系统提示

所有 MCP 工具的 JSON Schema 会被注入到 `<functions>` 段：

```xml
<functions>
  <!-- 内置工具 -->
  <function>{"name":"view_file","description":"...","parameters":{...}}</function>
  <!-- MCP 工具 (带服务器前缀) -->
  <function>{"name":"mcp_sandbox_sandbox_exec","description":"...","parameters":{...}}</function>
  <function>{"name":"mcp_web-fetcher_web_fetch_page","description":"...","parameters":{...}}</function>
</functions>
```

---

## 3. SKILL 系统

### 3.1 目录结构

```
~/.synapse/skills/                # 全局技能
  ├── course-analyzer/
  │   ├── SKILL.md               # 课件分析技能
  │   └── scripts/
  │       └── parse_slides.py
  ├── quiz-generator/
  │   └── SKILL.md               # 自动出题技能
  ├── note-taker/
  │   └── SKILL.md               # 笔记整理技能
  ├── concept-mapper/
  │   └── SKILL.md               # 概念图/知识图谱生成
  ├── code-tutor/
  │   └── SKILL.md               # 代码教学技能
  ├── exam-prep/
  │   └── SKILL.md               # 考试准备技能
  └── flashcard-maker/
      └── SKILL.md               # 闪卡生成技能
```

### 3.2 示例 SKILL.md

```yaml
---
name: quiz-generator
description: "自动出题技能。当用户说'出题'、'测试我'、'做几道题'、'练习'时触发。根据课件内容生成选择题、填空题、问答题，支持难度调节。"
---

# 自动出题技能

## 使用方式
1. 读取当前工作区的 Synopsis 概要
2. 根据用户指定的章节范围和难度出题
3. 对用户的答案进行纠正和解析

## 题目类型和比例
- 选择题 (40%): 4选1
- 填空题 (30%): 关键概念填空
- 问答题 (30%): 综合理解

## 难度分级
- 基础: 定义、概念识别
- 进阶: 应用、分析
- 挑战: 综合、评价、创造
```

### 3.3 加载流程

```typescript
// services/skills/skillLoader.ts
async function loadAllSkills(): Promise<SkillEntry[]> {
  const skillsDir = path.join(getConfigDir(), 'skills');
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  
  const skills: SkillEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!await fs.pathExists(skillMd)) continue;
    
    const content = await fs.readFile(skillMd, 'utf-8');
    const { name, description } = parseFrontmatter(content);
    skills.push({ name, description, path: skillMd });
  }
  return skills;
}
```

---

## 4. WORKFLOW 系统

### 3.1 存储位置

```
~/.synapse/global_workflows/      # 全局工作流
  └── start-course.md

course/.synapse/workflows/         # 工作区工作流
  ├── review.md
  ├── practice.md
  └── export-notes.md
```

### 4.2 示例 Workflow

```yaml
---
description: "开始新课程学习。创建工作区、上传课件、生成概要。"
---

# /start-course 开始新课程

1. 询问用户课程名称
2. 创建工作区目录
// turbo
3. 初始化工作区配置文件
4. 提示用户上传课件文件
5. 对上传的课件运行 Synopsis 引擎
6. 完成后展示课程概要和学习建议
```

### 4.3 turbo 注解实现

```typescript
function parseWorkflowSteps(markdown: string): WorkflowStep[] {
  const lines = markdown.split('\n');
  const hasTurboAll = lines.some(l => l.trim() === '// turbo-all');
  
  const steps: WorkflowStep[] = [];
  let prevLineIsTurbo = false;
  
  for (const line of lines) {
    if (line.trim() === '// turbo') {
      prevLineIsTurbo = true;
      continue;
    }
    
    const stepMatch = line.match(/^\d+\.\s+(.+)/);
    if (stepMatch) {
      steps.push({
        instruction: stepMatch[1],
        autoRun: prevLineIsTurbo || hasTurboAll,
      });
      prevLineIsTurbo = false;
    }
  }
  return steps;
}
```

---

## 5. RULES 系统

### 5.1 文件位置

```
~/.synapse/SYNAPSE.md              # 全局规则（学习偏好、AI 行为）
course/.synapse/rules/             # 课程级规则
  └── math_course.md               # 数学课程特定规则
```

### 5.2 示例全局规则（SYNAPSE.md）

```markdown
# 全局学习偏好

## AI 教学风格
- 苏格拉底式提问，引导而非直接给答案
- 解释时先给直觉，再给形式化定义
- 遇到代码示例时，先解释逻辑再展示代码
- 适当使用类比帮助理解抽象概念

## 学习习惯
- 每次学习结束后生成学习笔记摘要
- 自动标记我表示困惑的知识点
- 定期提议复习之前的薄弱点

## 语言偏好
- 使用中文教学
- 专业术语保留英文，首次出现时给出中文翻译
```

### 5.3 注入格式

```xml
<learning_rules>
  <RULE[global]>
  SYNAPSE.md 完整内容...
  </RULE[global]>
  <RULE[course:math_course]>
  math_course.md 完整内容...
  </RULE[course:math_course]>
</learning_rules>
```

---

## 6. 系统提示完整组装

```typescript
// services/ai/systemPromptBuilder.ts
function buildSystemPrompt(context: PromptContext): string {
  return `
<identity>
你是 Synapse 学习助手...
</identity>

<user_information>
${formatUserInfo(context.user)}
</user_information>

<course_context>
${formatCourseContext(context.workspace)}
</course_context>

<learning_rules>
${formatRules(context.rules)}
</learning_rules>

<mcp_servers>
${formatMCPServers(context.mcpServers)}
</mcp_servers>

<skills>
${formatSkills(context.skills)}
</skills>

<workflows>
${formatWorkflows(context.workflows)}
</workflows>

<functions>
${formatToolSchemas([...context.builtinTools, ...context.mcpTools])}
</functions>

<EPHEMERAL>
${formatEphemeral(context.activeFile, context.cursorPosition, context.openFiles)}
</EPHEMERAL>
  `.trim();
}
```

---

## 7. 内置学习技能清单（预装）

| 技能名 | 功能 | 触发关键词 |
|---|---|---|
| `course-analyzer` | 分析课件结构，生成学习路径 | "分析课件"、"学习路径" |
| `quiz-generator` | 自动出题 | "出题"、"测试我"、"练习" |
| `note-taker` | 整理学习笔记 | "整理笔记"、"总结" |
| `concept-mapper` | 生成知识图谱 | "概念图"、"知识图谱" |
| `code-tutor` | 代码教学 | "教我代码"、"编程练习" |
| `exam-prep` | 考试准备 | "备考"、"期中复习" |
| `flashcard-maker` | 生成闪卡 | "闪卡"、"卡片记忆" |
| `pdf-annotator` | PDF 标注 | "标注"、"划重点" |

---

## 8. 未来扩展：插件市场

Stage 15+ 考虑：
- 类似 VSCode Marketplace 的 Synapse 插件市场
- 社区贡献的 SKILL 和 WORKFLOW
- 一键安装/更新/卸载
- 评分和评论系统

---

## 9. VSCode 扩展兼容层

> 读取用户本地已安装的 VSCode 扩展，按兼容性分类加载。

### 9.1 扫描流程

```typescript
class ExtensionHost {
  private loadedExtensions: Map<string, LoadedExtension> = new Map();
  
  async scanExtensions(): Promise<ExtensionManifest[]> {
    const dirs = [
      path.join(os.homedir(), '.vscode', 'extensions'),    // VSCode
      path.join(os.homedir(), '.windsurf', 'extensions'),   // Windsurf
      path.join(os.homedir(), '.synapse', 'extensions'),    // Synapse 自有
    ];
    
    const manifests: ExtensionManifest[] = [];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pkgJson = path.join(dir, entry.name, 'package.json');
        if (fs.existsSync(pkgJson)) {
          manifests.push(JSON.parse(fs.readFileSync(pkgJson, 'utf8')));
        }
      }
    }
    return manifests;
  }
}
```

### 9.2 兼容性分类

| 贡献类型 | 兼容性 | Monaco 对应 |
|---|---|---|
| `themes` | ✅ 完全 | Monaco Themes API |
| `grammars` (TextMate) | ✅ 完全 | monaco-textmate |
| `snippets` | ✅ 完全 | CompletionItemProvider |
| `languages` | ✅ 完全 | monaco.languages.register |
| `iconThemes` | ✅ 完全 | CSS + 文件图标映射 |
| `debuggers` | ✅ DAP 协议 | 自建 DAP Client |
| `commands` | ⚠️ 简单命令 | 命令面板注册 |
| `menus` | ⚠️ 部分 | 右键菜单注入 |
| `views`/`viewsContainers` | ❌ 不兼容 | 需要 VSCode TreeView API |
| `webview` | ❌ 不兼容 | 需要 VSCode Webview API |
| `activationEvents` | ❌ 不兼容 | 需要 Extension Host |

### 9.3 主题加载示例

```typescript
async function loadVSCodeTheme(extensionPath: string, manifest: ExtensionManifest) {
  for (const theme of manifest.contributes.themes || []) {
    const themePath = path.join(extensionPath, theme.path);
    const themeData = JSON.parse(fs.readFileSync(themePath, 'utf8'));
    // 转换 VSCode 颜色主题 → Monaco 颜色主题
    const monacoTheme = convertToMonacoTheme(themeData);
    monaco.editor.defineTheme(theme.label, monacoTheme);
  }
}
```

---

## 10. DAP 调试器集成

> Debug Adapter Protocol (DAP) — 复用 VSCode 扩展中的 Debug Adapter。

### 10.1 架构

```
Synapse UI (断点/变量/堆栈)
    ↕ DAP 消息 (JSON)
DAP Client (electron/debug/dapClient.ts)
    ↕ stdin/stdout
Debug Adapter (VSCode 扩展自带, e.g. Python Debugger)
    ↕
被调试程序 (用户代码)
```

### 10.2 DAP Client

```typescript
class DAPClient {
  private adapter: ChildProcess;
  private seq: number = 1;
  
  async launch(adapterPath: string, launchConfig: any) {
    this.adapter = spawn('node', [adapterPath]);
    
    // 发送 Initialize
    await this.sendRequest('initialize', { adapterID: 'synapse' });
    // 发送 Launch
    await this.sendRequest('launch', launchConfig);
  }
  
  async setBreakpoints(file: string, lines: number[]) {
    await this.sendRequest('setBreakpoints', {
      source: { path: file },
      breakpoints: lines.map(l => ({ line: l })),
    });
  }
  
  async continue() { await this.sendRequest('continue', { threadId: 1 }); }
  async stepOver() { await this.sendRequest('next', { threadId: 1 }); }
  async stepInto() { await this.sendRequest('stepIn', { threadId: 1 }); }
  async stepOut()  { await this.sendRequest('stepOut', { threadId: 1 }); }
  
  async getVariables(frameId: number): Promise<Variable[]> {
    const scopes = await this.sendRequest('scopes', { frameId });
    const vars = await this.sendRequest('variables', { 
      variablesReference: scopes.body.scopes[0].variablesReference 
    });
    return vars.body.variables;
  }
}
```

### 10.3 UI 集成

- Monaco 编辑器 gutter（行号区域）点击 → 设置/取消断点（红点）
- 底部面板"调试"标签 → 变量查看、调用堆栈、Watch、Debug Console
- 工具栏 → ▶ 继续、⏭ Step Over、⤵ Step Into、⤴ Step Out、⏹ 停止

---

## 11. 全局/工作区两级统一管理

> 所有可扩展系统都支持全局 + 工作区两级配置，工作区可覆盖全局。

### 11.1 加载优先级

```typescript
class ConfigLoader<T> {
  async load(configName: string, workspacePath?: string): Promise<T> {
    // 1. 加载全局配置
    const globalConfig = this.loadFromDir(path.join(os.homedir(), '.synapse'), configName);
    
    // 2. 如果有工作区，加载工作区配置
    if (workspacePath) {
      const wsConfig = this.loadFromDir(path.join(workspacePath, '.synapse'), configName);
      // 3. 合并（工作区覆盖全局）
      return this.merge(globalConfig, wsConfig);
    }
    
    return globalConfig;
  }
}
```

### 11.2 各系统两级规则

| 系统 | 全局路径 | 工作区路径 | 合并策略 |
|---|---|---|---|
| RULES | `~/.synapse/SYNAPSE.md` | `.synapse/rules.md` | 全局 + 工作区追加 |
| SKILL | `~/.synapse/skills/` | `.synapse/skills/` | 合并，同名工作区优先 |
| WORKFLOW | `~/.synapse/workflows/` | `.synapse/workflows/` | 合并，同名工作区优先 |
| MCP | `~/.synapse/mcp_config.json` | `.synapse/mcp_config.json` | 深合并，工作区增删 |
| Multi-AI | `~/.synapse/multi-ai/modes/` | `.synapse/multi-ai/` | 工作区可覆盖全局模式 |
| 设置 | `~/.synapse/settings.json` | `.synapse/settings.json` | 工作区字段覆盖全局 |
| VSCode 扩展 | `~/.vscode/extensions/` | — | 全局共享，设置中启禁 |

### 11.3 AI 自用文件

```
工作区/.synapse/
├── ai_plan.md          # AI 教学计划（自动生成+跟踪）
├── ai_notes.md         # AI 知识笔记（跨对话持久化）
├── tmp/                # 临时脚本和可视化
└── snapshots/          # 文件修改快照（回溯用）
```

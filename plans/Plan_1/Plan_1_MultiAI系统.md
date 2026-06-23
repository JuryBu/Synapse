# Plan_1_MultiAI系统: Multi-AI 协作引擎设计

> 参考 Claude Code Agent Teams (Opus 4.6) + Windsurf Wave 13 Multi-Agent Coding。
> Synapse 在此基础上进一步：**用户可创建命名模式、通过 Mode.md 精细控制每个 Agent 角色**。

---

## 1. 核心架构

### 1.1 三层结构

```
┌─────────────────────────────────────────────────────┐
│  Multi-AI 配置层 (设置面板)                          │
│  ├── 全局模式库: ~/.synapse/multi-ai/               │
│  └── 工作区模式: 工作区/.synapse/multi-ai/           │
├─────────────────────────────────────────────────────┤
│  协作引擎层 (AgentOrchestrator)                      │
│  ├── 主 Agent 管理                                   │
│  ├── Subagent 生命周期 (spawn/monitor/terminate)     │
│  ├── 消息路由 (主→子, 子→主, 子→子可选)              │
│  └── 共享上下文管理                                   │
├─────────────────────────────────────────────────────┤
│  执行层 (AgentLoop × N)                              │
│  ├── 每个 Agent 独立 AgentLoop + 独立上下文窗口      │
│  ├── 每个 Agent 独立工具白名单                       │
│  └── 每个 Agent 独立模型配置                         │
└─────────────────────────────────────────────────────┘
```

### 1.2 与 Claude Code 的对比

| 特性 | Claude Code | Synapse |
|---|---|---|
| 子代理 | CLI spawn, 无 GUI | GUI 标签页，可视化 |
| 配置方式 | 环境变量/配置文件 | 设置面板 + Mode.md 文件系统 |
| 角色定义 | 代码内硬编码 | 用户通过 Mode.md 自由定义 |
| 模式保存 | 无 | 命名模式，全局/工作区可复用 |
| 通信模式 | 层级（子→主报告） | 层级 + 可选 P2P（子↔子） |
| 监控 | tmux 终端 | AI 面板多标签 + 状态指示 |

---

## 2. Mode.md 配置体系

### 2.1 文件系统结构

```
# 全局模式库
~/.synapse/multi-ai/
├── modes/
│   ├── 对抗式vibe-coding/
│   │   ├── mode.json             # 模式元数据
│   │   ├── Mode_1_编码者.md       # 主 Agent 角色定义
│   │   └── Mode_2_审查者.md       # Subagent 角色定义
│   ├── 深度研究/
│   │   ├── mode.json
│   │   ├── Mode_1_主研究员.md
│   │   ├── Mode_2_文献分析.md
│   │   └── Mode_3_数据验证.md
│   └── 教学协作/
│       ├── mode.json
│       ├── Mode_1_讲师.md
│       └── Mode_2_出题官.md
├── system/                        # 系统自带（不可删除，可禁用）
│   ├── Mode_main_agent.md         # 默认主 Agent 协作指南
│   └── Mode_subagent.md           # 默认 Subagent 协作指南
└── shared/                        # 所有模式共享的上下文
    └── collaboration_protocol.md  # 协作协议

# 工作区级覆盖
工作区/.synapse/multi-ai/
├── modes/
│   └── 本项目专用/
│       ├── mode.json
│       ├── Mode_1_xxx.md
│       └── Mode_2_xxx.md
└── active_mode.json               # 当前工作区激活的模式
```

### 2.2 mode.json 格式

```json
{
  "name": "对抗式vibe-coding",
  "description": "主 Agent 编码 + Subagent 对抗审查",
  "author": "user",
  "created": "2026-03-23",
  
  "agents": {
    "main": {
      "modeFile": "Mode_1_编码者.md",
      "model": null,
      "tools": "*",
      "maxRounds": 25
    },
    "subagents": [
      {
        "id": "reviewer",
        "modeFile": "Mode_2_审查者.md",
        "model": null,
        "tools": ["view_file", "grep_search", "find_by_name", "list_dir"],
        "maxRounds": 10,
        "spawnCount": 1,
        "autoSpawn": false,
        "triggerPhase": ["review", "stage_complete"]
      }
    ]
  },
  
  "collaboration": {
    "communicationMode": "hierarchical",
    "sharedContext": true,
    "subagentCanRequestMainAction": true,
    "mainReviewsSubagentOutput": true
  },
  
  "modelOverrides": {
    "main": null,
    "subagents": null
  }
}
```

### 2.3 Mode.md 文件示例

**Mode_1_编码者.md**:
```markdown
# 编码者 Agent

## 身份
你是项目的主力编码 Agent，直接与用户交互。

## 职责
- 与用户讨论需求、制定 Plan
- 编写代码、执行命令、管理文件
- 接收来自审查 Subagent 的反馈
- 对正确的反馈进行采纳更新
- 对不正确的反馈进行反驳说明

## 协作规则
- 每完成一个 Stage，自动 spawn 审查 Subagent
- Subagent 返回 Review 报告后，逐条处理
- 处理完毕后向用户汇报最终结果
- 保持谦虚但有主见，不盲目接受所有建议
```

**Mode_2_审查者.md**:
```markdown
# 审查者 Agent

## 身份
你是代码质量守门人，你的任务是找到主 Agent 工作中的问题。

## 职责
- 审查主 Agent 修改的所有文件
- 检查代码质量、逻辑错误、安全漏洞
- 验证是否符合 Plan 和 Task 要求
- 检查是否有遗漏的边界情况

## 审查标准
- 功能完整性：是否实现了所有要求？
- 代码质量：命名、结构、可读性
- 错误处理：边界情况、异常处理
- 性能：有无明显的性能问题？

## 输出格式
以结构化报告输出：
- 🔴 严重问题 (必须修复)
- 🟡 建议改进 (推荐修复)  
- 🟢 肯定亮点 (做得好的地方)
```

### 2.4 系统自带 Mode 文件

**Mode_main_agent.md**（系统默认，始终注入主 Agent）:
```markdown
# Synapse 主 Agent 协作指南

当 Multi-AI 模式激活时：
1. 你可以通过 spawn_subagent 工具创建子代理来协助工作
2. 子代理完成后会返回结构化报告
3. 你需要整合子代理的发现，向用户汇报
4. 不要把子代理的原始输出直接丢给用户，要加工整合
```

**Mode_subagent.md**（系统默认，始终注入所有 Subagent）:
```markdown
# Synapse Subagent 协作指南

你是一个专注任务的子代理：
1. 你有独立的上下文窗口，不受主对话影响
2. 完成任务后返回结构化报告给主 Agent
3. 保持报告简洁，突出关键发现
4. 你不直接与用户交互
```

---

## 3. 设置面板 Multi-AI 配置 UI

### 3.1 全局设置入口

```
┌──────────────────────────────────────────────────────┐
│  🤝 Multi-AI 协作                                    │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ☑ 启用 Multi-AI 系统          [全局开关]            │
│                                                      │
│  ── 当前激活模式 ──                                   │
│  [▼ 对抗式vibe-coding        ]  [应用] [编辑]       │
│                                                      │
│  ── 已保 存模式 ──                                    │
│  📋 对抗式vibe-coding    主+1子代理   [✏][🗑]         │
│  📋 深度研究             主+2子代理   [✏][🗑]         │
│  📋 教学协作             主+1子代理   [✏][🗑]         │
│  📋 Solo (单Agent)       仅主Agent   [默认]          │
│                                                      │
│  [+ 新建模式]                                        │
│                                                      │
│  ── 默认 Subagent 配置 ──                             │
│  Subagent 模型:    [▼ 跟随主Agent模型    ]            │
│  Subagent Token限:  [32000          ] tokens          │
│  最大并行子代理:    [3              ] 个               │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### 3.2 模式编辑器（点击 [✏] 或 [+ 新建]）

```
┌──────────────────────────────────────────────────────┐
│  编辑模式: 对抗式vibe-coding                         │
├──────────────────────────────────────────────────────┤
│                                                      │
│  模式名称:  [对抗式vibe-coding                ]      │
│  描述:      [主Agent编码+Subagent对抗审查     ]      │
│                                                      │
│  ═══ 主 Agent (Orchestrator) ═══                     │
│  Mode文件:  [Mode_1_编码者.md      ] [📂][✏编辑]    │
│  模型:      [▼ 使用全局thinkingModel]                │
│  工具权限:  [✅ 全部工具                    ]         │
│  最大轮次:  [25                              ]        │
│                                                      │
│  ═══ Subagent 节点 ═══                               │
│  ┌────────────────────────────────────┐              │
│  │ [节点1] 审查者                     │              │
│  │ Mode文件: [Mode_2_审查者.md] [📂][✏]│             │
│  │ 模型:     [▼ 使用全局fastModel   ] │              │
│  │ 工具:     [☑view ☑grep ☐write ☐cmd]│              │
│  │ 数量:     [1] 个                   │              │
│  │ 自动触发:  ☑ Stage完成时           │              │
│  │           ☑ Review阶段            │              │
│  │           ☐ 每轮对话后            │              │
│  └────────────────────────────────────┘              │
│  [+ 添加 Subagent 节点]                              │
│                                                      │
│  ═══ 协作设置 ═══                                    │
│  通信模式:   (●) 层级制  ( ) P2P对等               │
│  共享上下文:  ☑ 子代理可访问主对话的 Synopsis 概要   │
│  子代理可请求主Agent操作: ☑                           │
│  主Agent审查子代理输出: ☑                             │
│                                                      │
│  [保存] [取消] [预览系统提示]                         │
└──────────────────────────────────────────────────────┘
```

### 3.3 工作区级覆盖

```
┌──────────────────────────────────────────────────────┐
│  📁 当前工作区: 机器学习导论                          │
├──────────────────────────────────────────────────────┤
│  Multi-AI 模式:                                      │
│  (●) 使用全局设置 (对抗式vibe-coding)                │
│  ( ) 使用工作区专属模式                              │
│  ( ) 禁用 Multi-AI (仅单Agent)                      │
│                                                      │
│  [如选择工作区专属，展示同上的模式编辑器]            │
└──────────────────────────────────────────────────────┘
```

---

## 4. AI 面板 UI

### 4.1 Multi-AI 激活时的 AI 面板

```
┌──────────────────────────────────────────┐
│ [🧠 主对话] [🔍 审查#1 ⏳] [+]          │
├──────────────────────────────────────────┤
│                                          │
│  用户: 帮我写一个排序算法的可视化        │
│                                          │
│  🧠 主Agent: 好的，我来编写...           │
│  [工具调用: write_to_file sort.html]     │
│  [工具调用: write_to_file sort.js]       │
│  已完成编码，正在触发审查...             │
│                                          │
│  ┌─── Subagent 卡片 ──────────────┐     │
│  │ 🔍 审查者 #1                   │     │
│  │ 状态: ✅ 已完成                 │     │
│  │ 发现: 🔴×1  🟡×2  🟢×3        │     │
│  │ [展开查看详情 ▼]               │     │
│  └────────────────────────────────┘     │
│                                          │
│  🧠 主Agent: 审查报告已收到。            │
│  🔴 修复了冒泡排序边界条件...            │
│  🟡 采纳了变量命名建议...                │
│  已全部处理完毕！                        │
│                                          │
├──────────────────────────────────────────┤
│  [输入框]                    [发送]      │
└──────────────────────────────────────────┘
```

### 4.2 子代理标签页（点击 [🔍 审查#1]）

显示该子代理的完整独立对话过程（只读）：

```
┌──────────────────────────────────────────┐
│ [🧠 主对话] [🔍 审查#1 ✅] [+]          │
├──────────────────────────────────────────┤
│  📋 任务: 审查 sort.html, sort.js        │
│  📎 共享上下文: Synopsis 概要 (已注入)    │
│                                          │
│  🔍 审查者: 开始审查...                  │
│  [view_file sort.html]                   │
│  [view_file sort.js]                     │
│  [grep_search "edge case"]               │
│                                          │
│  审查报告:                               │
│  🔴 sort.js L23: 当 arr.length=0 时      │
│     会抛出 TypeError                     │
│  🟡 建议: bubbleSort → 改名 sortArray   │
│  🟡 建议: 添加输入验证                   │
│  🟢 亮点: 可视化动画流畅                 │
│  🟢 亮点: CSS 配色和谐                   │
│                                          │
│  ⏱ 耗时 45s  Token: 3.2k/8k             │
├──────────────────────────────────────────┤
│  [只读 - 子代理对话不可编辑]              │
└──────────────────────────────────────────┘
```

---

## 5. 后端实现

### 5.1 AgentOrchestrator

```typescript
class AgentOrchestrator {
  private mainAgent: AgentLoop;
  private subagents: Map<string, AgentLoop> = new Map();
  private modeConfig: MultiAIModeConfig;

  constructor(modeConfig: MultiAIModeConfig) {
    this.modeConfig = modeConfig;
    this.mainAgent = new AgentLoop({
      model: modeConfig.agents.main.model || settings.thinkingModel,
      systemPrompt: this.buildMainPrompt(),
      tools: this.resolveTools(modeConfig.agents.main.tools),
      maxRounds: modeConfig.agents.main.maxRounds,
    });
  }

  // 主 Agent 调用此工具创建子代理
  async spawnSubagent(config: SpawnConfig): Promise<SubagentResult> {
    const subagentDef = this.modeConfig.agents.subagents
      .find(s => s.id === config.role);
    
    const subagent = new AgentLoop({
      model: subagentDef?.model || settings.fastModel,
      systemPrompt: this.buildSubagentPrompt(subagentDef),
      tools: this.resolveTools(subagentDef?.tools || []),
      maxRounds: subagentDef?.maxRounds || 10,
    });

    // 注入共享上下文
    if (this.modeConfig.collaboration.sharedContext) {
      subagent.injectContext(this.getSharedContext());
    }

    // 注入任务
    const result = await subagent.run(config.task);
    
    // 存储子代理完整对话（供 UI 查看）
    this.subagents.set(config.id, subagent);
    
    return result;
  }

  private buildMainPrompt(): string {
    const parts: string[] = [];
    // 1. 系统默认协作指南
    parts.push(readFile('~/.synapse/multi-ai/system/Mode_main_agent.md'));
    // 2. 用户定义的 Mode 文件
    parts.push(readFile(this.modeConfig.agents.main.modeFile));
    // 3. spawn_subagent 工具 Schema
    parts.push(this.getSpawnToolSchema());
    return parts.join('\n---\n');
  }
}
```

### 5.2 spawn_subagent 工具定义

```typescript
const spawnSubagentTool: ToolDefinition = {
  name: 'spawn_subagent',
  description: '创建一个子代理来执行特定任务。子代理拥有独立上下文窗口，完成后返回结构化报告。',
  parameters: {
    task: { type: 'string', description: '分配给子代理的任务描述' },
    role: { type: 'string', description: '子代理角色 ID（与 mode.json 中定义的 subagent id 对应）' },
    sharedFiles: { type: 'string[]', description: '需要共享给子代理的文件路径列表', optional: true },
    returnFormat: { type: 'string', description: '期望的返回格式', optional: true },
  }
};
```

---

## 6. 用户使用流程示例

### 场景：对抗式 Vibe Coding

```
1. 用户打开设置 → Multi-AI → [+ 新建模式]
2. 命名 "对抗式vibe-coding"
3. 编写 Mode_1_编码者.md（或用 AI 辅助生成）
4. 编写 Mode_2_审查者.md
5. 配置子代理：1个审查者，使用 fastModel，只读工具权限
6. 设置触发时机：Stage完成时 + Review阶段
7. 保存 → 激活模式

8. 打开工作区 → 开始对话
9. 用户: "做一个 Todo 应用"
10. 主Agent: 制定 Plan → 编写代码 → 完成 Stage 1
11. 主Agent 自动 spawn 审查者 Subagent
12. 审查者读取修改的文件 → 出具 Review 报告
13. 主Agent 收到报告 → 处理反馈 → 向用户汇报
14. 用户 AI 面板可以切换标签查看审查者的完整过程
```

### 场景：深度研究模式

```
1. 用户选择预设 "深度研究" 模式
2. 用户: "帮我理解 Transformer 的注意力机制"
3. 主Agent（讲师）: 开始讲解基础概念
4. 主Agent spawn 文献分析子代理 → 搜索课件中关于注意力的内容
5. 主Agent spawn 数据验证子代理 → 验证公式推导的正确性
6. 两个子代理并行工作，各自返回报告
7. 主Agent 整合报告，给出深度、准确的讲解
```

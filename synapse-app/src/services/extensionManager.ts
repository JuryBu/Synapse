/**
 * Extension Manager — SKILL / WORKFLOW / RULES 加载器
 * 管理扩展系统的加载、注入和生命周期
 */

export interface SkillDefinition {
  name: string;
  description: string;
  triggerPatterns: string[];
  contentPath: string;
  enabled: boolean;
  sourceType: 'builtin' | 'global' | 'workspace';
  /** #17: SKILL.md 正文，由 loadRulesFromFS 每轮从 contentPath 读取并缓存；undefined 表示尚未加载或文件缺失。 */
  content?: string;
}

export interface WorkflowDefinition {
  name: string;
  description: string;
  slashCommand: string;
  steps: string[];
  turboAll?: boolean;
  contentPath: string;
  enabled: boolean;
  sourceType: 'builtin' | 'global' | 'workspace';
}

export interface RulesContent {
  global: string;
  workspace: string;
}

export interface RulesSource {
  name: string;
  description: string;
  path: string;
  sourceType: 'global' | 'workspace';
  status: 'loaded' | 'missing' | 'optional';
  contentLength: number;
}

export interface ExtensionPromptOptions {
  injectSkills?: boolean;
  injectWorkflows?: boolean;
  injectRules?: boolean;
}

// 7 pre-built learning SKILLs
const BUILT_IN_SKILLS: SkillDefinition[] = [
  {
    name: '课件解读',
    description: '深入解读课件内容，提取核心概念和知识要点',
    triggerPatterns: ['解读', '讲解', '课件内容', '这节课讲了什么'],
    contentPath: '.synapse/skills/course-reading/SKILL.md',
    enabled: true,
    sourceType: 'builtin',
  },
  {
    name: '习题辅导',
    description: '解答课后习题，提供详细解题思路和步骤',
    triggerPatterns: ['习题', '解题', '怎么做', '求解', '计算'],
    contentPath: '.synapse/skills/problem-solving/SKILL.md',
    enabled: true,
    sourceType: 'builtin',
  },
  {
    name: '知识总结',
    description: '生成知识框架、思维导图和复习大纲',
    triggerPatterns: ['总结', '复习', '大纲', '知识点', '思维导图'],
    contentPath: '.synapse/skills/knowledge-summary/SKILL.md',
    enabled: true,
    sourceType: 'builtin',
  },
  {
    name: '代码实践',
    description: '编写和调试实验代码，提供可运行的完整示例',
    triggerPatterns: ['代码', '编程', '实现', '写一个', '程序'],
    contentPath: '.synapse/skills/code-practice/SKILL.md',
    enabled: true,
    sourceType: 'builtin',
  },
  {
    name: '论文写作',
    description: '辅助学术论文写作，包括摘要、引用和格式',
    triggerPatterns: ['论文', '写作', '摘要', '引用', 'paper'],
    contentPath: '.synapse/skills/academic-writing/SKILL.md',
    enabled: true,
    sourceType: 'builtin',
  },
  {
    name: '考试准备',
    description: '生成模拟试卷、错题分析和考前冲刺计划',
    triggerPatterns: ['考试', '模拟题', '错题', '冲刺', '备考'],
    contentPath: '.synapse/skills/exam-prep/SKILL.md',
    enabled: true,
    sourceType: 'builtin',
  },
  {
    name: '学习规划',
    description: '制定个性化学习计划，追踪学习进度',
    triggerPatterns: ['学习计划', '进度', '规划', '时间表', '安排'],
    contentPath: '.synapse/skills/study-planner/SKILL.md',
    enabled: true,
    sourceType: 'builtin',
  },
];

const BUILT_IN_WORKFLOWS: WorkflowDefinition[] = [
  {
    name: '快速复习',
    description: '一键生成当前工作区所有课件的复习大纲',
    slashCommand: '/review',
    steps: [
      '1. 获取工作区所有课件文件列表',
      '2. 对未生成概要的文件运行 Synopsis',
      '3. 将所有概要汇总为复习大纲',
      '4. 标注重点和难点',
    ],
    contentPath: '~/.synapse/global_workflows/review.md',
    enabled: true,
    sourceType: 'builtin',
  },
  {
    name: '错题收集',
    description: '将当前对话中的习题和解答整理到笔记',
    slashCommand: '/collect',
    steps: [
      '1. 提取对话中的题目和解答',
      '2. 按知识点分类',
      '3. 写入错题整理文件',
    ],
    contentPath: '~/.synapse/global_workflows/collect.md',
    enabled: true,
    sourceType: 'builtin',
  },
];

class ExtensionManager {
  private skills: SkillDefinition[] = [...BUILT_IN_SKILLS];
  private workflows: WorkflowDefinition[] = [...BUILT_IN_WORKFLOWS];
  private globalRules: string = '';
  private workspaceRules: string = '';
  private rulesSources: RulesSource[] = [
    {
      name: 'SYNAPSE.md',
      description: '全局用户规则，可选文件。',
      path: '~/.synapse/SYNAPSE.md',
      sourceType: 'global',
      status: 'missing',
      contentLength: 0,
    },
    {
      name: 'workspace rules.md',
      description: '当前工作区规则，可选文件。',
      path: '.synapse/rules.md',
      sourceType: 'workspace',
      status: 'missing',
      contentLength: 0,
    },
  ];

  getSkills(): SkillDefinition[] {
    return this.skills;
  }

  getEnabledSkills(): SkillDefinition[] {
    return this.skills.filter(s => s.enabled);
  }

  getWorkflows(): WorkflowDefinition[] {
    return this.workflows;
  }

  getRulesSources(): RulesSource[] {
    return this.rulesSources;
  }

  toggleSkill(name: string): void {
    const skill = this.skills.find(s => s.name === name);
    if (skill) skill.enabled = !skill.enabled;
  }

  matchSkills(userMessage: string): SkillDefinition[] {
    const lower = userMessage.toLowerCase();
    return this.getEnabledSkills().filter(skill =>
      skill.triggerPatterns.some(pattern => lower.includes(pattern))
    );
  }

  /**
   * @deprecated M4-6-S3 废弃。本方法无任何调用方（死代码），且 `/review` `//collect` 已迁入
   *   输入区命令注册表（services/inputCommands/commandRegistry.ts，由该模块加载时从
   *   getWorkflows() 注册为可真正执行的 SlashCommand，经 commandExecutor.parseAndDispatch 分发）。
   *   输入框对斜杠命令的识别/执行统一走命令注册表，不再用此前缀匹配。保留签名仅为兼容性，勿新增调用。
   */
  matchWorkflow(input: string): WorkflowDefinition | undefined {
    return this.workflows.find(w => input.startsWith(w.slashCommand));
  }

  setGlobalRules(rules: string): void {
    this.globalRules = rules;
  }

  setWorkspaceRules(rules: string): void {
    this.workspaceRules = rules;
  }

  getRules(): RulesContent {
    return { global: this.globalRules, workspace: this.workspaceRules };
  }

  /** Stage 9: 从文件系统加载 RULES（全局 + 工作区） */
  async loadRulesFromFS(): Promise<void> {
    const { isElectron } = await import('@platform/index');
    if (!isElectron || !window.synapse) return;
    const globalPath = '~/.synapse/SYNAPSE.md';
    const workspacePath = '.synapse/rules.md';
    const globalRules = await this.readOptionalRule(globalPath);
    const workspaceRules = await this.readOptionalRule(workspacePath);
    this.globalRules = globalRules ?? '';
    this.workspaceRules = workspaceRules ?? '';
    // #17: 整合进同一「每轮加载」流——一并读取 enabled skill 的 SKILL.md 正文，
    //   这样 agentLoop 现有的 loadRulesFromFS() 调用即可顺带刷新 skill 正文，无需改 agentLoop。
    await this.loadSkillsContent();
    this.rulesSources = [
      {
        name: 'SYNAPSE.md',
        description: '全局用户规则，可选文件。',
        path: globalPath,
        sourceType: 'global',
        status: globalRules === null ? 'missing' : 'loaded',
        contentLength: globalRules?.length ?? 0,
      },
      {
        name: 'workspace rules.md',
        description: '当前工作区规则，可选文件。',
        path: workspacePath,
        sourceType: 'workspace',
        status: workspaceRules === null ? 'missing' : 'loaded',
        contentLength: workspaceRules?.length ?? 0,
      },
    ];
  }

  /** 构建扩展系统的系统提示注入段落 */
  buildExtensionPrompt(options: ExtensionPromptOptions = {}): string {
    const injectSkills = options.injectSkills ?? true;
    const injectWorkflows = options.injectWorkflows ?? true;
    const injectRules = options.injectRules ?? true;
    const parts: string[] = [];

    // Skills injection
    // #17: 注入 SKILL.md 正文（行为指导），而非仅 name/description。
    //   有正文者注入全文（SKILL 是行为指导，优先完整）；未读到正文者退回 name + description 摘要。
    const enabledSkills = this.getEnabledSkills();
    if (injectSkills && enabledSkills.length > 0) {
      const skillBlocks = enabledSkills.map(s => {
        const header = `### ${s.name}\n${s.description}`;
        if (s.content && s.content.trim()) {
          return `${header}\n\n${s.content.trim()}`;
        }
        return header;
      });
      parts.push(`<skills>
可用技能（含完整行为指导，当用户问题匹配某技能触发模式时，遵循对应技能正文的范式与步骤）:

${skillBlocks.join('\n\n---\n\n')}
</skills>`);
    }

    // Workflows injection
    // ★ M4-6-S3：this.workflows（BUILT_IN_WORKFLOWS）是【单一数据源】——输入区命令注册表
    //   （commandRegistry）正是从 getWorkflows() 注册这些工作流为可执行斜杠命令，两者读同一份数据，
    //   不存在「两处定义漂移」。故提示仍由此处从 this.workflows 生成，措辞标明这些斜杠命令现已可在
    //   输入框直接键入触发（经命令注册表执行），不再是仅供模型阅读的展示型文字。
    if (injectWorkflows && this.workflows.length > 0) {
      parts.push(`<workflows>
可用工作流斜杠命令（用户可在输入框开头键入触发，由命令注册表执行）:
${this.workflows.map(w => `- ${w.slashCommand}: ${w.description}`).join('\n')}
</workflows>`);
    }

    // Rules injection
    if (injectRules && (this.globalRules || this.workspaceRules)) {
      parts.push(`<user_rules>
${this.globalRules ? `全局规则:\n${this.globalRules}\n` : ''}
${this.workspaceRules ? `工作区规则:\n${this.workspaceRules}` : ''}
</user_rules>`);
    }

    return parts.join('\n\n');
  }

  /**
   * #17: 为所有 enabled skill 读取其 contentPath（各 skill 目录下的 SKILL.md）正文并缓存到
   *   skill.content。复用 readOptionalRule（IPC file:exists/read）。文件缺失/读取失败时置为 undefined，
   *   buildExtensionPrompt 仅注入有正文者的全文。串行读取，数量很少（≤7），不必并发。
   */
  private async loadSkillsContent(): Promise<void> {
    const { isElectron } = await import('@platform/index');
    if (!isElectron || !window.synapse) return;
    for (const skill of this.skills) {
      if (!skill.enabled) {
        skill.content = undefined;
        continue;
      }
      const content = await this.readOptionalRule(skill.contentPath);
      skill.content = content ?? undefined;
    }
  }

  private async readOptionalRule(filePath: string): Promise<string | null> {
    const api = window.synapse;
    if (!api) return null;
    try {
      if (api.file.exists && !(await api.file.exists(filePath))) return null;
      return await api.file.read(filePath);
    } catch {
      return null;
    }
  }
}

export const extensionManager = new ExtensionManager();

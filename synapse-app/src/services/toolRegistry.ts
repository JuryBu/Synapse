/**
 * Tool Registry — 工具注册、查询、执行
 * 内置学习助手工具集
 * 支持审批机制 + 透明重试
 */

import { buildDiffHunks, countLineChanges, generateChangeId, hashContent, recordTrackedFileChange } from './fileChangeTracker';

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string; enum?: string[] }>;
      required?: string[];
    };
  };
}

export type ToolHandler = (args: Record<string, any>) => Promise<string>;

type ToolCategory = 'file' | 'search' | 'command' | 'web' | 'learning' | 'custom';
type ApprovalLevel = 'auto' | 'read' | 'write' | 'dangerous';

interface RegisteredTool {
  schema: ToolSchema;
  handler: ToolHandler;
  category: ToolCategory;
  approvalLevel: ApprovalLevel;
}

// Approval callback — set by UI to show confirmation dialog
type ApprovalCallback = (toolName: string, args: Record<string, any>, level: ApprovalLevel) => Promise<boolean>;

class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private approvalCallback: ApprovalCallback | null = null;
  private autoApproveSettings = {
    read: true,
    write: false,
    command: false,
    all: false,
  };
  private maxRetries = 3;

  register(
    schema: ToolSchema,
    handler: ToolHandler,
    category: ToolCategory = 'custom',
    approvalLevel: ApprovalLevel = 'auto',
  ) {
    this.tools.set(schema.function.name, { schema, handler, category, approvalLevel });
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  getSchemas(): ToolSchema[] {
    return Array.from(this.tools.values()).map(t => t.schema);
  }

  /**
   * Set the approval callback (called by UI component)
   */
  setApprovalCallback(cb: ApprovalCallback) {
    this.approvalCallback = cb;
  }

  /**
   * Update auto-approve settings from Redux settings
   */
  updateAutoApprove(settings: typeof this.autoApproveSettings) {
    this.autoApproveSettings = { ...settings };
  }

  /**
   * Check if tool execution needs user approval
   */
  private needsApproval(tool: RegisteredTool): boolean {
    if (this.autoApproveSettings.all) return false;
    if (tool.approvalLevel === 'auto') return false;
    if (tool.approvalLevel === 'read' && this.autoApproveSettings.read) return false;
    if (tool.approvalLevel === 'write' && this.autoApproveSettings.write) return false;
    if (tool.approvalLevel === 'dangerous' && this.autoApproveSettings.command) return false;
    return true;
  }

  /**
   * Execute tool with approval check + transparent retry
   */
  async execute(name: string, args: Record<string, any>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return `Error: Tool "${name}" not found`;

    // Check approval
    if (this.needsApproval(tool) && this.approvalCallback) {
      const approved = await this.approvalCallback(name, args, tool.approvalLevel);
      if (!approved) {
        return `用户取消了工具 "${name}" 的执行`;
      }
    }

    // Execute with retry
    let lastError = '';
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const startTime = Date.now();
        const result = await tool.handler(args);
        const elapsed = Date.now() - startTime;
        // Attach execution time metadata
        return attempt > 0
          ? `${result}\n\n[重试 ${attempt} 次后成功, 耗时 ${elapsed}ms]`
          : result;
      } catch (err: any) {
        lastError = err.message || '未知错误';
        if (attempt < this.maxRetries - 1) {
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }

    return `Error: 工具 "${name}" 执行失败(重试 ${this.maxRetries} 次): ${lastError}`;
  }

  list(): string[] {
    return Array.from(this.tools.keys());
  }

  listByCategory(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [name, tool] of this.tools) {
      if (!result[tool.category]) result[tool.category] = [];
      result[tool.category].push(name);
    }
    return result;
  }
}

export const toolRegistry = new ToolRegistry();

// =====================================================
// Built-in Tools Registration
// =====================================================

// --- File Tools ---

toolRegistry.register({
  type: 'function',
  function: {
    name: 'view_file',
    description: '查看文件内容。返回文件的文本内容。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        startLine: { type: 'number', description: '起始行号（可选）' },
        endLine: { type: 'number', description: '结束行号（可选）' },
      },
      required: ['path'],
    },
  },
}, async (args) => {
  const { fileSystem } = await import('./fileSystem');
  const content = await fileSystem.readFile(args.path);
  if (!content) return `文件不存在: ${args.path}`;

  const lines = content.split('\n');
  const start = (args.startLine || 1) - 1;
  const end = args.endLine || lines.length;
  const slice = lines.slice(start, end);

  return `文件: ${args.path} (行 ${start + 1}-${end}/${lines.length})\n\n${slice.join('\n')}`;
}, 'file', 'read');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'list_dir',
    description: '列出目录下的文件和子目录',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径' },
      },
      required: ['path'],
    },
  },
}, async (args) => {
  const { fileSystem } = await import('./fileSystem');
  const tree = await fileSystem.getWorkspaceTree();
  if (!tree) return `目录不存在: ${args.path}`;

  const formatNode = (node: any, indent = ''): string => {
    const type = node.type === 'directory' ? '📁' : '📄';
    const size = node.size ? ` (${(node.size / 1024).toFixed(1)} KB)` : '';
    let result = `${indent}${type} ${node.name}${size}\n`;
    if (node.children) {
      for (const child of node.children) {
        result += formatNode(child, indent + '  ');
      }
    }
    return result;
  };

  return `目录: ${args.path}\n\n${formatNode(tree)}`;
}, 'file', 'read');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'write_to_file',
    description: '写入文件内容',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '文件内容' },
      },
      required: ['path', 'content'],
    },
  },
}, async (args) => {
  const { fileSystem } = await import('./fileSystem');
  let before = '';
  let existed = fileSystem.hasNode(args.path);
  try {
    const existingContent = await fileSystem.readFile(args.path);
    const isWebMissingPreview = !existed && existingContent.startsWith('// 文件内容预览:');
    if (!isWebMissingPreview) {
      before = existingContent;
      existed = true;
    }
  } catch {
    existed = false;
  }
  await fileSystem.writeFile(args.path, args.content);
  const snapshotId = generateChangeId('snapshot');
  const diffId = generateChangeId('diff');
  const beforeContent = existed ? before : '';
  const { additions, deletions } = countLineChanges(beforeContent, args.content);
  recordTrackedFileChange({
    snapshot: {
      id: snapshotId,
      path: args.path,
      content: existed ? before : undefined,
      contentHash: hashContent(beforeContent),
      createdAt: Date.now(),
      reason: 'before_ai_edit',
    },
    diff: {
      id: diffId,
      path: args.path,
      changeType: existed ? 'edited' : 'created',
      additions,
      deletions,
      status: 'pending',
      snapshotId,
      beforeHash: hashContent(beforeContent),
      afterHash: hashContent(args.content),
      hunks: buildDiffHunks(beforeContent, args.content),
    },
  });
  return `✅ 已写入文件: ${args.path} (${args.content.length} 字符)`;
}, 'file', 'write');

// --- Search Tools ---

toolRegistry.register({
  type: 'function',
  function: {
    name: 'search_files',
    description: '在工作区中搜索文件内容',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        path: { type: 'string', description: '搜索范围路径（可选）' },
      },
      required: ['query'],
    },
  },
}, async (args) => {
  const { fileSystem } = await import('./fileSystem');
  const results = await fileSystem.searchFiles(args.query);
  if (!results || results.length === 0) {
    return `未找到包含 "${args.query}" 的文件`;
  }
  return `搜索 "${args.query}" 找到 ${results.length} 个结果:\n${results.map((r: any) => `- ${r.path}: ${r.match}`).join('\n')}`;
}, 'search', 'read');

// --- Learning Tools ---

toolRegistry.register({
  type: 'function',
  function: {
    name: 'read_course_material',
    description: '读取课件指定页面的内容（PDF/PPTX/DOCX）',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '课件文件名' },
        page: { type: 'number', description: '页码（可选）' },
      },
      required: ['file'],
    },
  },
}, async (args) => {
  const fileName = args.file;
  const page = args.page || 1;
  return `📚 课件: ${fileName} (第 ${page} 页)\n\n[此功能需要 Electron 环境支持文件解析]\n提示: 在 Electron 模式下，此工具将使用 pdf.js / mammoth / pptx-parser 解析课件内容。`;
}, 'learning', 'read');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'generate_summary',
    description: '为指定课件生成知识概要',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '课件文件名' },
        mode: { type: 'string', description: '概要模式', enum: ['brief', 'detailed', 'outline'] },
      },
      required: ['file'],
    },
  },
}, async (args) => {
  return `📋 知识概要 - ${args.file}\n模式: ${args.mode || 'brief'}\n\n[此功能需要 Synopsis 引擎支持]\n提示: Synopsis 引擎将使用 Map-Reduce 策略对课件进行多模态概要生成。`;
}, 'learning', 'auto');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'create_quiz',
    description: '基于课件内容生成练习题',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '题目主题' },
        count: { type: 'number', description: '题目数量(默认5)' },
        difficulty: { type: 'string', description: '难度', enum: ['easy', 'medium', 'hard'] },
      },
      required: ['topic'],
    },
  },
}, async (args) => {
  const count = args.count || 5;
  return `🎯 练习题生成请求\n主题: ${args.topic}\n数量: ${count}\n难度: ${args.difficulty || 'medium'}\n\n[AI 将基于课程上下文直接生成练习题，无需额外工具调用]`;
}, 'learning', 'auto');

// --- Memory Tools（M1 上下文 harness：Synapse 内置 AI 主动记忆）---
// ⚠️ 这是 Synapse 内置记忆，存本地 SQLite（Web 模式存 localStorage），独立于用户环境里
//    另一套外置 MCP `mcp__memory-store__*` 工具——两者数据互不相通，AI 应使用本工具沉淀
//    与本应用相关的长期记忆（技术方案、踩坑、用户偏好等）。

toolRegistry.register({
  type: 'function',
  function: {
    name: 'memory_write',
    description:
      '写入一条长期记忆到 Synapse 内置记忆库（存本地 SQLite，Web 模式存 localStorage；'
      + '独立于外置 MCP memory-store，数据不互通）。'
      + '用于跨对话沉淀有价值的信息：技术方案、踩坑经验、用户偏好、项目背景等。'
      + '记忆会在后续对话中可被 memory_query 检索召回。'
      + 'searchSummary 要写好关键词/近义词/技术栈名，它比正文更影响检索命中率。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '记忆标题（简短一句话概括，是检索主权重字段之一）' },
        content: { type: 'string', description: '记忆正文（完整内容，可用 markdown）' },
        tags: { type: 'string', description: '标签，多个用英文逗号分隔（可选），如 "react,vite,踩坑"' },
        category: {
          type: 'string',
          description: '分类（可选，默认 general）',
          enum: ['problem-solution', 'technical-note', 'conversation', 'general'],
        },
        searchSummary: { type: 'string', description: '检索摘要（可选）：罗列关键词、近义词、技术栈名，提升被检索到的概率' },
        pinned: { type: 'string', description: '是否置顶高优记忆（可选），传 "true" 置顶，默认否' },
      },
      required: ['title', 'content'],
    },
  },
}, async (args) => {
  const { writeMemory } = await import('./memoryStore');
  const tags = typeof args.tags === 'string'
    ? args.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
    : (Array.isArray(args.tags) ? args.tags : []);
  const pinned = args.pinned === true || String(args.pinned).toLowerCase() === 'true';
  const saved = await writeMemory({
    title: args.title,
    content: args.content,
    tags,
    category: args.category,
    searchSummary: args.searchSummary,
    pinned,
  });
  if (!saved) return '⚠️ 记忆写入失败（记忆是辅助层，不影响当前对话继续进行）。';
  const tagStr = saved.tags.length ? ` [${saved.tags.join(', ')}]` : '';
  return `✅ 已记入 Synapse 记忆库 (id=${saved.id}, 分类=${saved.category}${saved.pinned ? ', 置顶' : ''})${tagStr}\n标题: ${saved.title}`;
}, 'custom', 'auto');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'memory_query',
    description:
      '从 Synapse 内置记忆库检索长期记忆（存本地 SQLite，Web 模式存 localStorage；'
      + '独立于外置 MCP memory-store，数据不互通）。'
      + '按关键词命中标题/正文/检索摘要/标签返回最相关的若干条，置顶记忆优先、近更新优先。'
      + '开始新任务或需要回忆既往背景/方案/偏好时应主动调用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词（可空，留空则返回最近更新的记忆）' },
        category: {
          type: 'string',
          description: '按分类过滤（可选）',
          enum: ['problem-solution', 'technical-note', 'conversation', 'general'],
        },
        limit: { type: 'number', description: '返回条数上限（可选，默认 10）' },
      },
      required: [],
    },
  },
}, async (args) => {
  const { queryMemory } = await import('./memoryStore');
  const limit = Number(args.limit) > 0 ? Number(args.limit) : 10;
  const results = await queryMemory(args.query, { category: args.category, limit });
  if (!results.length) {
    return args.query
      ? `未在 Synapse 记忆库中找到与 "${args.query}" 相关的记忆。`
      : 'Synapse 记忆库暂无记忆。';
  }
  const lines = results.map((m, i) => {
    const tagStr = m.tags.length ? ` [${m.tags.join(', ')}]` : '';
    const pin = m.pinned ? '📌 ' : '';
    return `${i + 1}. ${pin}${m.title} (${m.category})${tagStr}\n   ${m.content.replace(/\s+/g, ' ').slice(0, 300)}`;
  });
  return `🧠 Synapse 记忆库命中 ${results.length} 条:\n\n${lines.join('\n\n')}`;
}, 'custom', 'auto');

// --- Record Tools（M2-R3 渐进式读：按需展开骨架批次）---
// record 历史摘要注入时，中段较老的批次被降级为「骨架」（只有标题 + 首行要点）以控制注入膨胀。
// 当需要某个骨架批次的完整过程日志细节时，调本工具按 batchIndex 取回该批全文。

toolRegistry.register({
  type: 'function',
  function: {
    name: 'record_read',
    description:
      '展开当前对话 record 中被折叠为「骨架」的某个批次的完整过程日志（contentMd 全文）。'
      + 'record 历史摘要里标注为「[批次N 骨架，可用 record_read 展开全文]」的批次只注入了标题/要点，'
      + '需要该批次的完整细节（具体决策、工具调用、文件改动等）时调用本工具。'
      + 'batchIndex 用骨架标注里给出的批次序号；默认读当前对话，一般无需传 conversationId。',
    parameters: {
      type: 'object',
      properties: {
        batchIndex: { type: 'number', description: '要展开的批次序号（取自骨架标注里的「批次N」）' },
        conversationId: { type: 'string', description: '对话 ID（可选，缺省读当前对话）' },
      },
      required: ['batchIndex'],
    },
  },
}, async (args) => {
  const batchIndex = Number(args.batchIndex);
  if (!Number.isFinite(batchIndex)) {
    return '⚠️ record_read 需要有效的 batchIndex（数字，取自骨架标注里的「批次N」）。';
  }
  const { getBatch } = await import('./recordStore');
  const { store } = await import('@/store');
  const { AUTOSAVE_ID } = await import('./conversationPersistence');
  const conversationId =
    (typeof args.conversationId === 'string' && args.conversationId.trim())
      ? args.conversationId.trim()
      : (((store.getState() as any)?.conversation?.id as string | null) || AUTOSAVE_ID);
  const contentMd = await getBatch(conversationId, batchIndex);
  if (!contentMd) {
    return `未找到批次 ${batchIndex} 的全文（该批可能不存在、已被回溯裁剪，或当前对话无 record）。`;
  }
  return `📜 批次 ${batchIndex} 完整过程日志:\n\n${contentMd}`;
}, 'custom', 'auto');

// --- Web Tools ---

toolRegistry.register({
  type: 'function',
  function: {
    name: 'search_web',
    description: '搜索网页获取参考信息',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
      },
      required: ['query'],
    },
  },
}, async (args) => {
  return `🔍 网页搜索: "${args.query}"\n\n[Web 搜索功能需要配置搜索 API]\n提示: 支持接入 Serper/Tavily 等搜索 API。`;
}, 'web', 'auto');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'read_url_content',
    description: '读取指定 URL 的网页内容',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要读取的网页 URL' },
      },
      required: ['url'],
    },
  },
}, async (args) => {
  try {
    const response = await fetch(args.url);
    if (!response.ok) return `HTTP 错误 ${response.status}: 无法访问 ${args.url}`;
    const text = await response.text();
    // Simple HTML to text: strip tags
    const plainText = text.replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const truncated = plainText.length > 3000 ? plainText.slice(0, 3000) + '\n...(已截断)' : plainText;
    return `📄 ${args.url}\n\n${truncated}`;
  } catch (err: any) {
    return `读取 URL 失败: ${err.message}`;
  }
}, 'web', 'auto');

// --- Command Tools ---

toolRegistry.register({
  type: 'function',
  function: {
    name: 'run_command',
    description: '执行系统命令（需要用户审批）',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '工作目录（可选）' },
      },
      required: ['command'],
    },
  },
}, async (args) => {
  const { isElectron } = await import('@platform/index');
  if (isElectron && window.synapse) {
    try {
      const result = await window.synapse.command.exec(args.command, args.cwd);
      const output = [
        result.stdout ? `📤 stdout:\n${result.stdout}` : '',
        result.stderr ? `⚠️ stderr:\n${result.stderr}` : '',
        `退出码: ${result.exitCode}`,
      ].filter(Boolean).join('\n\n');
      return output;
    } catch (err: any) {
      return `命令执行失败: ${err.message}`;
    }
  }
  // Web 模式 Mock
  return `⚠️ 命令执行请求: \`${args.command}\`\n工作目录: ${args.cwd || '(当前)'}\n\n[Web 模式下命令执行不可用，请使用 Electron 模式]`;
}, 'command', 'dangerous');

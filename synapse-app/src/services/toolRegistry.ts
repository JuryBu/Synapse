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

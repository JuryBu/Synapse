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

/**
 * 工具执行上下文（M2-5 worktree 按需 / M3 并行子代理隔离）。
 * contextId = 「当前执行上下文 id」：现阶段 = conversationId（含 AUTOSAVE_ID），M3 阶段 = agentId/subagentId。
 * 由 agentLoop 执行工具时显式注入（见 execute 的 contextId 参数），沿调用链传到需要它的 handler
 * （worktree 根解析、cwd 解析、enter/exit_worktree），杜绝并行子代理共享全局态时互相串台。
 * 显式参数传递而非模块级变量——避免多 AgentLoop 实例并发交错执行工具时单一全局槽位被覆盖。
 */
export interface ToolExecContext {
  contextId?: string;
  /** ★ medium#4：本次工具调用是否来自子代理（后台自动派发，非主对话）。审批文案据此区分来源。 */
  isSubagent?: boolean;
  /** ★ medium#4：发起的子代理角色名（如「审查者」），审批框显示「子代理「角色」请求…」。 */
  subagentRole?: string;
}

/** execute 的可选元信息（来源标识等）——与 contextId 解耦，便于审批/审计区分主代理 vs 子代理。 */
export interface ToolExecMeta {
  isSubagent?: boolean;
  subagentRole?: string;
}

export type ToolHandler = (args: Record<string, any>, ctx?: ToolExecContext) => Promise<string>;

type ToolCategory = 'file' | 'search' | 'command' | 'web' | 'learning' | 'custom';
type ApprovalLevel = 'auto' | 'read' | 'write' | 'dangerous';

/**
 * ★ high#4（M3-2c 审查）工具权限类别——与 SubagentConfig.toolPermissions 联合类型严格对齐
 *   （'read' | 'write' | 'command' | 'search' | 'generate'）。子代理工具闸门据此过滤：
 *   编辑器 SubagentForm 勾选的 toolPermissions 决定该子代理运行时能拿到哪些工具，使「编辑承诺」与
 *   「运行消费」契约对齐（不再呈现一个运行期被静默忽略的权限闸门）。
 *   注意：spawn_subagent 不归任何权限类别（permissionCategory 为 undefined），其可用性只由 maxDepth 控制，
 *   不被 toolPermissions 过滤（否则会与 M3-1a 派发深度语义冲突）。
 */
export type ToolPermissionCategory = 'read' | 'write' | 'command' | 'search' | 'generate';

interface RegisteredTool {
  schema: ToolSchema;
  handler: ToolHandler;
  category: ToolCategory;
  approvalLevel: ApprovalLevel;
  /**
   * ★ high#4 子代理工具权限闸门所属类别（与 SubagentConfig.toolPermissions 对齐）。
   *   undefined = 不归任何权限类别（如 spawn_subagent 由 maxDepth 控制，不参与 toolPermissions 过滤）。
   */
  permissionCategory?: ToolPermissionCategory;
}

// Approval callback — set by UI to show confirmation dialog.
// ★ medium#4：新增可选第 4 参 meta，传子代理来源标识，让 UI 文案区分主代理/子代理（向后兼容：旧 3 参回调照常工作）。
type ApprovalCallback = (toolName: string, args: Record<string, any>, level: ApprovalLevel, meta?: ToolExecMeta) => Promise<boolean>;

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
    permissionCategory?: ToolPermissionCategory,
  ) {
    this.tools.set(schema.function.name, { schema, handler, category, approvalLevel, permissionCategory });
  }

  /**
   * ★ M4-7-S3：注销一个已注册工具（按工具名）。供 mcpBridge 在 MCP server 停用/重启时清理旧 MCP 工具，
   *   避免「server 停了但工具仍挂在 registry 里、AI 调用必然路由失败」的悬空。返回是否确有删除。
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  getSchemas(): ToolSchema[] {
    return Array.from(this.tools.values()).map(t => t.schema);
  }

  /**
   * ★ high#4 子代理工具闸门：按权限类别集合过滤工具 schema。
   *   - 仅返回 permissionCategory ∈ allowed 的工具（与 SubagentConfig.toolPermissions 对齐）；
   *   - permissionCategory 为 undefined 的工具（如 spawn_subagent）【不】由此过滤——其可用性由调用方
   *     （buildSubagentTools）按 maxDepth 单独决定，故这里一律剔除，交由调用方按需补回；
   *   - allowed 为空 → 不返回任何带权限类别的工具（子代理被收紧到无文件/搜索/命令权限）。
   */
  getSchemasForPermissions(allowed: ReadonlyArray<ToolPermissionCategory>): ToolSchema[] {
    const allowSet = new Set(allowed);
    return Array.from(this.tools.values())
      .filter(t => t.permissionCategory !== undefined && allowSet.has(t.permissionCategory))
      .map(t => t.schema);
  }

  /** ★ high#4：取无权限类别（不参与 toolPermissions 过滤）的工具 schema，如 spawn_subagent。 */
  getUncategorizedSchemas(): ToolSchema[] {
    return Array.from(this.tools.values())
      .filter(t => t.permissionCategory === undefined)
      .map(t => t.schema);
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
   * Execute tool with approval check + transparent retry.
   * @param contextId 当前执行上下文 id（agentLoop 注入；现阶段=conversationId，M3=agentId/subagentId）。
   *        worktree 根/cwd 解析与 enter/exit_worktree 据此定位「本上下文」的活动 worktree，避免并行串台。
   */
  async execute(name: string, args: Record<string, any>, contextId?: string, meta?: ToolExecMeta): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return `Error: Tool "${name}" not found`;

    // Check approval（★ medium#4：透传 meta，子代理调用时审批框可显示来源角色，避免用户误以为是主代理发起）
    if (this.needsApproval(tool) && this.approvalCallback) {
      const approved = await this.approvalCallback(name, args, tool.approvalLevel, meta);
      if (!approved) {
        return `用户取消了工具 "${name}" 的执行`;
      }
    }

    const ctx: ToolExecContext = {
      contextId,
      isSubagent: meta?.isSubagent,
      subagentRole: meta?.subagentRole,
    };
    // Execute with retry
    let lastError = '';
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const startTime = Date.now();
        const result = await tool.handler(args, ctx);
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
}, async (args, ctx) => {
  const { fileSystem } = await import('./fileSystem');
  const content = await fileSystem.readFile(args.path, ctx?.contextId);
  if (!content) return `文件不存在: ${args.path}`;

  const lines = content.split('\n');
  const start = (args.startLine || 1) - 1;
  const end = args.endLine || lines.length;
  const slice = lines.slice(start, end);

  return `文件: ${args.path} (行 ${start + 1}-${end}/${lines.length})\n\n${slice.join('\n')}`;
}, 'file', 'read', 'read');

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
}, async (args, ctx) => {
  const { fileSystem, getActiveRoots, resolveWorktreePath } = await import('./fileSystem');
  // ★ medium#2 对称修复：本上下文有活动 worktree 时，list_dir 也重定向到该 worktree（与
  //   view_file/write_to_file/run_command 口径一致），否则 AI 在 worktree 里 list_dir 会看到主工作区
  //   目录树、再 view_file 同路径却读到 worktree 内容，列表与实际内容割裂、可能据错误清单决策。
  //   无活动 worktree 时 rootOverride 为 undefined → getWorkspaceTree 走主工作区（行为同现状，零回归）。
  let rootOverride: string | undefined;
  const { activeWorktreePath } = await getActiveRoots(ctx?.contextId);
  if (activeWorktreePath) {
    // 把请求路径解析到 worktree 下作为取树根（args.path 为子目录时也能列 worktree 内对应子目录）。
    rootOverride = await resolveWorktreePath(args.path, ctx?.contextId);
  }
  const tree = await fileSystem.getWorkspaceTree(rootOverride);
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
}, 'file', 'read', 'read');

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
}, async (args, ctx) => {
  const { fileSystem } = await import('./fileSystem');
  let before = '';
  let existed = fileSystem.hasNode(args.path);
  try {
    // M2-5：读旧内容做 diff 也走 worktree 重定向（与写入同上下文/同根），避免「拿主工作区旧内容 diff
    //   worktree 新内容」的错位 diff。
    const existingContent = await fileSystem.readFile(args.path, ctx?.contextId);
    const isWebMissingPreview = !existed && existingContent.startsWith('// 文件内容预览:');
    if (!isWebMissingPreview) {
      before = existingContent;
      existed = true;
    }
  } catch {
    existed = false;
  }
  await fileSystem.writeFile(args.path, args.content, ctx?.contextId);
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
      // ★ worktree 隔离（审查 HIGH）：记下写入时的执行上下文，回滚/审阅据此重定向到同一 worktree（不落主工作区）。
      contextId: ctx?.contextId,
    },
  }, ctx?.contextId);
  return `✅ 已写入文件: ${args.path} (${args.content.length} 字符)`;
}, 'file', 'write', 'write');

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
}, 'search', 'read', 'search');

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
}, 'learning', 'read', 'read');

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
}, 'learning', 'auto', 'generate');

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
}, 'learning', 'auto', 'generate');

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
}, 'custom', 'auto', 'write');

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
}, 'custom', 'auto', 'search');

// --- Memory 只读工具（M4-7-S5 完善内置记忆读路径）---
// memory_query 只能按关键词检索；这两个补「列举」与「按 id 精读」能力，让 AI 不仅能搜、还能
// 浏览全部记忆 + 拿单条完整正文（query 截断到 300 字预览，精读需 memory_read 取全文）。
// 复用 memoryStore 已有的 listMemories / getMemory（仅之前未注册为工具），approval auto / category read。
// ⚠️ 仍是 Synapse 内置记忆（本地 SQLite / localStorage），独立于外置 MCP mcp__memory-store__*。

toolRegistry.register({
  type: 'function',
  function: {
    name: 'memory_list',
    description:
      '列举 Synapse 内置记忆库中的记忆（按更新时间倒序，可过滤分类 / 仅置顶）。'
      + '与 memory_query 的区别：memory_query 按关键词检索命中相关条目；'
      + 'memory_list 不带关键词、用于【浏览全部】记忆概览（例如想看「我都记了些什么」）。'
      + '正文同样只给预览，需要某条完整内容时用 memory_read(id) 精读。'
      + '（Synapse 内置记忆，存本地 SQLite / localStorage，独立于外置 MCP memory-store，数据不互通。）',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: '按分类过滤（可选）',
          enum: ['problem-solution', 'technical-note', 'conversation', 'general'],
        },
        pinnedOnly: { type: 'string', description: '仅列出置顶记忆（可选），传 "true" 只看置顶' },
        limit: { type: 'number', description: '返回条数上限（可选，默认 20）' },
      },
      required: [],
    },
  },
}, async (args) => {
  const { listMemories } = await import('./memoryStore');
  const limit = Number(args.limit) > 0 ? Number(args.limit) : 20;
  const pinnedOnly = args.pinnedOnly === true || String(args.pinnedOnly).toLowerCase() === 'true';
  const results = await listMemories({ category: args.category, pinnedOnly, limit });
  if (!results.length) {
    return pinnedOnly
      ? 'Synapse 记忆库暂无置顶记忆。'
      : 'Synapse 记忆库暂无记忆。';
  }
  const lines = results.map((m, i) => {
    const tagStr = m.tags.length ? ` [${m.tags.join(', ')}]` : '';
    const pin = m.pinned ? '📌 ' : '';
    return `${i + 1}. ${pin}${m.title} (id=${m.id}, ${m.category})${tagStr}\n   ${m.content.replace(/\s+/g, ' ').slice(0, 200)}`;
  });
  return `🧠 Synapse 记忆库共列出 ${results.length} 条（按更新时间倒序）:\n\n${lines.join('\n\n')}\n\n提示：用 memory_read(id) 取某条完整正文。`;
}, 'custom', 'auto', 'read');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'memory_read',
    description:
      '按 id 精读 Synapse 内置记忆库中的【单条】记忆完整内容（含完整正文、标签、检索摘要、时间）。'
      + 'memory_query / memory_list 返回的是截断预览，需要某条记忆的全文时用本工具按其 id 取回。'
      + '（Synapse 内置记忆，存本地 SQLite / localStorage，独立于外置 MCP memory-store，数据不互通。）',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id（取自 memory_query / memory_list 返回里的 id=...）' },
      },
      required: ['id'],
    },
  },
}, async (args) => {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return '⚠️ memory_read 需要有效的记忆 id（取自 memory_query / memory_list 返回里的 id=...）。';
  const { getMemory } = await import('./memoryStore');
  const m = await getMemory(id);
  if (!m) return `未在 Synapse 记忆库中找到 id=${id} 的记忆（可能已被删除或 id 有误）。`;
  const tagStr = m.tags.length ? m.tags.join(', ') : '（无）';
  const fmt = (sec: number) => (sec > 0 ? new Date(sec * 1000).toLocaleString() : '（未知）');
  return [
    `🧠 记忆全文 (id=${m.id})`,
    `标题: ${m.title}`,
    `分类: ${m.category}${m.pinned ? '（置顶）' : ''}`,
    `标签: ${tagStr}`,
    m.searchSummary ? `检索摘要: ${m.searchSummary}` : '',
    `创建: ${fmt(m.createdAt)}   更新: ${fmt(m.updatedAt)}`,
    '',
    '正文:',
    m.content,
  ].filter(Boolean).join('\n');
}, 'custom', 'auto', 'read');

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
}, 'custom', 'auto', 'read');

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
}, 'web', 'auto', 'search');

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
}, 'web', 'auto', 'read');

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
}, async (args, ctx) => {
  const { isElectron } = await import('@platform/index');
  if (isElectron && window.synapse) {
    try {
      // M2-5：cwd 优先级 = 显式 args.cwd > 本上下文活动 worktree > 主工作区 currentPath。
      // 都没有时传 undefined，主进程 command:exec 兜底 process.cwd()。
      //
      // ★ medium#1 显式行为变更（已记录为有意改进，非回归）：
      //   旧链路 AI 几乎不传 cwd → undefined → 主进程落 process.cwd()（Electron 安装/启动目录，潜在 bug）。
      //   新链路无活动 worktree 时落【已打开工作区 currentPath】，命令跑在用户工作区根而非安装目录——
      //   方向正确（把「跑在安装目录」修成「跑在工作区」）。无 currentPath（未打开工作区）时仍回退 undefined
      //   → process.cwd()，与现状一致。本变更已在 Task_4 显式记录。
      let cwd: string | undefined = (typeof args.cwd === 'string' && args.cwd.trim()) ? args.cwd : undefined;
      if (!cwd) {
        const { getActiveRoots } = await import('./fileSystem');
        const { activeWorktreePath, currentPath } = await getActiveRoots(ctx?.contextId);
        cwd = activeWorktreePath ?? currentPath ?? undefined;
      }
      const result = await window.synapse.command.exec(args.command, cwd);
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
}, 'command', 'dangerous', 'command');

// --- Worktree Tools（M2-5：按需进入隔离工作树）---
// 默认在主工作区改文件，行为与现状一致。仅当需要把改动隔离在独立分支/工作树里
// （例如试验性大改、与主工作区并行、用户明确要求「在 worktree 里改」）时，才调 enter_worktree。
// 进入后 view_file/write_to_file/run_command 的根路径自动重定向到该 worktree；exit_worktree 退回主工作区。

/** 默认分支/工作树名：worktree 仓侧 SAFE_NAME 只允许 [A-Za-z0-9._-]，不能含 `/`，故用连字符。 */
function defaultWorktreeBranch(): string {
  const ts = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `synapse-wt-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
}

toolRegistry.register({
  type: 'function',
  function: {
    name: 'enter_worktree',
    description:
      '进入一个隔离的 git 工作树（worktree）在独立分支里改文件。'
      + '【默认不需要】——一般小修小改直接在主工作区操作即可，不要调用本工具。'
      + '仅在需要隔离改动时才用：例如做试验性/大范围改动想与主工作区分开、'
      + '需要在一个独立分支上工作、或用户明确要求「在 worktree 里改」。'
      + '进入后，view_file / write_to_file / run_command 的根路径会自动重定向到该 worktree 目录；'
      + '改完可继续留着给用户看 diff，或调 exit_worktree 退回主工作区。'
      + '相同 branch 已存在对应 worktree 时会直接复用而非重建。仅 Electron 桌面模式可用。',
    parameters: {
      type: 'object',
      properties: {
        branch: {
          type: 'string',
          description: '分支名（可选，只允许字母/数字/点/连字符/下划线）。缺省自动生成 synapse-wt-<时间戳>。',
        },
      },
      required: [],
    },
  },
}, async (args, ctx) => {
  const { isElectron, platform } = await import('@platform/index');
  if (!isElectron || !platform.worktree) {
    return '⚠️ git worktree 仅在 Electron 桌面模式下可用。当前为 Web 模式，已保持在主工作区（文件操作照常）。';
  }

  const { store } = await import('@/store');
  const { enterWorktree } = await import('@/store/slices/worktreeSession');
  const { addNotification } = await import('@/store/slices/notifications');
  const { AUTOSAVE_ID } = await import('./conversationPersistence');
  const state = store.getState() as any;
  const repoRoot = (state?.workspace?.currentPath as string | null) ?? null;
  if (!repoRoot) {
    return '⚠️ 尚未打开工作区，无法进入 worktree。请先打开一个工作区（且该目录是 git 仓库），再重试。';
  }

  // contextId = 当前执行上下文（agentLoop 注入；现阶段=conversationId）。缺省时回退当前对话 id ?? AUTOSAVE_ID，
  // 保证至少把活动 worktree 绑到一个稳定的上下文键上（与 record/autosave 回退口径一致）。
  const contextId = ctx?.contextId
    || ((state?.conversation?.id as string | null) || AUTOSAVE_ID);

  const branch = (typeof args.branch === 'string' && args.branch.trim())
    ? args.branch.trim()
    : defaultWorktreeBranch();

  // 先看该分支是否已有对应 worktree（复用，避免「目标路径已存在」报错）。
  try {
    const listed = await platform.worktree.list({ repoRoot });
    if (!listed.error && Array.isArray(listed.worktrees)) {
      const existing = listed.worktrees.find(wt => wt.branch === branch && !wt.bare);
      if (existing) {
        store.dispatch(enterWorktree({ contextId, path: existing.path, branch, repoRoot }));
        // ★ medium#5：进入（复用）也给用户一条通知，让磁盘/git 状态变化可见（不止返回给 AI）。
        store.dispatch(addNotification({
          type: 'info',
          title: '已进入 worktree',
          message: `复用已有工作树（分支 ${branch}）：${existing.path}`,
          duration: 4000,
        }));
        return `✅ 已复用并进入 worktree（分支 ${branch}）：\n${existing.path}\n\n后续 view_file/list_dir/write_to_file/run_command 将作用于此工作树。改完可调 exit_worktree 退回主工作区。`;
      }
    } else if (listed.error) {
      return `⚠️ 无法进入 worktree：${listed.message || 'git worktree list 失败'}（已保持在主工作区）。`;
    }
  } catch (err: any) {
    return `⚠️ 无法进入 worktree：${err?.message ?? err}（已保持在主工作区）。`;
  }

  // 未复用到 → 新建（git 写操作，approval=write 会触发用户确认）。
  const created = await platform.worktree.create({ repoRoot, branch });
  if (created.error || !created.path) {
    return `⚠️ 创建 worktree 失败：${created.message || '未知错误'}（已保持在主工作区，文件操作照常）。`;
  }
  const createdBranch = created.branch ?? branch;
  store.dispatch(enterWorktree({ contextId, path: created.path, branch: createdBranch, repoRoot }));
  // ★ medium#5：创建成功后 dispatch 一条通知（与 M2-6 其它写操作的通知口径对齐），告知用户
  //   「已在磁盘 X 路径创建工作树目录 + git 里新建分支 Y」，避免用户对磁盘/git 状态变化无感知。
  store.dispatch(addNotification({
    type: 'info',
    title: '已创建并进入 worktree',
    message: `新分支 ${createdBranch}，工作树目录：${created.path}`,
    duration: 5000,
  }));
  return `✅ 已创建并进入 worktree（新分支 ${createdBranch}）：\n${created.path}\n\n后续 view_file/list_dir/write_to_file/run_command 将作用于此工作树（与主工作区隔离）。改完可调 exit_worktree 退回主工作区。`;
}, 'command', 'write', 'command');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'exit_worktree',
    description:
      '退出当前 worktree，让后续文件/命令操作回到主工作区。'
      + '仅当之前调过 enter_worktree 进入了某 worktree 时才有意义；'
      + '未处于任何 worktree 时调用是安全的空操作。'
      + '注意：本工具只切换「当前作用目录」回主工作区，不会删除 worktree（worktree 及其分支仍在磁盘/git 里，'
      + '可在设置-工作树里查看/删除，或之后再 enter_worktree 复用同一分支）。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
}, async (_args, ctx) => {
  const { store } = await import('@/store');
  const { exitWorktree, selectWorktreeEntry } = await import('@/store/slices/worktreeSession');
  const { AUTOSAVE_ID } = await import('./conversationPersistence');
  const state = store.getState() as any;
  const contextId = ctx?.contextId
    || ((state?.conversation?.id as string | null) || AUTOSAVE_ID);
  const prev = selectWorktreeEntry(state, contextId)?.activeWorktreePath ?? null;
  if (!prev) {
    return '当前已在主工作区（未处于任何 worktree），无需退出。';
  }
  store.dispatch(exitWorktree({ contextId }));
  return `✅ 已退出 worktree，回到主工作区。后续 view_file/list_dir/write_to_file/run_command 将作用于主工作区。\n（刚才的 worktree 仍保留在磁盘与 git 中：${prev}）`;
}, 'command', 'auto', 'command');

// --- Multi-AI Tools（M3-1a 真子代理：派发独立子代理执行任务）---
// spawn_subagent：主 AI / 上层子代理调用，派一个独立子代理（独立上下文 + 工具循环）执行任务，
// 完成后把子代理的结构化报告作为工具结果返回给调用方的对话循环（结果回插）。
//
// ★ 工具循环/落库/隔离实现见 agentOrchestrator.spawnSubagent（方案 A：不走主 agentLoop.run，不污染主对话）。
// ★ 循环依赖规避：agentOrchestrator 顶层 import toolRegistry（取 schemas + execute）；本 handler 反向用
//   动态 import('./agentOrchestrator') 在调用时才取实例，避免模块级互相 import 成环。
// ★ maxDepth 派发深度（递归层数控制，逐层递减防无限派发）：
//   - 调用方是【子代理】（ctx.contextId 在 orchestrator.depthByContext 里）→ 本次派出的子代理 maxDepth = 父 depth - 1。
//     （buildSubagentTools 已保证：父 depth>1 才把 spawn_subagent 给它，故 -1 后 >=1。）
//   - 调用方是【主 AI】（contextId 非活动子代理）→ 用工具入参 max_depth（不填默认 1=子代理不能再派）。
toolRegistry.register(
  {
    type: 'function',
    function: {
      name: 'spawn_subagent',
      description: '创建一个独立的子代理来执行特定任务。子代理有独立的上下文窗口，可使用工具多步推进，完成后返回结构化报告。适用于：代码审查、文献分析、数据验证、深度研究等可并行的任务。',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '子代理需要执行的任务描述' },
          role: {
            type: 'string',
            description: '子代理的角色(如: 审查者、文献分析、数据验证)',
            enum: ['reviewer', 'literature', 'validator', 'researcher', 'custom'],
          },
          // ToolSchema.properties 值类型不含 items（运行时不校验），用 string 描述数组语义即可。
          context_files: { type: 'string', description: '需要读取的文件路径列表(可选，JSON 数组或逗号分隔)' },
          max_depth: {
            type: 'number',
            description: '派发深度(可选，正整数；不填=1=该子代理不能再派发孙代理)。填 2=子代理可派一层孙代理；逐层递减防无限派发。',
          },
        },
        required: ['task', 'role'],
      },
    },
  },
  async (args, ctx) => {
    const { agentOrchestrator } = await import('./agentOrchestrator');
    const { store } = await import('@/store');

    const task = typeof args.task === 'string' ? args.task.trim() : '';
    if (!task) return 'Error: spawn_subagent 需要 task（子代理任务描述）。';
    const role = typeof args.role === 'string' && args.role.trim() ? args.role.trim() : 'custom';

    // 派发深度推导（见上注释）：父代理是子代理则继承 depth-1，否则用入参（默认 1）。
    const parentDepth = agentOrchestrator.getContextMaxDepth(ctx?.contextId);
    const childMaxDepth = typeof parentDepth === 'number'
      ? Math.max(1, parentDepth - 1)
      : Math.max(1, Math.floor(Number(args.max_depth) || 1));

    // 默认子代理模型 = 配置的 subagentDefaultModel（缺省回退当前模型，由 spawnSubagent 内部兜底）。
    const state = store.getState() as any;
    const model = state.multiAI?.subagentDefaultModel || '';
    const maxTokens = state.multiAI?.defaultSubagentMaxTokens || 32000;

    // 主对话 id 作子对话 parent_id（卡片归属）；缺省由 spawnSubagent 内部回退当前对话 id。
    const parentConversationId = (state?.conversation?.id as string | null) ?? '';

    const result = await agentOrchestrator.spawnSubagent({
      taskDescription: task,
      contextFiles: parseContextFiles(args.context_files),
      parentConversationId,
      config: {
        id: role,
        name: role,
        role,
        model,
        systemPrompt: `你是一个「${role}」角色的子代理，独立完成主代理交给你的任务，完成后返回结构化报告。`,
        // ★ high#4：主 AI 经 spawn_subagent 工具直派的通用子代理给【全量】工具权限类别——与旧行为
        //   （全量工具集）一致，零回归；工具闸门精细约束只作用于工作流编辑器里逐项勾选的子代理。
        toolPermissions: ['read', 'search', 'write', 'command', 'generate'],
        maxTokens,
        maxDepth: childMaxDepth,
      },
    });

    // 把子代理报告作为工具结果返回主对话循环（结果回插主对话）。
    const header = result.status === 'complete'
      ? `✅ 子代理「${result.role}」完成（${(result.duration / 1000).toFixed(1)}s，${result.toolCallsUsed} 次工具调用）`
      : `❌ 子代理「${result.role}」失败`;
    return `${header}\n\n${result.report}`;
  },
  'custom',
  'auto',
);

/** 解析 spawn_subagent 的 context_files 入参：兼容 string[]（旧/直传）、JSON 数组字符串、逗号分隔字符串。 */
function parseContextFiles(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    const arr = raw.map(f => String(f).trim()).filter(Boolean);
    return arr.length ? arr : undefined;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const text = raw.trim();
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const arr = parsed.map(f => String(f).trim()).filter(Boolean);
        return arr.length ? arr : undefined;
      }
    } catch {
      // 非 JSON → 按逗号/换行分隔。
    }
    const arr = text.split(/[,\n]/).map(f => f.trim()).filter(Boolean);
    return arr.length ? arr : undefined;
  }
  return undefined;
}

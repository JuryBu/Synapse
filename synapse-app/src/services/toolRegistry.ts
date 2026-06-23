/**
 * Tool Registry — 工具注册、查询、执行
 * 内置学习助手工具集
 * 支持审批机制 + 透明重试
 */

import { buildDiffHunks, countLineChanges, generateChangeId, hashContent, recordTrackedFileChange } from './fileChangeTracker';
import { recordTrackedArtifact } from './artifactTracker';
import { resolveEditorType } from './editorFileTypes';

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
  const { fileSystem, resolveWorkspacePath } = await import('./fileSystem');
  const { isExtractableDocument, extractDocumentText } = await import('./documentExtract');

  // office/pdf 等二进制文档：用 readFile（fs utf-8）读出来是乱码 → 改走文本提取（pdf.js/mammoth/jszip/xlsx）。
  //   提取需要可读的真实路径，故先按工具统一口径 resolveWorkspacePath 解析（与 list_dir/search 一致）。
  if (isExtractableDocument(args.path)) {
    try {
      const resolved = await resolveWorkspacePath(args.path, ctx?.contextId);
      const text = await extractDocumentText(resolved);
      if (!text) return `文件 ${args.path} 未提取到文本内容（可能是空文档 / 纯图片型 PDF）。`;
      // ★ review M2：office/pdf 提取文本无「自然行」（PDF 每页常是空格 join 的单行），startLine/endLine 行切片
      //   语义失效（传 1-50 行可能拿到整篇或只几页分隔符）。故文档型不按行切、整体返回（已 clamp 50k 上限），
      //   传了行号则提示改用 read_course_material 的 page 参数按页读。
      const docHint = (args.startLine || args.endLine)
        ? '（注：文档型按整体/页读，不支持行号；要分页请用 read_course_material 的 page 参数）'
        : '';
      return `文档: ${args.path} (已解析文本)${docHint}\n\n${text}`;
    } catch (err: any) {
      return `读取文档失败 ${args.path}: ${err?.message || String(err)}`;
    }
  }

  const content = await fileSystem.readFile(args.path, ctx?.contextId);
  if (!content) return `文件不存在: ${args.path}`;

  const lines = content.split('\n');
  const start = (args.startLine || 1) - 1;
  const end = args.endLine || lines.length;
  const slice = lines.slice(start, end);

  return `文件: ${args.path} (行 ${start + 1}-${end}/${lines.length})\n\n${slice.join('\n')}`;
}, 'file', 'read', 'read');

// show_artifact：把一个【已存在的文件】作为「产物卡片」推给用户——用户点卡片即在中部编辑器打开。
//   是 view_file 的展示型孪生：view_file 把文件内容回给 AI，show_artifact 则在 UI 给用户一张可点开的卡片。
//   只展示已存在文件、绝不写盘 → approval=auto（无需审批）、permissionCategory=read。
//   handler 校验文件存在（复用 view_file 的 fileSystem.readFile + worktree/相对路径口径，只确认存在不读全文用途）、
//   预解析 editorType（resolveEditorType 按扩展名），record 到 artifactTracker 当前桶，由 agentLoop 收口消费。
toolRegistry.register({
  type: 'function',
  function: {
    name: 'show_artifact',
    description:
      '把一个【已存在的文件】作为「产物卡片」展示给用户——用户点击卡片即可在中部编辑器中打开该文件。'
      + '适用于：你刚为用户准备好/生成好一个文件（文档、代码、图片、PDF、网页等），想让用户一键打开查看。'
      + '注意：这只是展示一个【已经存在】的文件的入口，不会创建或修改任何文件（创建/修改请用 write_to_file）。'
      + 'path 为文件路径；label 可选，是卡片上显示的名字（不填则取文件名）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要展示的【已存在文件】的路径' },
        label: { type: 'string', description: '卡片显示名（可选，缺省取文件名）' },
      },
      required: ['path'],
    },
  },
}, async (args, ctx) => {
  const path = typeof args.path === 'string' ? args.path.trim() : '';
  if (!path) return '⚠️ show_artifact 需要有效的 path（要展示的已存在文件路径）。';

  const { fileSystem } = await import('./fileSystem');
  // 复用 view_file 的读取口径（worktree 重定向 / 相对路径锚工作区根），只为确认文件存在——
  //   读到内容、且不是 Web 模式「文件内容预览:」占位串，即视为存在（与 write_to_file 的存在判定口径一致）。
  let content = '';
  try {
    content = await fileSystem.readFile(path, ctx?.contextId);
  } catch {
    return `文件不存在或无法读取: ${path}`;
  }
  if (!content || content.startsWith('// 文件内容预览:')) {
    return `文件不存在或无法读取: ${path}`;
  }

  const fileName = path.split(/[\\/]/).pop() || path;
  const label = (typeof args.label === 'string' && args.label.trim()) ? args.label.trim() : fileName;
  // editorType 预解析：让用户点开时直接走对的查看器（office/pdf/image/markdown/html…），而非一律按 code 打开。
  const editorType = resolveEditorType(fileName);

  recordTrackedArtifact({
    id: generateChangeId('artifact'),
    path,
    label,
    editorType,
  }, ctx?.contextId);

  return `✅ 已把产物卡片推送给用户: ${label}（${path}）。用户可点击卡片在编辑器中打开。`;
}, 'file', 'auto', 'read');

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
  const { fileSystem, resolveWorkspacePath } = await import('./fileSystem');
  // ★ P0-1：把请求目录解析到「权威根」下的绝对路径——有活动 worktree 重定向到 worktree，
  //   无 worktree 时相对路径锚到已打开工作区根（与 view_file/write_to_file 口径一致）。
  //   旧版「仅 worktree 时传 rootOverride、否则 undefined」会在无 worktree 时忽略 args.path、
  //   永远铺主工作区整棵树（套娃根因之一）。
  const targetDir = await resolveWorkspacePath(args.path, ctx?.contextId);
  const tree = await fileSystem.getWorkspaceTree(targetDir || undefined);
  if (!tree) return `目录不存在: ${args.path}`;

  // ★ P0-1 治套娃：只列【该目录下一层】（不递归整棵 maxDepth=3 子树），符合 ls 语义；
  //   深层结构让 AI 对子目录再 list_dir 下钻，避免一次性铺开导致刷屏 + 上下文浪费。
  const children = Array.isArray(tree.children) ? tree.children : [];
  const dirLabel = tree.path || args.path;
  if (children.length === 0) {
    return `目录: ${dirLabel}\n\n（空目录）`;
  }
  // 目录在前、文件在后，各自按名排序，稳定可读。
  const sorted = [...children].sort((a: any, b: any) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
  });
  const lines = sorted.map((node: any) => {
    const icon = node.type === 'directory' ? '📁' : '📄';
    const slash = node.type === 'directory' ? '/' : '';
    const size = node.type === 'file' && node.size ? ` (${(node.size / 1024).toFixed(1)} KB)` : '';
    return `${icon} ${node.name}${slash}${size}`;
  });
  return `目录: ${dirLabel}（${sorted.length} 项）\n\n${lines.join('\n')}`;
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
      // ★ #6/#10：透传本次最新落盘内容，供 addMessageDiff 合并同文件多次写时按「最早基线→最新」重算累积 diff；
      //   该字段在入 pendingDiffs 前被 reducer 剥除，不持久化。
      afterContent: args.content,
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
}, async (args, ctx) => {
  const { fileSystem, resolveWorkspacePath } = await import('./fileSystem');
  // ★ search 根与 list_dir 同口径（治「search_files 搜不到任何内容」）：用 resolveWorkspacePath 解析 args.path（缺省 '.'），
  //   走主进程 file:search（磁盘递归 grep + 文件名匹配）。旧版用 getWorkspaceRootResolved——demo/未打开工作区时它把
  //   /workspace 假路径视为无根返回 null → searchInWorkspace 回退内部 mock '/workspace'（磁盘不存在）→ 搜空；
  //   而 list_dir 走 resolveWorkspacePath 能落到 process.cwd()（工程根）。统一为同口径，与 list_dir 落点一致。
  const rawPath = (typeof args.path === 'string' && args.path.trim()) ? args.path.trim() : '.';
  const root = await resolveWorkspacePath(rawPath, ctx?.contextId);
  const results = await fileSystem.searchInWorkspace(args.query, root);
  if (!results || results.length === 0) {
    return `未找到匹配 "${args.query}" 的文件或内容`;
  }
  const MAX = 50;
  const shown = results.slice(0, MAX);
  const lines = shown.map((r: any) => r.kind === 'content'
    ? `- ${r.path}:${r.line ?? '?'}  ${String(r.content ?? '').trim()}`
    : `- ${r.path}（文件名匹配）`);
  const more = results.length > MAX ? `\n…另有 ${results.length - MAX} 条未显示` : '';
  return `搜索 "${args.query}" 找到 ${results.length} 个结果:\n${lines.join('\n')}${more}`;
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
}, async (args, ctx) => {
  const fileName = args.file;
  if (!fileName || typeof fileName !== 'string') return '⚠️ read_course_material 需要 file（课件文件名/路径）。';

  const { resolveWorkspacePath } = await import('./fileSystem');
  const { isExtractableDocument, extractDocumentText } = await import('./documentExtract');

  if (!isExtractableDocument(fileName)) {
    return `⚠️ ${fileName} 不是受支持的课件类型（支持 .pdf/.docx/.pptx/.xlsx/.xls/.csv）。若是纯文本/代码文件请用 view_file。`;
  }

  try {
    const resolved = await resolveWorkspacePath(fileName, ctx?.contextId);
    const text = await extractDocumentText(resolved);
    if (!text) return `📚 课件 ${fileName}：未提取到文本内容（可能是空文档 / 纯图片型 PDF）。`;

    // 指定了页码时：尝试从带 `--- Page N ---` / `--- Slide N ---` 分隔的文本里抠出该页；抠不到则回全文。
    const page = typeof args.page === 'number' ? args.page : undefined;
    if (page && page > 0) {
      const re = new RegExp(`--- (?:Page|Slide) ${page} ---\\n([\\s\\S]*?)(?=\\n--- (?:Page|Slide) \\d+ ---|$)`);
      const m = text.match(re);
      if (m) return `📚 课件: ${fileName}（第 ${page} 页）\n\n${m[1].trim()}`;
      // PDF/PPTX 无该页，或 docx/表格类无分页概念 → 返回全文并提示。
      return `📚 课件: ${fileName}（未找到第 ${page} 页，返回全文；docx/表格类无分页）\n\n${text}`;
    }

    return `📚 课件: ${fileName}\n\n${text}`;
  } catch (err: any) {
    return `📚 课件 ${fileName} 解析失败: ${err?.message || String(err)}`;
  }
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

// ★ #14 动态分级（hit 反馈）：AI 读 record 摘要时，发现某批/某轮历史正是当前需要的上下文 → 调本工具标记它，
//   系统会在下次压缩点据此把该段保留更完整内容（升 full）。标记只记账、不立即改注入，故不影响 prompt cache。
toolRegistry.register({
  type: 'function',
  function: {
    name: 'mark_record_hit',
    description:
      '标记当前对话 record 历史摘要里的某个批次/某一轮【正是你当前需要的上下文】（hit 反馈）。'
      + '当你读 record 摘要（含被折叠为「骨架/标题」的批次）时，若发现某段历史正是解决当前问题需要的关键上下文，'
      + '调用本工具标记它——系统会在后续压缩时优先把这段历史保留更完整的内容（全文而非仅标题），方便你后续随时取用。'
      + 'batchIndex 用骨架标注里的「批次N」精确标记一个批；或用 roundHit 标记某一轮号所在的批（二者传其一，batchIndex 优先）。'
      + '默认作用于当前对话，一般无需传 conversationId。本标记只记账、不立即改变摘要内容，可放心多次调用。',
    parameters: {
      type: 'object',
      properties: {
        batchIndex: { type: 'number', description: '要标记的批次序号（取自骨架标注里的「批次N」）' },
        roundHit: { type: 'number', description: '要标记的轮号（命中该轮号所在的批；batchIndex 已传时忽略）' },
        conversationId: { type: 'string', description: '对话 ID（可选，缺省当前对话）' },
      },
      required: [],
    },
  },
}, async (args) => {
  const hasBatch = Number.isFinite(Number(args.batchIndex));
  const hasRound = Number.isFinite(Number(args.roundHit));
  if (!hasBatch && !hasRound) {
    return '⚠️ mark_record_hit 需要 batchIndex（骨架标注里的「批次N」）或 roundHit（轮号）至少其一。';
  }
  const { markRecordHit } = await import('./recordStore');
  const { identifyRounds } = await import('./roundBoundary');
  const { store } = await import('@/store');
  const { AUTOSAVE_ID } = await import('./conversationPersistence');
  const conversationId =
    (typeof args.conversationId === 'string' && args.conversationId.trim())
      ? args.conversationId.trim()
      : (((store.getState() as any)?.conversation?.id as string | null) || AUTOSAVE_ID);
  // 当前对话轮号（过滤 tool 后真轮识别）——传给 markRecordHit 作 lastHitRound 候选。
  // ⚠️ 口径注意：这是 live 真轮（含未压缩的最近几轮），与 record 水位轮（恒 ≤ live 真轮）只是「计数方法相同」、
  //    数值并不同轴。markRecordHit 内部会把它钳到 min(liveRound, record.totalRounds) 再写库，使 lastHitRound 与
  //    computeRenderLevels 的 freshness 消费轴（record 水位轮）对齐——否则 hitAge 恒被夹成 0、freshness 不衰减。
  const liveMessages = ((store.getState() as any)?.conversation?.messages ?? [])
    .filter((m: any) => m?.role !== 'tool');
  const currentRound = identifyRounds(liveMessages).totalRounds;
  const target = hasBatch
    ? { batchIndex: Math.floor(Number(args.batchIndex)) }
    : { roundHit: Math.floor(Number(args.roundHit)) };
  const updated = await markRecordHit(conversationId, target, currentRound);
  if (!updated) {
    const desc = hasBatch ? `批次 ${target.batchIndex}` : `第 ${target.roundHit} 轮`;
    return `未能标记 ${desc}（该批可能不存在、已被回溯裁剪/折叠归档，或当前对话无 record）。`;
  }
  const desc = hasBatch ? `批次 ${Math.floor(Number(args.batchIndex))}` : `第 ${Math.floor(Number(args.roundHit))} 轮所在批`;
  return `✅ 已标记 ${desc} 为当前需要的上下文（hit 反馈已记账）。系统将在后续压缩时优先为这段历史保留更完整内容。`;
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

// --- Conversation 原文工具（M7-F2：读 Synapse 自己 SQLite 的历史对话完整原文）---
// 背景：@对话 引用只注入【摘要】；AI 之前误用外置 mcp__memory-store__conversation_read_original
//   （那是跨宿主记忆库，与 Synapse 本地对话是两套系统、conv-xxx ID 不互通）。这两个工具查 Synapse 自己的对话库。

toolRegistry.register({
  type: 'function',
  function: {
    name: 'list_conversations',
    description:
      '列出 Synapse 自己的历史对话（本地 SQLite，独立于外置 MCP memory-store，与那边 conv-xxx 不互通）。'
      + '返回每条的 id / 标题 / 更新时间 / 末条消息预览。需要读某条历史对话的完整原文时，'
      + '先用本工具拿到 id，再调 read_conversation。query 非空按关键词搜标题/内容，否则列最近的。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词（可选，搜标题/内容）；留空列最近对话' },
        limit: { type: 'number', description: '返回条数上限（默认 20，最大 50）' },
      },
      required: [],
    },
  },
}, async (args) => {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(50, Number(args.limit))) : 20;
  const { platform } = await import('@/platform');
  let rows: any[] = [];
  try {
    rows = query
      ? await platform.conversation.search(query, { limit })
      : await platform.conversation.list({ limit });
  } catch {
    return '⚠️ 列出对话失败（平台接口异常）。';
  }
  if (!rows || rows.length === 0) return query ? `未找到匹配「${query}」的历史对话。` : '暂无历史对话。';
  const fmtTime = (v: any) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return '';
    return new Date(n < 1e12 ? n * 1000 : n).toLocaleString();
  };
  const lines = rows.slice(0, limit).map((c, i) => {
    const id = String(c.id ?? '');
    const title = String(c.title ?? '未命名对话');
    const t = fmtTime(c.updatedAt ?? c.updated_at);
    const last = String(c.lastMessage ?? c.last_message ?? '').replace(/\s+/g, ' ').slice(0, 60);
    return `${i + 1}. ${title} (id=${id}${t ? `, ${t}` : ''})${last ? ` — ${last}` : ''}`;
  });
  return `🗂 Synapse 历史对话（${lines.length} 条）:\n\n${lines.join('\n')}\n\n提示：用 read_conversation(conversationId) 读某条的完整原文。`;
}, 'custom', 'auto', 'read');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'read_conversation',
    description:
      '一字不差读取 Synapse 自己某条历史对话的完整原文（逐条 user/assistant/tool 消息）。'
      + '⚠️ 这是 Synapse 本地 SQLite 的对话，独立于外置 MCP memory-store（conversation_read_original）——'
      + '两者是不同系统、conv-xxx ID 不互通，读 Synapse 对话务必用本工具，不要用 memory-store 的。'
      + '@对话 引用只注入摘要，需要完整原文时用本工具。conversationId 缺省读当前对话；内容超长按 maxChars 截断。',
    parameters: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: '对话 ID（取自 list_conversations / @对话候选；缺省读当前对话）' },
        maxChars: { type: 'number', description: '返回原文字符上限（默认 24000，最大 60000，防撑爆上下文）' },
      },
      required: [],
    },
  },
}, async (args) => {
  const { platform } = await import('@/platform');
  const { store } = await import('@/store');
  const { AUTOSAVE_ID } = await import('./conversationPersistence');
  const conversationId =
    (typeof args.conversationId === 'string' && args.conversationId.trim())
      ? args.conversationId.trim()
      : (((store.getState() as any)?.conversation?.id as string | null) || AUTOSAVE_ID);
  const maxChars = Number.isFinite(Number(args.maxChars)) ? Math.max(2000, Math.min(60000, Number(args.maxChars))) : 24000;
  let msgs: any[] = [];
  try {
    msgs = await platform.conversation.listMessages(conversationId);
  } catch {
    return `⚠️ 读取对话 ${conversationId} 失败（平台接口异常）。`;
  }
  if (!msgs || msgs.length === 0) return `对话 ${conversationId} 无消息记录（id 可能有误，可先用 list_conversations 确认）。`;
  const roleLabel: Record<string, string> = { user: '用户', assistant: 'AI', tool: '工具结果', system: '系统' };
  const parts: string[] = [];
  let used = 0;
  let truncated = false;
  for (const m of msgs) {
    const role = roleLabel[String(m.role)] ?? String(m.role);
    let text = typeof m.content === 'string' ? m.content : '';
    // 多模态：content 为空但有 contentParts 时取 text part 拼接
    if (!text && Array.isArray(m.contentParts)) {
      text = m.contentParts.filter((p: any) => p?.type === 'text').map((p: any) => p.text ?? '').join('\n');
    }
    const tools = Array.isArray(m.toolCalls) && m.toolCalls.length
      ? `\n  [工具调用: ${m.toolCalls.map((t: any) => t?.name ?? '?').join(', ')}]`
      : '';
    const block = `【${role}】${text}${tools}`;
    if (used + block.length > maxChars) { truncated = true; break; }
    parts.push(block);
    used += block.length;
  }
  const header = `📖 对话「${conversationId}」完整原文（${parts.length}/${msgs.length} 条消息）:`;
  const footer = truncated ? `\n\n…（已达 ${maxChars} 字上限截断，共 ${msgs.length} 条消息。需要更多请提高 maxChars。）` : '';
  return `${header}\n\n${parts.join('\n\n')}${footer}`;
}, 'custom', 'auto', 'read');

// --- Task Boundary Tools（M7：反重力式任务边界流，Plan 模式 AI 自用，让用户在对话流看到「正在做什么」）---
//   工具 handler 直接 dispatch conversation slice 的 reducer（边界挂对话顶层，不挂消息，无需 tracker 中转）。
//   approvalLevel='auto'（无需审批）；不归 permissionCategory（不参与子代理过滤）。
toolRegistry.register({
  type: 'function',
  function: {
    name: 'begin_task_boundary',
    description: '开始一个新任务边界——在对话流里显示一张任务卡（大标题+概述+进度）。开始一个有多个步骤的任务时调用。会自动收口上一个未结束的任务边界。',
    parameters: {
      type: 'object',
      properties: {
        headline: { type: 'string', description: '任务大标题（如「查看现有 rules 文件」）' },
        summary: { type: 'string', description: '一句话概述（可选）' },
      },
      required: ['headline'],
    },
  },
}, async (args) => {
  const headline = typeof args.headline === 'string' ? args.headline.trim() : '';
  if (!headline) return '⚠️ begin_task_boundary 需要 headline。';
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  const { store } = await import('@/store');
  const conv = await import('@/store/slices/conversation');
  // ★ 锚定当前轮的 assistant 消息——卡片据此【内联渲染在该消息后】（反重力式穿插），而非堆在消息流末尾。
  const msgs = (store.getState() as any).conversation?.messages ?? [];
  let anchorMessageId: string | undefined;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === 'assistant') { anchorMessageId = msgs[i].id; break; }
  }
  store.dispatch(conv.beginTaskBoundary({ id: generateChangeId('tb'), headline, summary, anchorMessageId, at: Date.now() }));
  return `✅ 已开始任务边界：${headline}`;
}, 'custom', 'auto');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'set_task_headline',
    description: '更新当前任务边界的大标题与概述。每进入一个新的子阶段/小标题就调一次——系统会自动把变更记入该任务的「标题变迁历史」。',
    parameters: {
      type: 'object',
      properties: {
        headline: { type: 'string', description: '新的当前大标题' },
        summary: { type: 'string', description: '新的概述（可选）' },
      },
      required: ['headline'],
    },
  },
}, async (args) => {
  const headline = typeof args.headline === 'string' ? args.headline.trim() : '';
  if (!headline) return '⚠️ set_task_headline 需要 headline。';
  // ★ 缺省传 undefined（不是 ''）：让 reducer「summary 未提供=保留旧概括」兜底生效（只换标题不误清空概括/污染 history）。
  const summary = typeof args.summary === 'string' ? args.summary.trim() : undefined;
  const { store } = await import('@/store');
  const conv = await import('@/store/slices/conversation');
  store.dispatch(conv.setTaskHeadline({ headline, summary, at: Date.now() }));
  return `✅ 已更新任务标题：${headline}`;
}, 'custom', 'auto');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'update_task_progress',
    description: '给当前任务边界追加一条进度。每完成一个关键动作就调一次。',
    parameters: {
      type: 'object',
      properties: {
        step: { type: 'string', description: '本步进度描述（如「读取了 3 个配置文件」）' },
      },
      required: ['step'],
    },
  },
}, async (args) => {
  const text = typeof args.step === 'string' ? args.step.trim() : '';
  if (!text) return '⚠️ update_task_progress 需要 step。';
  const { store } = await import('@/store');
  const conv = await import('@/store/slices/conversation');
  store.dispatch(conv.appendTaskStep({ id: generateChangeId('tbs'), text, at: Date.now() }));
  return `✅ 已追加进度：${text}`;
}, 'custom', 'auto');

toolRegistry.register({
  type: 'function',
  function: {
    name: 'end_task_boundary',
    description: '收口当前任务边界（整个任务完成时调用，标记为已完成）。',
    parameters: {
      type: 'object',
      properties: {
        aborted: { type: 'boolean', description: '是否异常中止（可选，true=标记为中止/红色）' },
      },
      required: [],
    },
  },
}, async (args) => {
  const { store } = await import('@/store');
  const conv = await import('@/store/slices/conversation');
  store.dispatch(conv.endTaskBoundary({ aborted: args.aborted === true, at: Date.now() }));
  return '✅ 已收口当前任务边界。';
}, 'custom', 'auto');

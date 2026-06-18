/**
 * 平台适配层
 * Electron 模式下使用真实的 IPC 桥接
 * Web 模式下使用 Mock 实现
 */

export interface PlatformInfo {
  isElectron: boolean;
  platform: string;
  version: string;
  userDataPath: string;
}

export interface WallpaperAsset {
  id: string;
  name: string;
  kind: 'managed' | 'dataUrl';
  url: string;
  relativePath?: string;
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
  addedAt: number;
}

// ===== git worktree (M2-4) =====
export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
}

export interface WorktreeListResult {
  worktrees?: WorktreeEntry[];
  error?: boolean;
  message?: string;
}

export interface WorktreeCreateResult {
  success?: boolean;
  path?: string;
  branch?: string;
  error?: boolean;
  message?: string;
}

export interface WorktreeRemoveResult {
  success?: boolean;
  path?: string;
  error?: boolean;
  message?: string;
}

export interface WorktreeStatusResult {
  clean?: boolean;
  files?: Array<{ status: string; file: string }>;
  error?: boolean;
  message?: string;
}

/** Web 模式下 worktree 不可用时统一返回的提示。 */
const WORKTREE_WEB_ONLY = 'git worktree 管理仅在 Electron 桌面模式下可用';

// ===== 附件分离存储 (M2-R6) =====
// sha256 引用层 = 统一抽象边界：桌面/网页 schema、引用格式、上层逻辑同一套；
// blob 后端各自实现（桌面=文件系统 IPC / 网页=IndexedDB）。两端接口签名完全一致。

/** put 入参：data 为 dataUrl 或纯 base64（对其原始二进制算 sha256）。 */
export interface AttachmentPutInput {
  data: string;
  mime?: string;
  name?: string;
  kind?: string;
}

/** put 成功返回的引用元数据（消息引用层据此写 messages，第2段接入）。 */
export interface AttachmentRef {
  sha256: string;
  size: number;
  mime: string;
  kind: string;
  name: string;
}

/** get 返回：还原后的 base64 dataUrl + 元数据。找不到返回 null。 */
export interface AttachmentGetResult {
  sha256: string;
  mime: string;
  size: number;
  dataUrl: string;
}

/** refCount 变更类操作（delete/release）的返回。 */
export interface AttachmentRefCountResult {
  sha256: string;
  refCount: number;
  deleted: boolean;
}

/** 统一失败返回（与 worktree/wallpaper 口径一致）。 */
export interface AttachmentError {
  error: true;
  message: string;
}

export interface SynapseAPI {
  platform: {
    info: () => Promise<PlatformInfo>;
    isElectron: boolean;
  };
  window: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
    isMaximized?: () => Promise<boolean>;
  };
  file: {
    exists: (filePath: string) => Promise<boolean>;
    read: (filePath: string) => Promise<string>;
    readBinary: (filePath: string) => Promise<number[] | ArrayBuffer | Uint8Array>;
    convertOffice?: (filePath: string) => Promise<{ success?: boolean; error?: boolean; message?: string; outputPath?: string; format?: 'pdf'; tempDir?: string }>;
    cleanupTemp?: (targetPath: string) => Promise<{ success?: boolean; error?: boolean; message?: string }>;
    write: (filePath: string, content: string) => Promise<void | { success?: boolean; error?: boolean; message?: string }>;
    list: (dir: string) => Promise<any[]>;
    search: (dir: string, pattern: string) => Promise<any[]>;
    grep: (dir: string, query: string, opts: any) => Promise<any[]>;
    rename: (oldPath: string, newPath: string) => Promise<void>;
    delete: (path: string) => Promise<void>;
    mkdir: (path: string) => Promise<void>;
  };
  wallpaper?: {
    importFromDialog: () => Promise<WallpaperAsset[]>;
    importFiles: (filePaths: string[]) => Promise<WallpaperAsset[]>;
    remove: (asset: Pick<WallpaperAsset, 'id' | 'relativePath'>) => Promise<{ success?: boolean; error?: boolean; message?: string }>;
    clear: (assets: Array<Pick<WallpaperAsset, 'id' | 'relativePath'>>) => Promise<{ removed?: string[]; errors?: string[]; error?: boolean; message?: string }>;
  };
  workspace: {
    open: () => Promise<{ id: string; name: string; path: string } | null>;
    recent: (limit?: number) => Promise<any[]>;
    switch: (id: string) => Promise<any | null>;
    delete: (id: string) => Promise<boolean>;
    tree: (path: string, maxDepth?: number) => Promise<any>;
  };
  mcp: {
    callTool: (server: string, tool: string, params: any) => Promise<any>;
    listTools: (server: string) => Promise<any[]>;
    getStatus: () => Promise<any>;
    restart: (server: string) => Promise<void>;
    start: (server: string) => Promise<void>;
    stop: (server: string) => Promise<void>;
  };
  terminal: {
    create: (opts: any) => Promise<any>;
    write: (id: string, data: string) => Promise<void>;
    resize: (id: string, cols: number, rows: number) => Promise<void>;
    kill: (id: string) => Promise<void>;
  };
  config: {
    get: (key: string) => Promise<any>;
    set: (key: string, value: any) => Promise<void>;
    getAPIKey: () => Promise<string>;
    setAPIKey: (key: string) => Promise<void>;
  };
  conversation: {
    create: (data: any) => Promise<{ id: string }>;
    list: (opts?: any) => Promise<any[]>;
    get: (id: string) => Promise<any | null>;
    update: (id: string, data: any) => Promise<boolean>;
    delete: (id: string) => Promise<boolean>;
    batchDelete?: (ids: string[]) => Promise<boolean>;
    batchUpdate?: (ids: string[], data: any) => Promise<boolean>;
    addMessage: (message: any) => Promise<boolean>;
    // M4-2-S1：opts.systemTouch=true 时落库不刷 updated_at（切走对话的系统性保存，不改排序时间）。
    replaceMessages: (conversationId: string, messages: any[], opts?: { systemTouch?: boolean }) => Promise<boolean>;
    listMessages: (conversationId: string) => Promise<any[]>;
    search: (query: string, opts?: any) => Promise<any[]>;
    // Record（M1 上下文 harness 过程日志）
    getRecord?: (conversationId: string) => Promise<any | null>;
    saveRecord?: (data: any) => Promise<boolean>;
    deleteRecord?: (conversationId: string) => Promise<boolean>;
  };
  // Memory（M1 上下文 harness：AI 主动记忆，内置 memory_write/memory_query 工具的后端）
  memory?: {
    write: (data: any) => Promise<any | null>;
    query: (opts?: any) => Promise<any[]>;
    get: (id: string) => Promise<any | null>;
    list: (opts?: any) => Promise<any[]>;
    delete: (id: string) => Promise<boolean>;
  };
  command: {
    exec: (cmd: string, cwd?: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  // git worktree 管理 (M2-4)。Web 模式下各方法返回 { error:true, message } 降级，不崩溃。
  worktree?: {
    list: (opts: { repoRoot: string }) => Promise<WorktreeListResult>;
    create: (opts: { repoRoot: string; branch: string; path?: string; name?: string }) => Promise<WorktreeCreateResult>;
    remove: (opts: { repoRoot: string; path: string; force?: boolean }) => Promise<WorktreeRemoveResult>;
    status: (opts: { repoRoot: string; path: string }) => Promise<WorktreeStatusResult>;
  };
  // 附件分离存储 (M2-R6)。sha256 内容寻址；桌面走 IPC(文件系统)，网页走 IndexedDB。
  // 两端签名完全一致——sha256 引用层是抽象边界，上层代码不感知后端差异。
  attachment: {
    put: (opts: AttachmentPutInput) => Promise<AttachmentRef | AttachmentError>;
    get: (sha256: string) => Promise<AttachmentGetResult | null>;
    has: (sha256: string) => Promise<boolean>;
    delete: (sha256: string) => Promise<AttachmentRefCountResult | AttachmentError>;
    addRef: (sha256: string) => Promise<{ sha256: string; refCount: number } | AttachmentError>;
    release: (sha256: string) => Promise<AttachmentRefCountResult | AttachmentError>;
  };
}

declare global {
  interface Window {
    synapse?: SynapseAPI;
  }
}

// 检测是否在 Electron 环境
export const isElectron = !!(window as any).synapse?.platform?.isElectron;

// 获取平台 API（Electron 真实 API 或 Web Mock）
export function getPlatform(): SynapseAPI {
  if (isElectron && window.synapse) {
    return window.synapse;
  }
  return getWebMock();
}

// Web 模式下的 Mock 实现
function getWebMock(): SynapseAPI {
  return {
    platform: {
      info: async () => ({
        isElectron: false,
        platform: 'web',
        version: '0.1.0',
        userDataPath: '/virtual',
      }),
      isElectron: false,
    },
    window: {
      minimize: () => console.log('[Web Mock] window:minimize'),
      maximize: () => console.log('[Web Mock] window:maximize'),
      close: () => console.log('[Web Mock] window:close'),
      isMaximized: async () => false,
    },
    file: {
      exists: async () => false,
      read: async (_p) => { return ''; },
      readBinary: async (_p) => new ArrayBuffer(0),
      convertOffice: async () => ({ error: true, message: 'Web 模式暂无本地 Office 转换能力，请在 Electron 模式下打开。' }),
      cleanupTemp: async () => ({ success: true }),
      write: async (_p, _c) => { },
      list: async (_d) => { return []; },
      search: async (_d, _p) => { return []; },
      grep: async (_d, _q) => { return []; },
      rename: async () => { },
      delete: async () => { },
      mkdir: async () => { },
    },
    wallpaper: {
      importFromDialog: async () => [],
      importFiles: async () => [],
      remove: async () => ({ success: true }),
      clear: async () => ({ removed: [], errors: [] }),
    },
    workspace: {
      open: async () => null,
      recent: async () => [],
      switch: async () => null,
      delete: async () => false,
      tree: async () => ({ name: 'Web 工作区', path: '/workspace', type: 'directory', children: [] }),
    },
    mcp: {
      callTool: async () => ({ content: [{ type: 'text', text: '[Web Mock] MCP not available' }] }),
      listTools: async () => [],
      getStatus: async () => ({ servers: [] }),
      restart: async () => { },
      start: async () => { },
      stop: async () => { },
    },
    terminal: {
      create: async () => ({ id: 'mock-terminal', status: 'web-mode' }),
      write: async () => { },
      resize: async () => { },
      kill: async () => { },
    },
    config: {
      get: async (key: string) => {
        const stored = localStorage.getItem(`synapse:config:${key}`);
        return stored ? JSON.parse(stored) : null;
      },
      set: async (key: string, value: unknown) => {
        localStorage.setItem(`synapse:config:${key}`, JSON.stringify(value));
      },
      getAPIKey: async () => localStorage.getItem('synapse:apiKey') || '',
      setAPIKey: async (key) => localStorage.setItem('synapse:apiKey', key),
    },
    conversation: {
      create: async (data: any) => {
        const summaries = readWebConversationSummaries();
        if (!summaries.some((item: any) => item.id === data.id)) {
          summaries.unshift({
            id: data.id,
            title: data.title || '新对话',
            model: data.model || '',
            mode: data.mode || 'planning',
            // M2-6 对话级元数据（Web 对等）：思考层级随对话存，缺省默认 'auto'。
            reasoningEffort: data.reasoningEffort || 'auto',
            timestamp: Date.now(),
            messageCount: 0,
            lastMessage: data.lastMessage || '',
            schemaVersion: data.schemaVersion ?? 1,
            assistantRuns: data.assistantRuns ?? {},
            fileSnapshots: data.fileSnapshots ?? {},
            pendingDiffs: data.pendingDiffs ?? [],
            archived: Boolean(data.archived),
            tags: normalizeWebTags(data.tags),
            // M2-3 对话分支溯源（Web 对等）：fork 时写入，普通新建为 null。
            parentId: data.parentId ?? null,
            branchedFromMessageId: data.branchedFromMessageId ?? null,
            // M3-1a 真子代理（Web 对等）：子代理对话标记，普通对话 false。
            isSubAgent: Boolean(data.isSubAgent),
            // M4-2-S3 工作区归属（Web 对等）：path 作键，无归属为 null（Global）。
            workspacePath: data.workspacePath ?? null,
            // ★ M4-6-S4 对话目标（Web 对等）：空串/缺省 → null（未设目标）。
            goal: data.goal && String(data.goal).trim() ? String(data.goal).trim() : null,
            // ★ M5-BPC 本对话阈值覆盖（Web 对等）：合法 number（含 0）原样存，否则 null（未覆盖）。绝不用 `x||null` 吞 0。
            bpcThresholdOverride:
              typeof data.bpcThresholdOverride === 'number' && Number.isFinite(data.bpcThresholdOverride)
                ? data.bpcThresholdOverride : null,
            compactThresholdOverride:
              typeof data.compactThresholdOverride === 'number' && Number.isFinite(data.compactThresholdOverride)
                ? data.compactThresholdOverride : null,
          });
          writeWebConversationSummaries(summaries);
        }
        return { id: data.id };
      },
      list: async (opts?: any) => filterWebConversationSummaries(readWebConversationSummaries(), opts),
      get: async (id: string) => readWebConversationSummaries().find((item: any) => item.id === id) ?? null,
      update: async (id: string, data: any) => {
        const summaries = readWebConversationSummaries();
        const idx = summaries.findIndex((item: any) => item.id === id);
        if (idx >= 0) {
          // ★ M4-2-S1 systemTouch（Web 对等）：true 时不刷 updatedAt（保持排序时间，治问题9）。
          //   data.systemTouch 是控制位、非数据列，用前先从展开里剔除，避免写进 summary。
          const { systemTouch, ...patch } = data ?? {};
          summaries[idx] = {
            ...summaries[idx],
            ...patch,
            tags: patch.tags === undefined ? summaries[idx].tags : normalizeWebTags(patch.tags),
            archived: patch.archived === undefined ? Boolean(summaries[idx].archived) : Boolean(patch.archived),
            // M2-6 对话级元数据（Web 对等）：undefined 不覆盖已有值（对齐 Electron IPC 跳过 undefined 列）。
            mode: patch.mode === undefined ? (summaries[idx].mode ?? 'planning') : patch.mode,
            reasoningEffort: patch.reasoningEffort === undefined
              ? (summaries[idx].reasoningEffort ?? 'auto')
              : patch.reasoningEffort,
            // M4-2-S3：工作区归属（Web 对等）。undefined 不覆盖；显式传（含 null=Global）才改归属。
            workspacePath: patch.workspacePath === undefined
              ? (summaries[idx].workspacePath ?? null)
              : (patch.workspacePath ?? null),
            // M2-3：分支溯源仅在 create 时写定；update 传 undefined 时不覆盖已有值（对齐 Electron IPC 跳过 undefined 列）。
            parentId: patch.parentId === undefined ? (summaries[idx].parentId ?? null) : (patch.parentId ?? null),
            branchedFromMessageId: patch.branchedFromMessageId === undefined
              ? (summaries[idx].branchedFromMessageId ?? null)
              : (patch.branchedFromMessageId ?? null),
            // M3-1a：子代理标记，update 传 undefined 时不覆盖已有值（对齐 Electron IPC 跳过 undefined 列）。
            isSubAgent: patch.isSubAgent === undefined
              ? Boolean(summaries[idx].isSubAgent)
              : Boolean(patch.isSubAgent),
            // ★ M4-6-S4：对话目标（Web 对等）。undefined 不覆盖；显式传才改（空串→null=清空目标）。
            goal: patch.goal === undefined
              ? ((summaries[idx] as any).goal ?? null)
              : (String(patch.goal).trim() ? String(patch.goal).trim() : null),
            // ★ M5-BPC：本对话阈值覆盖（Web 对等）。undefined 不覆盖；显式传合法 number（含 0）才改，非数字→null。
            //   ★ 绝不用 `patch.x || 旧值` 吞 0（虽阈值现实不为 0，留作正确口径）。
            bpcThresholdOverride: patch.bpcThresholdOverride === undefined
              ? ((summaries[idx] as any).bpcThresholdOverride ?? null)
              : (typeof patch.bpcThresholdOverride === 'number' && Number.isFinite(patch.bpcThresholdOverride)
                ? patch.bpcThresholdOverride : null),
            compactThresholdOverride: patch.compactThresholdOverride === undefined
              ? ((summaries[idx] as any).compactThresholdOverride ?? null)
              : (typeof patch.compactThresholdOverride === 'number' && Number.isFinite(patch.compactThresholdOverride)
                ? patch.compactThresholdOverride : null),
            // systemTouch 时保留旧 updatedAt（排序时间不变）；否则刷新为当前时间（用户主动保存正常置顶）。
            updatedAt: systemTouch ? (summaries[idx].updatedAt ?? Date.now()) : Date.now(),
          };
          writeWebConversationSummaries(summaries);
        }
        return true;
      },
      delete: async (id: string) => {
        writeWebConversationSummaries(readWebConversationSummaries().filter((item: any) => item.id !== id));
        const messages = readWebConversationMessages();
        delete messages[id];
        localStorage.setItem('synapse:conversation:messages', JSON.stringify(messages));
        return true;
      },
      batchDelete: async (ids: string[]) => {
        const idSet = new Set(ids);
        writeWebConversationSummaries(readWebConversationSummaries().filter((item: any) => !idSet.has(item.id)));
        const messages = readWebConversationMessages();
        ids.forEach(id => delete messages[id]);
        localStorage.setItem('synapse:conversation:messages', JSON.stringify(messages));
        return true;
      },
      batchUpdate: async (ids: string[], data: any) => {
        const idSet = new Set(ids);
        writeWebConversationSummaries(readWebConversationSummaries().map((item: any) => {
          if (!idSet.has(item.id)) return item;
          return {
            ...item,
            ...data,
            tags: data.tags === undefined ? item.tags : normalizeWebTags(data.tags),
            archived: data.archived === undefined ? Boolean(item.archived) : Boolean(data.archived),
            updatedAt: Date.now(),
          };
        }));
        return true;
      },
      addMessage: async (message: any) => {
        const messages = readWebConversationMessages();
        const existing = Array.isArray(messages[message.conversationId]) ? messages[message.conversationId] : [];
        const next = existing.filter((item: any) => item.id !== message.id);
        next.push(message);
        messages[message.conversationId] = next;
        localStorage.setItem('synapse:conversation:messages', JSON.stringify(messages));
        await getWebMock().conversation.update(message.conversationId, {
          lastMessage: message.content || '',
          messageCount: next.length,
        });
        return true;
      },
      replaceMessages: async (conversationId: string, nextMessages: any[], opts?: { systemTouch?: boolean }) => {
        const messages = readWebConversationMessages();
        messages[conversationId] = nextMessages.map(message => ({ ...message, conversationId }));
        localStorage.setItem('synapse:conversation:messages', JSON.stringify(messages));
        // ★ M4-2-S1 systemTouch（Web 对等）：透传给内部 update，systemTouch 时不刷 updatedAt（治问题9）。
        await getWebMock().conversation.update(conversationId, {
          lastMessage: nextMessages[nextMessages.length - 1]?.content || '',
          messageCount: nextMessages.length,
          systemTouch: opts?.systemTouch,
        });
        return true;
      },
      listMessages: async (conversationId: string) => readWebConversationMessages()[conversationId] ?? [],
      search: async (query: string, opts?: any) => {
        const q = query.toLowerCase();
        const summaries = readWebConversationSummaries();
        const messages = readWebConversationMessages();
        const matched = summaries.filter((summary: any) => {
          const text = [
            summary.title,
            summary.lastMessage,
            ...(normalizeWebTags(summary.tags)),
            ...(messages[summary.id] ?? []).map((msg: any) => msg.content),
          ].join('\n').toLowerCase();
          return text.includes(q);
        });
        return filterWebConversationSummaries(matched, opts);
      },
      getRecord: async (conversationId: string) => readWebRecord(conversationId),
      // ★ R5 崩溃恢复（Web 对等）：writeWebRecord 是单次 localStorage.setItem(整对象 JSON)，
      //   整体写入即原子——与 Electron record:upsert 单语句对齐，配合 appendBatch 幂等保证「崩溃可恢复」。
      saveRecord: async (data: any) => {
        if (!data?.conversationId) return false;
        // ★ R5 修复（问题1/4 Web 对等）：乐观并发水位门。appendBatch 传 expectedStepStart 时，
        // 仅当现有 record 的 totalSteps（= 末批 stepEnd）等于本值才写入，否则返回 false（不写）——
        // 与 Electron SQL `WHERE total_steps=?` 对齐，杜绝交错读改写后写覆盖先写。
        // 不传（undefined）= 无条件整条覆盖（upsertRecord/clampToBatch），保持原语义。
        if (typeof data.expectedStepStart === 'number') {
          const current = readWebRecord(data.conversationId);
          const currentSteps = current?.totalSteps ?? 0;
          if (currentSteps !== data.expectedStepStart) {
            return false;
          }
        }
        writeWebRecord(data.conversationId, {
          conversationId: data.conversationId,
          // M2-R1：batches 是真相源，必须存住，否则多批写回后再读退化回单批（与 Electron 行为分叉）。
          batches: Array.isArray(data.batches) ? data.batches : undefined,
          schemaVersion: data.schemaVersion ?? 2,
          contentMd: data.contentMd ?? '',
          totalRounds: data.totalRounds ?? 0,
          totalSteps: data.totalSteps ?? 0,
          phases: data.phases ?? 0,
          lastUpdatedRound: data.lastUpdatedRound ?? 0,
          timeSpan: data.timeSpan ?? '',
          // 秒级 Unix 时间戳，与 Electron SQLite 路径及全库其它表统一单位。
          updatedAt: data.updatedAt ?? Math.floor(Date.now() / 1000),
        });
        return true;
      },
      deleteRecord: async (conversationId: string) => {
        localStorage.removeItem(webRecordKey(conversationId));
        return true;
      },
    },
    memory: {
      write: async (data: any) => {
        if (!data?.id) return null;
        const items = readWebMemories();
        const idx = items.findIndex((item: any) => item.id === data.id);
        const now = Math.floor(Date.now() / 1000);
        const next = {
          id: data.id,
          title: data.title ?? '',
          content: data.content ?? '',
          tags: normalizeWebTags(data.tags),
          category: (typeof data.category === 'string' && data.category.trim()) ? data.category.trim() : 'general',
          searchSummary: data.searchSummary ?? '',
          pinned: Boolean(data.pinned),
          conversationId: data.conversationId || undefined,
          // 更新时保留原 createdAt；秒级 Unix 时间戳，与 Electron SQLite 路径统一单位。
          createdAt: idx >= 0 ? (items[idx].createdAt ?? data.createdAt ?? now) : (data.createdAt ?? now),
          updatedAt: data.updatedAt ?? now,
        };
        if (idx >= 0) items[idx] = next; else items.unshift(next);
        writeWebMemories(items);
        return next;
      },
      query: async (opts?: any) => filterWebMemories(readWebMemories(), opts),
      get: async (id: string) => readWebMemories().find((item: any) => item.id === id) ?? null,
      list: async (opts?: any) => filterWebMemories(readWebMemories(), {
        category: opts?.category,
        pinnedOnly: opts?.pinnedOnly,
        limit: Number(opts?.limit) > 0 ? Number(opts.limit) : 100,
      }),
      delete: async (id: string) => {
        writeWebMemories(readWebMemories().filter((item: any) => item.id !== id));
        return true;
      },
    },
    command: {
      exec: async (cmd) => ({ stdout: `[Web Mock] 命令不可用: ${cmd}`, stderr: '', exitCode: 1 }),
    },
    // Web 模式无本地 git，worktree 全部降级返回明确错误（不抛异常、不崩溃）。
    worktree: {
      list: async () => ({ error: true, message: WORKTREE_WEB_ONLY }),
      create: async () => ({ error: true, message: WORKTREE_WEB_ONLY }),
      remove: async () => ({ error: true, message: WORKTREE_WEB_ONLY }),
      status: async () => ({ error: true, message: WORKTREE_WEB_ONLY }),
    },
    // 附件分离存储 Web 实现：IndexedDB 作 blob 后端，sha256 引用层与桌面完全一致。
    // ★ sha256 用 crypto.subtle.digest('SHA-256') 对原始二进制算，与 Electron node crypto 同口径——
    //   同一二进制两端算出同一 sha256（抽象边界），保证桌面/网页引用可互通。
    attachment: {
      put: webAttachmentPut,
      get: webAttachmentGet,
      has: webAttachmentHas,
      delete: webAttachmentRelease,
      addRef: webAttachmentAddRef,
      release: webAttachmentRelease,
    },
  };
}

function readWebConversationSummaries(): any[] {
  try {
    return JSON.parse(localStorage.getItem('synapse:conversation:summaries') || '[]');
  } catch {
    return [];
  }
}

function writeWebConversationSummaries(summaries: any[]): void {
  localStorage.setItem('synapse:conversation:summaries', JSON.stringify(summaries));
}

function readWebConversationMessages(): Record<string, any[]> {
  try {
    return JSON.parse(localStorage.getItem('synapse:conversation:messages') || '{}');
  } catch {
    return {};
  }
}

// ===== Record（M1 上下文 harness 过程日志，按 synapse:record:<conversationId> 分键存储）=====

function webRecordKey(conversationId: string): string {
  return `synapse:record:${conversationId}`;
}

function readWebRecord(conversationId: string): any | null {
  if (!conversationId) return null;
  try {
    const raw = localStorage.getItem(webRecordKey(conversationId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeWebRecord(conversationId: string, record: any): void {
  localStorage.setItem(webRecordKey(conversationId), JSON.stringify(record));
}

// ===== Memory（M1 上下文 harness：AI 主动记忆，按 synapse:memory:items 整存数组）=====

const WEB_MEMORY_KEY = 'synapse:memory:items';

function readWebMemories(): any[] {
  try {
    const raw = JSON.parse(localStorage.getItem(WEB_MEMORY_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeWebMemories(items: any[]): void {
  localStorage.setItem(WEB_MEMORY_KEY, JSON.stringify(items));
}

/**
 * Web 端记忆过滤：对齐 Electron memory:query —— 关键词命中 title/content/searchSummary/tags，
 * 叠加 category / pinnedOnly 过滤，按 pinned 优先、updatedAt 倒序，受 limit 约束。
 *
 * ⚠️ tags 命中口径与 Electron（electron/ipc/memory.ts buildMemoryFilters）有已知小差异：
 *    此处先把 tags 解析成数组、用 \n join 再做 includes（不含 JSON 结构字符）；
 *    Electron 端是对 tags_json 原始 JSON 串做 LIKE（含 [ ] " , 等）。常规标签查询两者一致，
 *    仅 query 含 JSON 元字符时 Electron 可能多命中。tags 为次要信号，差异可接受，详见对端注释。
 */
function filterWebMemories(items: any[], opts?: any): any[] {
  const q = String(opts?.query ?? '').trim().toLowerCase();
  const category = String(opts?.category ?? '').trim();
  const pinnedOnly = Boolean(opts?.pinnedOnly);
  const limit = Number(opts?.limit) > 0 ? Math.min(Number(opts.limit), 200) : 50;
  return items
    .map(item => ({
      ...item,
      tags: normalizeWebTags(item.tags),
      pinned: Boolean(item.pinned),
      category: item.category || 'general',
    }))
    .filter(item => {
      if (category && item.category !== category) return false;
      if (pinnedOnly && !item.pinned) return false;
      if (q) {
        const text = [item.title, item.content, item.searchSummary, ...(item.tags ?? [])]
          .join('\n')
          .toLowerCase();
        // 拆词检索：query 拆成多个 term，任一 term 命中即算命中（OR 宽召回），与 Electron 端口径一致。
        const terms = q.split(/[\s,，、;；]+/).map(t => t.trim()).filter(Boolean);
        const effectiveTerms = terms.length ? terms : [q];
        if (!effectiveTerms.some(term => text.includes(term))) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    })
    .slice(0, limit);
}

function normalizeWebTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map(tag => String(tag).trim()).filter(Boolean))].slice(0, 12);
}

function filterWebConversationSummaries(summaries: any[], opts?: any): any[] {
  const archived = opts?.archived ?? 'active';
  const tags = normalizeWebTags(opts?.tags).map(tag => tag.toLowerCase());
  const limit = Number(opts?.limit) > 0 ? Number(opts.limit) : 100;
  // M4-2-S3 工作区归属三态（Web 对等）：globalOnly 优先（只显无归属）；否则 workspacePath 为具体非空串时
  //   只显该工作区；两者都不满足则不限（全部）。老数据无 workspacePath 字段 → null/undefined 视为 Global。
  const globalOnly = Boolean(opts?.globalOnly);
  const wantWorkspacePath = typeof opts?.workspacePath === 'string' && opts.workspacePath ? opts.workspacePath : null;
  return summaries
    .map(summary => ({
      ...summary,
      archived: Boolean(summary.archived),
      tags: normalizeWebTags(summary.tags),
    }))
    .filter(summary => {
      if (archived === 'active' && summary.archived) return false;
      if (archived === 'archived' && !summary.archived) return false;
      if (tags.length) {
        const summaryTags = new Set(normalizeWebTags(summary.tags).map(tag => tag.toLowerCase()));
        if (!tags.every(tag => summaryTags.has(tag))) return false;
      }
      // 归属过滤（与 Electron buildConversationFilters 三态对齐）。
      const summaryWs = (typeof summary.workspacePath === 'string' && summary.workspacePath) ? summary.workspacePath : null;
      if (globalOnly) {
        if (summaryWs !== null) return false;
      } else if (wantWorkspacePath) {
        if (summaryWs !== wantWorkspacePath) return false;
      }
      return true;
    })
    .slice(0, limit);
}

// ===== 附件分离存储 Web 实现（IndexedDB blob 后端） =====
//
// sha256 引用层是抽象边界：本段函数与 Electron ipc/attachment.ts 上层语义完全对齐
// （put 去重 / get 还原 dataUrl / has / refCount-1 归零 GC），仅 blob 落地用 IndexedDB。
//
// 库结构：DB「synapse-attachments」内两个 object store：
//   - 'blobs'  : key=sha256, value=Uint8Array（实体原始二进制，与桌面落盘字节一致）
//   - 'meta'   : key=sha256, value={ mime, kind, size, refCount, createdAt }（账本，对齐 attachments 表）

const ATTACHMENT_DB_NAME = 'synapse-attachments';
const ATTACHMENT_DB_VERSION = 1;
const ATTACHMENT_BLOB_STORE = 'blobs';
const ATTACHMENT_META_STORE = 'meta';
const MAX_WEB_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

interface WebAttachmentMeta {
  mime: string;
  kind: string;
  size: number;
  refCount: number;
  createdAt: number;
}

let attachmentDbPromise: Promise<IDBDatabase> | null = null;

/** 打开（并缓存）IndexedDB 连接；首次/升级时建两个 store。 */
function openAttachmentDb(): Promise<IDBDatabase> {
  if (attachmentDbPromise) return attachmentDbPromise;
  attachmentDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB，附件存储不可用'));
      return;
    }
    const req = indexedDB.open(ATTACHMENT_DB_NAME, ATTACHMENT_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ATTACHMENT_BLOB_STORE)) {
        db.createObjectStore(ATTACHMENT_BLOB_STORE);
      }
      if (!db.objectStoreNames.contains(ATTACHMENT_META_STORE)) {
        db.createObjectStore(ATTACHMENT_META_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
  });
  // 打开失败时清掉缓存，下次可重试。
  attachmentDbPromise.catch(() => { attachmentDbPromise = null; });
  return attachmentDbPromise;
}

/** 把 IDBRequest 包成 Promise。 */
function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 请求失败'));
  });
}

/** 读单 store 单 key（只读事务）。 */
async function idbGet<T>(storeName: string, key: string): Promise<T | undefined> {
  const db = await openAttachmentDb();
  const tx = db.transaction(storeName, 'readonly');
  const result = await idbRequest<T>(tx.objectStore(storeName).get(key) as IDBRequest<T>);
  return result === null ? undefined : result;
}

/**
 * sha256(原始二进制) → 64 位小写 hex，用 Web Crypto。
 * 与 Electron node crypto.createHash('sha256') 对同一字节序列结果一致（抽象边界保证）。
 */
async function webSha256(bytes: Uint8Array): Promise<string | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null;
  // 拷进一个确定的 ArrayBuffer 再传 digest：
  //   1) 规避 byteOffset/共享 buffer 导致的哈希错算（只哈希本视图覆盖的字节）；
  //   2) 满足 TS（ES2023 lib 下 Uint8Array.buffer 推断为 ArrayBufferLike，digest 要求 ArrayBuffer）。
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 解析 dataUrl / 纯 base64 → { bytes, mimeFromDataUrl? }。与 Electron decodePayload 同口径。
 */
function webDecodePayload(input: unknown): { bytes: Uint8Array; mimeFromDataUrl?: string } | null {
  if (typeof input !== 'string' || !input) return null;
  let base64 = input.trim();
  let mimeFromDataUrl: string | undefined;

  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(base64);
  if (m) {
    const declaredMime = m[1]?.trim();
    const isBase64 = !!m[2];
    const payload = m[3] ?? '';
    if (declaredMime) mimeFromDataUrl = declaredMime;
    if (!isBase64) {
      try {
        return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mimeFromDataUrl };
      } catch {
        return null;
      }
    }
    base64 = payload;
  }

  base64 = base64.replace(/\s/g, '');
  if (!base64) return null;
  try {
    // 注：解码（atob + 逐字节）是【写入路径】，仅在用户主动上传/懒迁移时触发（一次性、低频），
    // 不像 get 那样每次渲染历史图都跑——故保持同步。真正的高频 UI 阻塞点是 get 的 base64 编码，
    // 已改 FileReader 异步（见 bytesToDataUrl）。atob 遇字符集外字符直接抛错 → 拒收，与 Electron
    // 解码前的字符集严格校验对等（同一坏输入两端都拒收，绝不分叉）。
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (bytes.length === 0) return null;
    return { bytes, mimeFromDataUrl };
  } catch {
    return null;
  }
}

/** Uint8Array → base64（同步分块，避免大数组爆栈）。仅在 FileReader 不可用时兜底。 */
function bytesToBase64Sync(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Uint8Array → `data:<mime>;base64,...`（异步，不阻塞 UI 线程）。
 * ★ 性能修复：旧路径用 String.fromCharCode(...chunk) 展开 + 字符串累加 + btoa，全在渲染主线程同步执行，
 *   50MB 附件 get 还原成 ~67MB base64 会明显卡 UI（每次渲染历史图都触发）。
 *   改用 FileReader.readAsDataURL（浏览器原生 C++ 实现、异步回调），把 base64 编码挪出 JS 主线程，
 *   且产出仍是标准 dataUrl —— get 返回契约不变，发 API（需 base64）与 Electron 端对等都保持。
 *   FileReader 不可用（极端环境）时降级回同步实现，保证功能不丢。
 */
function bytesToDataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  if (typeof FileReader === 'undefined' || typeof Blob === 'undefined') {
    return Promise.resolve(`data:${mime};base64,${bytesToBase64Sync(bytes)}`);
  }
  return new Promise<string>((resolve, reject) => {
    try {
      // 拷进独立 ArrayBuffer，规避 byteOffset/共享 buffer 把多余字节带进 Blob。
      const buf = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buf).set(bytes);
      const blob = new Blob([buf], { type: mime || 'application/octet-stream' });
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result === 'string') resolve(result);
        else reject(new Error('FileReader 结果非字符串'));
      };
      reader.onerror = () => reject(reader.error ?? new Error('FileReader 读取失败'));
      reader.readAsDataURL(blob);
    } catch (err) {
      // 同步降级，避免编码彻底失败。
      try {
        resolve(`data:${mime};base64,${bytesToBase64Sync(bytes)}`);
      } catch {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  });
}

async function webAttachmentPut(opts: AttachmentPutInput): Promise<AttachmentRef | AttachmentError> {
  const decoded = webDecodePayload(opts?.data);
  if (!decoded) return { error: true, message: '附件载荷为空或无法解析（需 dataUrl 或 base64）' };
  const { bytes } = decoded;
  if (bytes.length > MAX_WEB_ATTACHMENT_BYTES) {
    return { error: true, message: `附件超过 ${Math.floor(MAX_WEB_ATTACHMENT_BYTES / 1024 / 1024)}MB 限制` };
  }

  const sha256 = await webSha256(bytes);
  if (!sha256) return { error: true, message: '当前环境不支持 Web Crypto（需安全上下文），无法计算 sha256' };

  const mime = (typeof opts?.mime === 'string' && opts.mime.trim())
    ? opts.mime.trim()
    : (decoded.mimeFromDataUrl || 'application/octet-stream');
  const kind = (typeof opts?.kind === 'string' && opts.kind.trim()) ? opts.kind.trim() : 'file';
  const name = (typeof opts?.name === 'string') ? opts.name : '';
  const size = bytes.length;

  try {
    const db = await openAttachmentDb();
    // ★ 修复 TOCTOU 竞态：把「读 existing → 决定 +1 或新建」收进同一个 readwrite 事务内完成。
    //   IndexedDB 同事务内 get 拿到的是本事务的一致快照，读-改-写在一个事务里串行原子，
    //   与 Electron 单语句 `INSERT ... ON CONFLICT DO UPDATE ref_count+1` 的原子 upsert 对齐。
    //   旧写法分两个事务（先 readonly get、再 readwrite put）：同一 sha256 并发 put 时两路都可能
    //   读到 existing=null → 各写一次 refCount:1，最终停在 1 而非 2，引用计数被低估 → 提前 GC。
    const persisted = await new Promise<WebAttachmentMeta>((resolve, reject) => {
      const tx = db.transaction([ATTACHMENT_BLOB_STORE, ATTACHMENT_META_STORE], 'readwrite');
      const metaStore = tx.objectStore(ATTACHMENT_META_STORE);
      let result: WebAttachmentMeta;
      const getReq = metaStore.get(sha256) as IDBRequest<WebAttachmentMeta | undefined>;
      getReq.onsuccess = () => {
        const existing = getReq.result ?? undefined;
        if (existing) {
          // 去重命中：仅 refCount+1（blob 已在，不重复写）。
          result = { ...existing, refCount: existing.refCount + 1 };
          metaStore.put(result, sha256);
        } else {
          result = { mime, kind, size, refCount: 1, createdAt: Math.floor(Date.now() / 1000) };
          tx.objectStore(ATTACHMENT_BLOB_STORE).put(bytes, sha256);
          metaStore.put(result, sha256);
        }
      };
      getReq.onerror = () => reject(getReq.error ?? new Error('IndexedDB 读取失败'));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 写入失败'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'));
    });
    return { sha256, size: persisted.size || size, mime: persisted.mime || mime, kind: persisted.kind || kind, name };
  } catch (err: any) {
    return { error: true, message: `附件写入失败: ${err?.message ?? err}` };
  }
}

async function webAttachmentGet(sha256: string): Promise<AttachmentGetResult | null> {
  if (typeof sha256 !== 'string' || !SHA256_HEX_RE.test(sha256.toLowerCase())) return null;
  const key = sha256.toLowerCase();
  try {
    const meta = await idbGet<WebAttachmentMeta>(ATTACHMENT_META_STORE, key);
    const blob = await idbGet<Uint8Array>(ATTACHMENT_BLOB_STORE, key);
    if (!blob) return null;
    const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob as ArrayBuffer);
    const mime = meta?.mime || 'application/octet-stream';
    return {
      sha256: key,
      mime,
      size: meta?.size ?? bytes.length,
      // 异步 FileReader 编码，base64 转换不阻塞 UI 线程（见 bytesToDataUrl 注释）。
      dataUrl: await bytesToDataUrl(bytes, mime),
    };
  } catch {
    return null;
  }
}

async function webAttachmentHas(sha256: string): Promise<boolean> {
  if (typeof sha256 !== 'string' || !SHA256_HEX_RE.test(sha256.toLowerCase())) return false;
  const key = sha256.toLowerCase();
  try {
    const meta = await idbGet<WebAttachmentMeta>(ATTACHMENT_META_STORE, key);
    if (!meta) return false;
    const blob = await idbGet<Uint8Array>(ATTACHMENT_BLOB_STORE, key);
    return blob != null;
  } catch {
    return false;
  }
}

async function webAttachmentAddRef(sha256: string): Promise<{ sha256: string; refCount: number } | AttachmentError> {
  if (typeof sha256 !== 'string' || !SHA256_HEX_RE.test(sha256.toLowerCase())) {
    return { error: true, message: '非法 sha256' };
  }
  const key = sha256.toLowerCase();
  try {
    const meta = await idbGet<WebAttachmentMeta>(ATTACHMENT_META_STORE, key);
    if (!meta) return { error: true, message: '附件不存在，无法 addRef（请先 put）' };
    const next: WebAttachmentMeta = { ...meta, refCount: meta.refCount + 1 };
    const db = await openAttachmentDb();
    await idbRequest(db.transaction(ATTACHMENT_META_STORE, 'readwrite').objectStore(ATTACHMENT_META_STORE).put(next, key));
    return { sha256: key, refCount: next.refCount };
  } catch (err: any) {
    return { error: true, message: `addRef 失败: ${err?.message ?? err}` };
  }
}

/** refCount-1，归零删 blob + meta（GC）。delete/release 共用。 */
async function webAttachmentRelease(sha256: string): Promise<AttachmentRefCountResult | AttachmentError> {
  if (typeof sha256 !== 'string' || !SHA256_HEX_RE.test(sha256.toLowerCase())) {
    return { error: true, message: '非法 sha256' };
  }
  const key = sha256.toLowerCase();
  try {
    const meta = await idbGet<WebAttachmentMeta>(ATTACHMENT_META_STORE, key);
    if (!meta) return { sha256: key, refCount: 0, deleted: true };
    const nextRef = meta.refCount - 1;
    const db = await openAttachmentDb();
    if (nextRef > 0) {
      const next: WebAttachmentMeta = { ...meta, refCount: nextRef };
      await idbRequest(db.transaction(ATTACHMENT_META_STORE, 'readwrite').objectStore(ATTACHMENT_META_STORE).put(next, key));
      return { sha256: key, refCount: nextRef, deleted: false };
    }
    // 归零：一个事务里同时删 blob + meta。
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([ATTACHMENT_BLOB_STORE, ATTACHMENT_META_STORE], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 删除失败'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'));
      tx.objectStore(ATTACHMENT_BLOB_STORE).delete(key);
      tx.objectStore(ATTACHMENT_META_STORE).delete(key);
    });
    return { sha256: key, refCount: 0, deleted: true };
  } catch (err: any) {
    return { error: true, message: `release 失败: ${err?.message ?? err}` };
  }
}

// 导出单例
export const platform = getPlatform();

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
    replaceMessages: (conversationId: string, messages: any[]) => Promise<boolean>;
    listMessages: (conversationId: string) => Promise<any[]>;
    search: (query: string, opts?: any) => Promise<any[]>;
    // Record（M1 上下文 harness 过程日志）
    getRecord?: (conversationId: string) => Promise<any | null>;
    saveRecord?: (data: any) => Promise<boolean>;
    deleteRecord?: (conversationId: string) => Promise<boolean>;
  };
  command: {
    exec: (cmd: string, cwd?: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
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
            timestamp: Date.now(),
            messageCount: 0,
            lastMessage: data.lastMessage || '',
            schemaVersion: data.schemaVersion ?? 1,
            assistantRuns: data.assistantRuns ?? {},
            fileSnapshots: data.fileSnapshots ?? {},
            pendingDiffs: data.pendingDiffs ?? [],
            archived: Boolean(data.archived),
            tags: normalizeWebTags(data.tags),
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
          summaries[idx] = {
            ...summaries[idx],
            ...data,
            tags: data.tags === undefined ? summaries[idx].tags : normalizeWebTags(data.tags),
            archived: data.archived === undefined ? Boolean(summaries[idx].archived) : Boolean(data.archived),
            updatedAt: Date.now(),
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
      replaceMessages: async (conversationId: string, nextMessages: any[]) => {
        const messages = readWebConversationMessages();
        messages[conversationId] = nextMessages.map(message => ({ ...message, conversationId }));
        localStorage.setItem('synapse:conversation:messages', JSON.stringify(messages));
        await getWebMock().conversation.update(conversationId, {
          lastMessage: nextMessages[nextMessages.length - 1]?.content || '',
          messageCount: nextMessages.length,
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
      saveRecord: async (data: any) => {
        if (!data?.conversationId) return false;
        writeWebRecord(data.conversationId, {
          conversationId: data.conversationId,
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
    command: {
      exec: async (cmd) => ({ stdout: `[Web Mock] 命令不可用: ${cmd}`, stderr: '', exitCode: 1 }),
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

function normalizeWebTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map(tag => String(tag).trim()).filter(Boolean))].slice(0, 12);
}

function filterWebConversationSummaries(summaries: any[], opts?: any): any[] {
  const archived = opts?.archived ?? 'active';
  const tags = normalizeWebTags(opts?.tags).map(tag => tag.toLowerCase());
  const limit = Number(opts?.limit) > 0 ? Number(opts.limit) : 100;
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
      return true;
    })
    .slice(0, limit);
}

// 导出单例
export const platform = getPlatform();

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('synapse', {
  // 平台信息
  platform: {
    info: () => ipcRenderer.invoke('platform:info'),
    isElectron: true,
  },

  // 窗口操作
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  },

  // 文件操作 (Stage 4 实现)
  file: {
    exists: (filePath: string) => ipcRenderer.invoke('file:exists', filePath),
    read: (filePath: string) => ipcRenderer.invoke('file:read', filePath),
    readBinary: (filePath: string) => ipcRenderer.invoke('file:readBinary', filePath),
    convertOffice: (filePath: string) => ipcRenderer.invoke('file:convertOffice', filePath),
    cleanupTemp: (targetPath: string) => ipcRenderer.invoke('file:cleanupTemp', targetPath),
    write: (filePath: string, content: string) => ipcRenderer.invoke('file:write', filePath, content),
    list: (dir: string) => ipcRenderer.invoke('file:list', dir),
    search: (dir: string, pattern: string) => ipcRenderer.invoke('file:search', dir, pattern),
    grep: (dir: string, query: string, opts: any) => ipcRenderer.invoke('file:grep', dir, query, opts),
    rename: (oldPath: string, newPath: string) => ipcRenderer.invoke('file:rename', oldPath, newPath),
    delete: (targetPath: string) => ipcRenderer.invoke('file:delete', targetPath),
    mkdir: (targetPath: string) => ipcRenderer.invoke('file:mkdir', targetPath),
  },

  wallpaper: {
    importFromDialog: () => ipcRenderer.invoke('wallpaper:importFromDialog'),
    importFiles: (filePaths: string[]) => ipcRenderer.invoke('wallpaper:importFiles', filePaths),
    remove: (asset: any) => ipcRenderer.invoke('wallpaper:remove', asset),
    clear: (assets: any[]) => ipcRenderer.invoke('wallpaper:clear', assets),
  },

  // 工作区操作
  workspace: {
    open: () => ipcRenderer.invoke('workspace:open'),
    recent: (limit?: number) => ipcRenderer.invoke('workspace:recent', limit),
    switch: (id: string) => ipcRenderer.invoke('workspace:switch', id),
    delete: (id: string) => ipcRenderer.invoke('workspace:delete', id),
    tree: (wsPath: string, maxDepth?: number) => ipcRenderer.invoke('workspace:tree', wsPath, maxDepth),
  },

  // MCP 操作 (Stage 8 实现)
  mcp: {
    callTool: (server: string, tool: string, params: any) =>
      ipcRenderer.invoke('mcp:callTool', server, tool, params),
    listTools: (server: string) => ipcRenderer.invoke('mcp:listTools', server),
    getStatus: () => ipcRenderer.invoke('mcp:status'),
    restart: (server: string) => ipcRenderer.invoke('mcp:restart', server),
    start: (server: string) => ipcRenderer.invoke('mcp:start', server),
    stop: (server: string) => ipcRenderer.invoke('mcp:stop', server),
    // ★ MCP 竞态修复：订阅主进程广播的「server 状态变更（已就绪 running）」事件。
    //   主进程在 server initialize 握手成功后 webContents.send('mcp:status-changed', {name})，
    //   渲染端 mcpBridge 据此自动 refresh() 补注册 mcp__* 工具。返回取消订阅函数。
    onStatusChanged: (cb: (payload: { name: string; status: string }) => void) => {
      const listener = (_e: any, payload: { name: string; status: string }) => cb(payload);
      ipcRenderer.on('mcp:status-changed', listener);
      return () => ipcRenderer.removeListener('mcp:status-changed', listener);
    },
  },

  // 命令执行 (Stage 7 实现)
  command: {
    exec: (cmd: string, cwd?: string) => ipcRenderer.invoke('command:exec', cmd, cwd),
  },

  // git worktree 管理 (M2-4)
  worktree: {
    list: (opts: { repoRoot: string }) => ipcRenderer.invoke('worktree:list', opts),
    create: (opts: { repoRoot: string; branch: string; path?: string; name?: string }) =>
      ipcRenderer.invoke('worktree:create', opts),
    remove: (opts: { repoRoot: string; path: string; force?: boolean }) =>
      ipcRenderer.invoke('worktree:remove', opts),
    status: (opts: { repoRoot: string; path: string }) => ipcRenderer.invoke('worktree:status', opts),
  },

  // 附件分离存储 (M2-R6) — 内容寻址 blob 层。桌面走 IPC，落 userData/attachments/。
  attachment: {
    put: (opts: { data: string; mime?: string; name?: string; kind?: string }) =>
      ipcRenderer.invoke('attachment:put', opts),
    get: (sha256: string) => ipcRenderer.invoke('attachment:get', sha256),
    has: (sha256: string) => ipcRenderer.invoke('attachment:has', sha256),
    delete: (sha256: string) => ipcRenderer.invoke('attachment:delete', sha256),
    addRef: (sha256: string) => ipcRenderer.invoke('attachment:addRef', sha256),
    release: (sha256: string) => ipcRenderer.invoke('attachment:release', sha256),
  },

  // 终端 (Stage 13 实现)
  terminal: {
    create: (opts: any) => ipcRenderer.invoke('terminal:create', opts),
    write: (id: string, data: string) => ipcRenderer.invoke('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
    kill: (id: string) => ipcRenderer.invoke('terminal:kill', id),
  },

  // 设置 (Stage 12 实现)
  config: {
    get: (key: string) => ipcRenderer.invoke('config:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('config:set', key, value),
    getAPIKey: () => ipcRenderer.invoke('config:getAPIKey'),
    setAPIKey: (key: string) => ipcRenderer.invoke('config:setAPIKey', key),
  },

  // 对话持久化
  conversation: {
    create: (data: any) => ipcRenderer.invoke('conversation:create', data),
    list: (opts?: any) => ipcRenderer.invoke('conversation:list', opts),
    get: (id: string) => ipcRenderer.invoke('conversation:get', id),
    update: (id: string, data: any) => ipcRenderer.invoke('conversation:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('conversation:delete', id),
    batchDelete: (ids: string[]) => ipcRenderer.invoke('conversation:batchDelete', ids),
    batchUpdate: (ids: string[], data: any) => ipcRenderer.invoke('conversation:batchUpdate', ids, data),
    addMessage: (message: any) => ipcRenderer.invoke('message:add', message),
    // M4-2-S1：透传 opts.systemTouch（切走对话的系统性保存不刷 updated_at）。
    replaceMessages: (conversationId: string, messages: any[], opts?: { systemTouch?: boolean }) =>
      ipcRenderer.invoke('message:replaceConversation', conversationId, messages, opts),
    listMessages: (conversationId: string) => ipcRenderer.invoke('message:list', conversationId),
    search: (query: string, opts?: any) => ipcRenderer.invoke('conversation:search', query, opts),
    // Record（M1 上下文 harness 过程日志）
    getRecord: (conversationId: string) => ipcRenderer.invoke('record:get', conversationId),
    saveRecord: (data: any) => ipcRenderer.invoke('record:upsert', data),
    deleteRecord: (conversationId: string) => ipcRenderer.invoke('record:delete', conversationId),
  },

  // Memory（M1 上下文 harness：AI 主动记忆，内置 memory_write/memory_query 工具的后端）
  memory: {
    write: (data: any) => ipcRenderer.invoke('memory:write', data),
    query: (opts?: any) => ipcRenderer.invoke('memory:query', opts),
    get: (id: string) => ipcRenderer.invoke('memory:get', id),
    list: (opts?: any) => ipcRenderer.invoke('memory:list', opts),
    delete: (id: string) => ipcRenderer.invoke('memory:delete', id),
  },
});

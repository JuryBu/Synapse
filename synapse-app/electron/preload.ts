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
  },

  // 命令执行 (Stage 7 实现)
  command: {
    exec: (cmd: string, cwd?: string) => ipcRenderer.invoke('command:exec', cmd, cwd),
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
    replaceMessages: (conversationId: string, messages: any[]) =>
      ipcRenderer.invoke('message:replaceConversation', conversationId, messages),
    listMessages: (conversationId: string) => ipcRenderer.invoke('message:list', conversationId),
    search: (query: string, opts?: any) => ipcRenderer.invoke('conversation:search', query, opts),
  },
});

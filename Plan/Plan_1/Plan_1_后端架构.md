# Plan_1_后端架构: Electron 主进程与服务层

> 主进程负责窗口管理、文件系统、MCP 生命周期、本地服务器管理。

---

## 1. 主进程架构

```
electron/
├── main.ts                # 入口：窗口创建、IPC 注册、服务启动
├── preload.ts             # 预加载脚本（安全 IPC 桥接）
├── ipc/
│   ├── index.ts           # IPC 处理器注册中心
│   ├── fileHandlers.ts    # 文件操作处理器
│   ├── mcpHandlers.ts     # MCP 相关处理器
│   ├── terminalHandlers.ts# 终端管理处理器
│   └── serverHandlers.ts  # 本地服务器处理器
├── mcp/
│   ├── mcpManager.ts      # MCP 服务器生命周期管理
│   ├── mcpProcess.ts      # 单个 MCP 服务器进程封装
│   └── mcpConfig.ts       # 配置读取和校验
├── servers/
│   ├── localServer.ts     # 本地开发服务器管理
│   └── staticServer.ts    # 静态文件服务
├── terminal/
│   ├── terminalManager.ts # 终端实例管理
│   └── ptyBridge.ts       # node-pty 桥接
└── utils/
    ├── config.ts          # 全局配置管理
    ├── logger.ts          # 日志系统
    └── security.ts        # API Key 加密存储
```

---

## 2. IPC 通信设计

### 2.1 预加载脚本（安全桥接）

```typescript
// electron/preload.ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('synapse', {
  // 文件操作
  file: {
    read: (path: string) => ipcRenderer.invoke('file:read', path),
    write: (path: string, content: string) => ipcRenderer.invoke('file:write', path, content),
    list: (dir: string) => ipcRenderer.invoke('file:list', dir),
    search: (dir: string, pattern: string) => ipcRenderer.invoke('file:search', dir, pattern),
    grep: (dir: string, query: string, opts: any) => ipcRenderer.invoke('file:grep', dir, query, opts),
    watch: (dir: string, callback: Function) => { /* ... */ },
  },
  
  // MCP 操作
  mcp: {
    callTool: (server: string, tool: string, params: any) => 
      ipcRenderer.invoke('mcp:callTool', server, tool, params),
    listTools: (server: string) => ipcRenderer.invoke('mcp:listTools', server),
    getStatus: () => ipcRenderer.invoke('mcp:status'),
    restart: (server: string) => ipcRenderer.invoke('mcp:restart', server),
  },
  
  // 终端
  terminal: {
    create: (opts: any) => ipcRenderer.invoke('terminal:create', opts),
    write: (id: string, data: string) => ipcRenderer.invoke('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
    onData: (id: string, callback: (data: string) => void) => { /* ... */ },
    kill: (id: string) => ipcRenderer.invoke('terminal:kill', id),
  },
  
  // 本地服务器
  server: {
    start: (dir: string, port?: number) => ipcRenderer.invoke('server:start', dir, port),
    stop: (id: string) => ipcRenderer.invoke('server:stop', id),
    list: () => ipcRenderer.invoke('server:list'),
  },
  
  // 设置
  config: {
    get: (key: string) => ipcRenderer.invoke('config:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('config:set', key, value),
    getAPIKey: () => ipcRenderer.invoke('config:getAPIKey'),
    setAPIKey: (key: string) => ipcRenderer.invoke('config:setAPIKey', key),
  },
  
  // 窗口
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
  },
});
```

---

## 3. 工具执行框架

### 3.1 工具注册表

```typescript
// services/tools/toolRegistry.ts
class ToolRegistry {
  private tools: Map<string, ToolHandler> = new Map();
  
  // 注册内置工具
  registerBuiltin(name: string, handler: ToolHandler, schema: ToolSchema): void;
  
  // 注册 MCP 工具（动态，来自 MCP 服务器）
  registerMCP(serverName: string, tools: MCPToolDef[]): void;
  
  // 获取所有工具的 JSON Schema（用于系统提示注入）
  getAllSchemas(): FunctionSchema[];
  
  // 执行工具调用
  async execute(toolName: string, params: any): Promise<ToolResult>;
}

interface ToolHandler {
  execute(params: any): Promise<ToolResult>;
  schema: ToolSchema;
  requiresApproval?: boolean;  // 是否需要用户审批
}

interface ToolResult {
  content: { type: 'text' | 'image'; text?: string; data?: string }[];
  isError?: boolean;
}
```

### 3.2 用户审批机制

危险操作（文件删除、系统命令）需要用户确认：

```typescript
async function executeWithApproval(tool: ToolHandler, params: any): Promise<ToolResult> {
  if (tool.requiresApproval && !params.SafeToAutoRun) {
    // 展示审批 UI（弹窗：显示要执行的操作，确认/取消按钮）
    const approved = await showApprovalDialog(tool.name, params);
    if (!approved) {
      return { content: [{ type: 'text', text: '用户取消了此操作' }] };
    }
  }
  return tool.execute(params);
}
```

---

## 4. API Key 安全存储

使用 Electron 的 `safeStorage` API 加密存储 API Key：

```typescript
// electron/utils/security.ts
import { safeStorage } from 'electron';

export function encryptAPIKey(key: string): Buffer {
  return safeStorage.encryptString(key);
}

export function decryptAPIKey(encrypted: Buffer): string {
  return safeStorage.decryptString(encrypted);
}

// 存储在 ~/.synapse/credentials.enc
```

---

## 5. 本地服务器管理

```typescript
// electron/servers/localServer.ts
class LocalServerManager {
  private servers: Map<string, { proc: ChildProcess; port: number; dir: string }> = new Map();
  
  // 启动静态文件服务（用于展示模式）
  async startStatic(directory: string, preferredPort?: number): Promise<{ id: string; port: number; url: string }>;
  
  // 自动检测可用端口
  private async findAvailablePort(preferred: number): Promise<number>;
  
  // 停止服务器
  async stop(id: string): Promise<void>;
  
  // 列出运行中的服务器
  list(): ServerInfo[];
}
```

使用内置的 `http` 模块或轻量的 `serve-static` 实现，无需依赖 express。

---

## 6. 数据存储方案

| 数据类型 | 存储位置 | 格式 | 说明 |
|---|---|---|---|
| 用户设置 | `~/.synapse/settings.json` | JSON | 轻量配置，JSON 足够 |
| API Key | `~/.synapse/credentials.enc` | 加密二进制 | Electron safeStorage |
| MCP 配置 | `~/.synapse/mcp_config.json` | JSON | 轻量配置 |
| **对话历史** | `~/.synapse/synapse.db` | **SQLite** | conversations + messages 表 |
| **工作区** | `~/.synapse/synapse.db` | **SQLite** | workspaces 表 |
| **学习记录** | `~/.synapse/synapse.db` | **SQLite** | learning_records 表 |
| **CHECKPOINT** | `~/.synapse/synapse.db` | **SQLite** | checkpoints 表 |
| Synopsis 索引 | `工作区/.synapse/synopsis.json` | JSON | 工作区级，跟随目录 |
| 工作区状态 | `工作区/.synapse/state.json` | JSON | 编辑器标签、面板大小等 |
| 最近工作区 | `~/.synapse/recent_workspaces.json` | JSON | 轻量列表 |
| 全局规则 | `~/.synapse/SYNAPSE.md` | Markdown | 用户可编辑 |
| 全局技能 | `~/.synapse/skills/` | 目录 | SKILL.md 文件 |
| 全局工作流 | `~/.synapse/global_workflows/` | 目录 | Workflow .md 文件 |

> 💡 **设计原则**：高频读写的结构化数据（对话、消息、工作区）用 SQLite；低频、用户可手动编辑的配置用 JSON/Markdown。

---

## 7. 多窗口架构与并发控制

### 7.1 多窗口支持

Electron 支持多 BrowserWindow，每个窗口可以打开不同工作区：

```typescript
// electron/main.ts
class WindowManager {
  private windows: Map<number, { win: BrowserWindow; workspacePath: string | null }> = new Map();
  
  createWindow(workspacePath?: string): BrowserWindow {
    // 检查工作区锁
    if (workspacePath && !WorkspaceLock.acquire(workspacePath)) {
      dialog.showErrorBox('工作区已被占用', 
        '该工作区已在另一个 Synapse 窗口中打开。\n请关闭那个窗口或选择其他工作区。');
      return null;
    }
    
    const win = new BrowserWindow({
      width: 1400, height: 900,
      webPreferences: { preload: path.join(__dirname, 'preload.js') },
    });
    
    this.windows.set(win.id, { win, workspacePath });
    
    win.on('closed', () => {
      if (workspacePath) WorkspaceLock.release(workspacePath);
      this.windows.delete(win.id);
    });
    
    return win;
  }
}
```

### 7.2 工作区锁

```typescript
class WorkspaceLock {
  static acquire(workspacePath: string): boolean {
    const lockFile = path.join(workspacePath, '.synapse', '.lock');
    try {
      if (fs.existsSync(lockFile)) {
        const { pid, timestamp } = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        // 进程还活着 → 锁被占用
        if (isProcessAlive(pid)) return false;
        // 进程已死 → 清理孤儿锁
      }
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.writeFileSync(lockFile, JSON.stringify({ 
        pid: process.pid, 
        timestamp: Date.now() 
      }));
      return true;
    } catch { return false; }
  }
  
  static release(workspacePath: string) {
    const lockFile = path.join(workspacePath, '.synapse', '.lock');
    try { fs.unlinkSync(lockFile); } catch {}
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
```

### 7.3 资源隔离策略

| 资源 | 隔离方式 | 说明 |
|---|---|---|
| SQLite DB | 主进程统一连接 | WAL 支持多读单写，写操作通过 IPC 集中到主进程 |
| MCP 服务 | MCP Pool 共享 | 主进程管理 MCP 进程池，窗口通过 IPC 请求工具调用 |
| 设置 | 主进程统一管理 | 设置变更通过 IPC 广播到所有窗口 |
| API Key | 主进程加密存储 | 渲染进程通过 IPC 请求，不直接访问 |
| 终端 | 每窗口独立 | 终端实例绑定工作区，不跨窗口共享 |
| Synopsis 索引 | 每工作区独立 | 索引文件在工作区 .synapse/ 下 |

### 7.4 MCP 进程池

```typescript
class MCPPool {
  private processes: Map<string, MCPProcess> = new Map();
  
  // 获取或创建 MCP 服务器实例
  async getOrCreate(serverName: string, config: MCPConfig): Promise<MCPProcess> {
    if (this.processes.has(serverName)) {
      return this.processes.get(serverName)!;
    }
    const proc = new MCPProcess(config);
    await proc.start();
    this.processes.set(serverName, proc);
    return proc;
  }
  
  // 所有窗口关闭时释放
  async shutdownAll() {
    for (const [name, proc] of this.processes) {
      await proc.kill();
    }
    this.processes.clear();
  }
}
```

---

## 8. 进程树管理与泄漏防护

### 8.1 Windows JobObject 绑定

```typescript
// 使用 windows-process-tree 包或 N-API 绑定 JobObject
// 确保 Synapse 退出时所有子进程自动终止
import { createJobObject } from './native/jobObject';

class ProcessManager {
  private job: JobObject;
  private childPids: Set<number> = new Set();
  
  constructor() {
    if (process.platform === 'win32') {
      this.job = createJobObject();
      // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: 关闭 Job 时杀死所有关联进程
      this.job.setLimitFlags(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
    }
  }
  
  registerChild(childProcess: ChildProcess) {
    // 注册到 JobObject
    if (this.job) {
      this.job.assignProcess(childProcess.pid);
    }
    this.childPids.add(childProcess.pid);
    
    childProcess.on('exit', () => {
      this.childPids.delete(childProcess.pid);
    });
  }
  
  // 应用退出前清理（保底机制，JobObject 会自动处理，这是双保险）
  async cleanupAll() {
    for (const pid of this.childPids) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    // 等待 2 秒后强制杀死
    await delay(2000);
    for (const pid of this.childPids) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }
}
```

### 8.2 MCP 心跳监控

```typescript
class MCPProcess {
  private heartbeatTimer: NodeJS.Timer;
  
  start() {
    // ... 启动 MCP 子进程 ...
    
    // 心跳检测（每 30 秒 ping）
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.ping(5000); // 5秒超时
      } catch {
        console.warn(`MCP ${this.name} 心跳失败，自动重启...`);
        await this.restart();
      }
    }, 30000);
  }
  
  async kill() {
    clearInterval(this.heartbeatTimer);
    this.process.kill('SIGTERM');
    // 5秒后强杀
    setTimeout(() => { try { this.process.kill('SIGKILL'); } catch {} }, 5000);
  }
}
```

### 8.3 命令执行超时与进程树清理

```typescript
class CommandExecutor {
  async run(command: string, options: ExecOptions): Promise<ExecResult> {
    const { timeout = 30000, maxMemoryMB = 256 } = options;
    const child = spawn(command, { shell: true });
    
    // 注册到进程管理器
    processManager.registerChild(child);
    
    // 硬超时
    const timer = setTimeout(() => {
      // 杀死整个进程树（不只是主进程）
      killProcessTree(child.pid);
    }, timeout);
    
    try {
      const result = await collectOutput(child);
      clearTimeout(timer);
      return result;
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
  }
}

// 使用 taskkill /T /F /PID 杀死 Windows 进程树
function killProcessTree(pid: number) {
  if (process.platform === 'win32') {
    execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore' });
  } else {
    process.kill(-pid, 'SIGKILL'); // 杀进程组
  }
}
```

---

## 9. 渲染进程卡死检测与内存监控

### 9.1 主进程监控渲染进程

```typescript
class RendererMonitor {
  private lastHeartbeat: Map<number, number> = new Map(); // windowId -> timestamp
  
  start() {
    // 渲染进程每 5 秒发送心跳
    ipcMain.on('heartbeat', (event) => {
      const windowId = BrowserWindow.fromWebContents(event.sender)?.id;
      if (windowId) this.lastHeartbeat.set(windowId, Date.now());
    });
    
    // 主进程每 10 秒检查
    setInterval(() => {
      for (const [windowId, lastTime] of this.lastHeartbeat) {
        if (Date.now() - lastTime > 15000) { // 15秒无心跳
          const win = BrowserWindow.fromId(windowId);
          if (win) {
            dialog.showMessageBox(win, {
              type: 'warning',
              title: '窗口无响应',
              message: '当前窗口似乎已卡死。是否重新加载？',
              buttons: ['重新加载', '等待', '关闭窗口'],
            }).then(({ response }) => {
              if (response === 0) win.reload();
              else if (response === 2) win.close();
            });
          }
        }
      }
    }, 10000);
  }
}
```

### 9.2 内存监控

```typescript
class MemoryMonitor {
  private warningThreshold = 1024 * 1024 * 1024; // 1GB
  
  start() {
    setInterval(() => {
      for (const [id, { win }] of windowManager.windows) {
        // 获取渲染进程内存使用
        win.webContents.getProcessMemoryInfo().then(info => {
          const memoryMB = info.residentSet / 1024; // KB → MB
          
          if (memoryMB > this.warningThreshold / (1024 * 1024)) {
            win.webContents.send('memory-warning', {
              currentMB: Math.round(memoryMB),
              thresholdMB: Math.round(this.warningThreshold / (1024 * 1024)),
            });
          }
        });
      }
    }, 60000); // 每分钟检查
  }
}

// 渲染进程收到警告后
ipcRenderer.on('memory-warning', (event, data) => {
  toast.warning(
    `内存占用较高 (${data.currentMB}MB)，建议清理不需要的对话或刷新页面`,
    { action: { label: '清理缓存', onClick: () => clearRenderCache() } }
  );
});
```

### 9.3 渲染缓存清理

```typescript
function clearRenderCache() {
  // 卸载不可见消息的 Mermaid/KaTeX 渲染缓存
  mermaidCache.clear();
  katexCache.clear();
  // 强制 GC（Electron 中可用）
  if (global.gc) global.gc();
}
```

---

## 10. 安全审批系统（Auto Approve）

### 10.1 SafetySettings 配置

```typescript
interface SafetySettings {
  fileReadApproval: 'always' | 'ask' | 'never';     // always=自动  ask=弹窗  never=禁止
  fileWriteApproval: 'always' | 'ask' | 'never';
  commandApproval: 'always' | 'ask' | 'never';
  networkApproval: 'always' | 'ask' | 'never';
  globalAutoApprove: boolean;                         // 一键全自动（覆盖上述）
  
  // 沙箱限制
  sandboxTimeout: number;         // 命令超时秒数（默认 30）
  sandboxMaxMemoryMB: number;     // 内存限制（默认 256）
  sandboxMaxConcurrent: number;   // 最大并发命令数（默认 5）
}
```

### 10.2 审批流程

```typescript
class ApprovalManager {
  private settings: SafetySettings;
  
  async checkApproval(action: ToolAction): Promise<boolean> {
    // 全局自动模式
    if (this.settings.globalAutoApprove) return true;
    
    // 按类型检查
    const level = this.getApprovalLevel(action.type);
    
    switch (level) {
      case 'always': return true;                     // 自动允许
      case 'never': return false;                     // 自动拒绝
      case 'ask':                                     // 弹窗询问
        return this.showApprovalDialog(action);
    }
  }
  
  private getApprovalLevel(type: string): 'always' | 'ask' | 'never' {
    switch (type) {
      case 'file_read': return this.settings.fileReadApproval;
      case 'file_write': return this.settings.fileWriteApproval;
      case 'command': return this.settings.commandApproval;
      case 'network': return this.settings.networkApproval;
      default: return 'ask';
    }
  }
  
  private async showApprovalDialog(action: ToolAction): Promise<boolean> {
    // UI: 弹窗显示要做什么，[允许] [拒绝] [始终允许此工具]
    const result = await dialogService.show({
      title: `AI 请求执行: ${action.tool}`,
      description: action.description,
      details: action.params,
      buttons: ['允许', '拒绝', '始终允许'],
    });
    
    if (result === '始终允许') {
      this.addToWhitelist(action.tool);
    }
    return result !== '拒绝';
  }
}
```


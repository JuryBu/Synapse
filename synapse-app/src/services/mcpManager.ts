/**
 * MCP Manager — MCP 服务器生命周期管理
 * Web 模式提供 Mock 实现；Electron 模式通过 IPC 管理 MCP 进程
 */

import { isElectron } from '@platform/index';

export interface MCPServer {
  name: string;
  description: string;
  status: 'running' | 'stopped' | 'error' | 'starting';
  tools: string[];
  lastHeartbeat?: number;
}

export interface MCPConfig {
  servers: Record<string, {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    enabled?: boolean;
  }>;
}

class MCPManager {
  private servers = new Map<string, MCPServer>();
  private config: MCPConfig | null = null;

  constructor() {
    // Register built-in MCP servers (web mode: mock)
    this.servers.set('sandbox', {
      name: 'sandbox',
      description: '代码执行沙箱 — 安全运行代码片段',
      status: isElectron ? 'stopped' : 'stopped',
      tools: ['sandbox_exec', 'sandbox_session', 'sandbox_batch'],
    });

    this.servers.set('web-fetcher', {
      name: 'web-fetcher',
      description: '网页内容获取 — 截图、文本提取、文件下载',
      status: 'stopped',
      tools: ['web_fetch_page', 'web_fetch_screenshot', 'web_extract_links'],
    });

    this.servers.set('memory-store', {
      name: 'memory-store',
      description: '知识记忆存储 — 跨对话持久化知识',
      status: 'stopped',
      tools: ['memory_write', 'memory_query', 'memory_read'],
    });
  }

  async loadConfig(configPath?: string): Promise<MCPConfig> {
    if (isElectron && window.synapse) {
      try {
        const raw = await window.synapse.file.read(configPath || '.synapse/mcp_config.json');
        this.config = JSON.parse(raw);
        return this.config!;
      } catch {
        // No config file
      }
    }
    // Default config
    this.config = { servers: {} };
    return this.config;
  }

  async startServer(name: string): Promise<boolean> {
    const server = this.servers.get(name);
    if (!server) return false;

    server.status = 'starting';

    if (isElectron && window.synapse?.mcp) {
      try {
        await window.synapse.mcp.start(name);
        server.status = 'running';
        server.lastHeartbeat = Date.now();
        return true;
      } catch {
        server.status = 'error';
        return false;
      }
    }

    // Web mode: simulate start
    await new Promise(r => setTimeout(r, 500));
    server.status = 'running';
    server.lastHeartbeat = Date.now();
    return true;
  }

  async stopServer(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server) return;

    if (isElectron && window.synapse?.mcp) {
      await window.synapse.mcp.stop(name);
    }
    server.status = 'stopped';
  }

  async restartServer(name: string): Promise<boolean> {
    await this.stopServer(name);
    return this.startServer(name);
  }

  getServers(): MCPServer[] {
    return Array.from(this.servers.values());
  }

  getServer(name: string): MCPServer | undefined {
    return this.servers.get(name);
  }

  registerServer(name: string, server: MCPServer): void {
    this.servers.set(name, server);
  }
}

export const mcpManager = new MCPManager();

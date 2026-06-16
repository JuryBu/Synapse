/**
 * IPC MCP Handler
 * MCP 服务器管理：启动/停止/重启/工具调用
 */

import { ipcMain } from 'electron';
import { MCPServerProcess } from '../mcp/MCPServerProcess';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

const servers = new Map<string, MCPServerProcess>();

interface MCPConfigEntry {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    enabled?: boolean;
}

function loadMCPConfig(): Record<string, MCPConfigEntry> {
    const configPaths = [
        path.join(app.getPath('home'), '.synapse', 'mcp_config.json'),
        path.join(process.cwd(), '.synapse', 'mcp_config.json'),
    ];
    const merged: Record<string, MCPConfigEntry> = {};
    for (const p of configPaths) {
        try {
            if (fs.existsSync(p)) {
                const raw = fs.readFileSync(p, 'utf-8');
                const config = JSON.parse(raw);
                Object.assign(merged, config.servers || config);
            }
        } catch { /* skip */ }
    }
    return merged;
}

/**
 * ★ M4-7-S2：首次运行生成默认 ~/.synapse/mcp_config.json。
 *   - 文件【已存在则绝不覆盖】（保护用户编辑过的路径 / enabled / 自定义 server）。
 *   - command='node'、args=[各 server dist/index.js 绝对路径]（三 server 原生支持 StdioServerTransport，
 *     走 stdio spawn，不走 HTTP Broker）。
 *   - enabled 默认（决策）：memory-store=true（最轻、读记忆最常用），sandbox/web-fetcher=false（依赖重，用户显式开启）。
 *   - 写 {servers:{}} 包裹形态（loadMCPConfig 同时支持包裹与裸对象，包裹最规范）。
 *   在 main.ts 启动序列（registerMCPHandlers 之前）调用。
 */
export function ensureDefaultMCPConfig(): void {
    try {
        const dir = path.join(app.getPath('home'), '.synapse');
        const configPath = path.join(dir, 'mcp_config.json');
        if (fs.existsSync(configPath)) return; // 存在绝不覆盖。
        const base = 'C:\\Users\\Stardust\\.gemini\\antigravity';
        const defaultConfig = {
            servers: {
                'memory-store': {
                    command: 'node',
                    args: [path.join(base, 'mcp-memory-store', 'dist', 'index.js')],
                    enabled: true,
                },
                'sandbox': {
                    command: 'node',
                    args: [path.join(base, 'mcp-sandbox', 'dist', 'index.js')],
                    enabled: false,
                },
                'web-fetcher': {
                    command: 'node',
                    args: [path.join(base, 'mcp-web-fetcher', 'dist', 'index.js')],
                    enabled: false,
                },
            },
        };
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
        console.log(`[MCP] default mcp_config.json generated at ${configPath}`);
    } catch (err) {
        console.error('[MCP] ensureDefaultMCPConfig failed:', (err as Error)?.message);
    }
}

export function registerMCPHandlers(): void {
    // 获取 MCP 状态
    // ★ M4-7-S2：handler 改 async——对 running server 调 listTools() 填【真实 tools 名列表】
    //   （旧实现恒返回 []）。listTools 内部已 catch 成空集，单 server 失败不影响整条状态。
    ipcMain.handle('mcp:status', async () => {
        const config = loadMCPConfig();
        const result: Array<{ name: string; status: string; running: boolean; configured: boolean; enabled: boolean; tools: string[] }> = [];
        for (const [name, entry] of Object.entries(config)) {
            const proc = servers.get(name);
            const running = proc?.status === 'running';
            const tools = running ? (await proc!.listTools()).map(t => t.name) : [];
            result.push({
                name,
                status: proc?.status ?? (entry.enabled === false ? 'disabled' : 'stopped'),
                running,
                configured: true,
                enabled: entry.enabled !== false,
                tools,
            });
        }
        for (const [name, proc] of servers) {
            if (config[name]) continue;
            const running = proc.status === 'running';
            const tools = running ? (await proc.listTools()).map(t => t.name) : [];
            result.push({ name, status: proc.status, running, configured: false, enabled: true, tools });
        }
        return { servers: result };
    });

    // 启动 MCP 服务器
    ipcMain.handle('mcp:start', async (_e, name: string) => {
        const config = loadMCPConfig();
        const entry = config[name];
        if (!entry) throw new Error(`MCP server "${name}" not found in config`);

        const proc = new MCPServerProcess(name, entry.command, entry.args, entry.env);
        servers.set(name, proc);
        await proc.start();
        return { status: 'running' };
    });

    // 停止 MCP
    ipcMain.handle('mcp:stop', async (_e, name: string) => {
        const proc = servers.get(name);
        if (proc) {
            await proc.stop();
            servers.delete(name);
        }
        return { status: 'stopped' };
    });

    // 重启 MCP
    ipcMain.handle('mcp:restart', async (_e, name: string) => {
        const proc = servers.get(name);
        if (proc) {
            await proc.stop();
            servers.delete(name);
        }
        // Re-read config and start
        const config = loadMCPConfig();
        const entry = config[name];
        if (!entry) throw new Error(`MCP server "${name}" not found`);
        const newProc = new MCPServerProcess(name, entry.command, entry.args, entry.env);
        servers.set(name, newProc);
        await newProc.start();
        return { status: 'running' };
    });

    // 列出工具
    ipcMain.handle('mcp:listTools', async (_e, name: string) => {
        const proc = servers.get(name);
        if (!proc || proc.status !== 'running') return [];
        return proc.listTools();
    });

    // 调用工具
    ipcMain.handle('mcp:callTool', async (_e, serverName: string, toolName: string, args: unknown) => {
        const proc = servers.get(serverName);
        if (!proc || proc.status !== 'running') {
            throw new Error(`MCP server "${serverName}" not running`);
        }
        return proc.callTool(toolName, args as Record<string, unknown>);
    });
}

// 应用退出时关闭所有 MCP
export async function shutdownAllMCP(): Promise<void> {
    for (const [, proc] of servers) {
        try { await proc.stop(); } catch { /* ignore */ }
    }
    servers.clear();
}

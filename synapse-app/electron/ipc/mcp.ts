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

export function registerMCPHandlers(): void {
    // 获取 MCP 状态
    ipcMain.handle('mcp:status', () => {
        const config = loadMCPConfig();
        const result: Array<{ name: string; status: string; running: boolean; configured: boolean; enabled: boolean; tools: string[] }> = [];
        for (const [name, entry] of Object.entries(config)) {
            const proc = servers.get(name);
            result.push({
                name,
                status: proc?.status ?? (entry.enabled === false ? 'disabled' : 'stopped'),
                running: proc?.status === 'running',
                configured: true,
                enabled: entry.enabled !== false,
                tools: [],
            });
        }
        for (const [name, proc] of servers) {
            if (config[name]) continue;
            result.push({ name, status: proc.status, running: proc.status === 'running', configured: false, enabled: true, tools: [] });
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

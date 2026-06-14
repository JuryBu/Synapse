/**
 * MCP Server Process — stdio JSON-RPC 2.0 通信
 * 管理单个 MCP 服务器子进程的生命周期
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

interface JSONRPCRequest {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params?: unknown;
}

interface JSONRPCResponse {
    jsonrpc: '2.0';
    id: number;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export class MCPServerProcess extends EventEmitter {
    private process: ChildProcess | null = null;
    private buffer = '';
    private requestId = 0;
    private pending = new Map<number, PendingRequest>();
    private _status: 'stopped' | 'starting' | 'running' | 'error' = 'stopped';

    constructor(
        public readonly name: string,
        private command: string,
        private args: string[] = [],
        private env: Record<string, string> = {},
    ) {
        super();
    }

    get status() { return this._status; }

    async start(): Promise<void> {
        if (this.process) return;
        this._status = 'starting';

        this.process = spawn(this.command, this.args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...this.env },
        });

        this.process.stdout?.on('data', (data: Buffer) => {
            this.buffer += data.toString();
            this.processBuffer();
        });

        this.process.stderr?.on('data', (data: Buffer) => {
            console.error(`[MCP:${this.name}] stderr:`, data.toString().trim());
        });

        this.process.on('close', (code) => {
            console.log(`[MCP:${this.name}] exited with code ${code}`);
            this._status = 'stopped';
            this.process = null;
            // Reject all pending requests
            for (const [id, req] of this.pending) {
                req.reject(new Error('MCP process exited'));
                clearTimeout(req.timer);
                this.pending.delete(id);
            }
            this.emit('close', code);
        });

        this.process.on('error', (err) => {
            console.error(`[MCP:${this.name}] error:`, err.message);
            this._status = 'error';
            this.emit('error', err);
        });

        // Initialize: send initialize request
        try {
            await this.request('initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'synapse', version: '0.1.0' },
            });
            await this.notify('notifications/initialized');
            this._status = 'running';
            console.log(`[MCP:${this.name}] initialized`);
        } catch (err) {
            this._status = 'error';
            throw err;
        }
    }

    async stop(): Promise<void> {
        if (!this.process) return;
        this.process.kill('SIGTERM');
        await new Promise<void>(resolve => {
            const timer = setTimeout(() => {
                this.process?.kill('SIGKILL');
                resolve();
            }, 5000);
            this.process?.on('close', () => {
                clearTimeout(timer);
                resolve();
            });
        });
        this.process = null;
        this._status = 'stopped';
    }

    async request(method: string, params?: unknown, timeout = 30000): Promise<unknown> {
        if (!this.process?.stdin) throw new Error('MCP not running');
        const id = ++this.requestId;
        const msg: JSONRPCRequest = { jsonrpc: '2.0', id, method, params };
        const payload = JSON.stringify(msg);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP timeout: ${method} (${timeout}ms)`));
            }, timeout);
            this.pending.set(id, { resolve, reject, timer });
            this.process!.stdin!.write(payload + '\n');
        });
    }

    async notify(method: string, params?: unknown): Promise<void> {
        if (!this.process?.stdin) return;
        const msg = { jsonrpc: '2.0', method, params };
        this.process.stdin.write(JSON.stringify(msg) + '\n');
    }

    async listTools(): Promise<Array<{ name: string; description: string; inputSchema: unknown }>> {
        const result = await this.request('tools/list') as { tools?: unknown[] };
        return (result?.tools || []) as Array<{ name: string; description: string; inputSchema: unknown }>;
    }

    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        return this.request('tools/call', { name, arguments: args });
    }

    private processBuffer(): void {
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() ?? '';
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const msg = JSON.parse(line) as JSONRPCResponse;
                if (msg.id !== undefined && this.pending.has(msg.id)) {
                    const req = this.pending.get(msg.id)!;
                    clearTimeout(req.timer);
                    this.pending.delete(msg.id);
                    if (msg.error) {
                        req.reject(new Error(msg.error.message));
                    } else {
                        req.resolve(msg.result);
                    }
                }
                // Notification from server (no id)
                if (msg.id === undefined) {
                    this.emit('notification', msg);
                }
            } catch {
                // Non-JSON line, ignore
            }
        }
    }
}

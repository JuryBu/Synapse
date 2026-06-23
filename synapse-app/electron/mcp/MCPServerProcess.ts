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
    /**
     * ★ M4-7-S1：start() 期间监听 spawn error（ENOENT / 路径错）的快速失败回调。
     *   spawn 是异步的——'error' 事件在 start() 的 await initialize 之后才到达。把进行中 start 的
     *   reject 暂存在这里，process.on('error') 触发时立刻调用它，让 start() 秒级失败而非苦等 30s timeout。
     */
    private startErrorReject: ((err: Error) => void) | null = null;

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
            // ★ M4-7-S1：去黑框——Windows 下 spawn node 子进程默认会闪一个控制台窗口。
            windowsHide: true,
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
            // ★ M4-7-S1 快速失败：spawn error（ENOENT / command 不存在 / 路径错）在 start() 的
            //   await initialize 期间到达时，立刻 reject 进行中的 start，而不是让它干等 30s request timeout。
            if (this.startErrorReject) {
                this.startErrorReject(err);
            }
            this.emit('error', err);
        });

        // Initialize：把 initialize 请求与「spawn error 事件」竞速（Promise.race）。
        //   - 正常 server：initialize 先 resolve → running。
        //   - spawn 失败：'error' 事件触发 startErrorReject 先 reject → 秒级失败，不等 timeout。
        try {
            const errorRace = new Promise<never>((_resolve, reject) => {
                this.startErrorReject = reject;
            });
            const initPromise = this.request('initialize', {
                protocolVersion: '2024-11-05',
                // ★ M4-7-S1：声明客户端支持 tools（更规范；个别 server 会据此决定是否暴露 tools/list）。
                capabilities: { tools: {} },
                clientInfo: { name: 'synapse', version: '0.1.0' },
            });
            await Promise.race([initPromise, errorRace]);
            await this.notify('notifications/initialized');
            this._status = 'running';
            console.log(`[MCP:${this.name}] initialized`);
            // ★ MCP 竞态修复：握手成功置 running 时主动广播事件。旧链路 mcpBridge.refresh() 只在
            //   AgentPanel 首次 aiClient 就绪时 pull 一次，那一刻 server 还在 starting → 被
            //   mcpBridge `!server.running` 跳过 → 零个 mcp__* 工具注册。emit 后由 ipc/mcp.ts
            //   监听并 webContents.send → 渲染端 mcpBridge 自动 refresh()，事件驱动补注册。
            //   带 server name，便于上层区分是哪个 server 就绪。
            this.emit('status-change', { name: this.name, status: 'running' });
            this.emit('ready', { name: this.name });
        } catch (err) {
            this._status = 'error';
            throw err;
        } finally {
            // 竞速结束后解除引用，避免后续 error 事件误调用旧 reject。
            this.startErrorReject = null;
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
        // ★ M4-7-S1：server 不支持 tools/list（未声明 capability / 协议差异）时 request 会 reject。
        //   这里 catch 成空集——桥接层 / status 据此跳过该 server，而非让整条状态/桥接链路崩。
        try {
            const result = await this.request('tools/list') as { tools?: unknown[] };
            return (result?.tools || []) as Array<{ name: string; description: string; inputSchema: unknown }>;
        } catch (err) {
            console.error(`[MCP:${this.name}] listTools failed:`, (err as Error)?.message);
            return [];
        }
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

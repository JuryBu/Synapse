/**
 * IPC Command Handler
 * 命令执行（child_process.spawn）+ 审批机制
 */

import { ipcMain } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';

export function registerCommandHandlers(): void {
    // 执行命令
    // M2-5：cwd 由渲染端按「显式 cwd > 活动 worktree > 主工作区 currentPath」解析后传入
    //       （见 toolRegistry run_command）。这里只做存在性兜底：传入 cwd 无效/不存在时回退
    //       process.cwd()，避免 spawn 因无效工作目录直接抛错。两端都没工作区时才落到 process.cwd()。
    ipcMain.handle('command:exec', (_e, cmd: string, cwd?: string) => {
        return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
            const isWin = process.platform === 'win32';
            const shell = isWin ? 'cmd.exe' : '/bin/sh';
            const effectiveCwd = (typeof cwd === 'string' && cwd.trim() && fs.existsSync(cwd))
                ? cwd
                : process.cwd();
            // Windows cmd 默认 GBK/CP936 编码：命令行参数走 Node 默认 GBK 传入、输出也按 GBK 解码，两头一致。
            // （此前的 chcp 65001 方案被真机证伪：它让 cmd 把 GBK 命令行当 UTF-8 解析，反而搞乱中文输入。）
            const shellArgs = isWin ? ['/c', cmd] : ['-c', cmd];

            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];
            const maxOutput = 10000; // 防止输出过大（字符数）

            const child = spawn(shell, shellArgs, {
                cwd: effectiveCwd,
                env: { ...process.env },
                timeout: 30000, // 30s 超时
            });

            const decodeOutput = (chunks: Buffer[]): string => {
                const buf = Buffer.concat(chunks);
                if (isWin) {
                    try {
                        return new TextDecoder('gbk').decode(buf);
                    } catch {
                        return buf.toString('utf-8'); // ICU 不支持 gbk 时兜底
                    }
                }
                return buf.toString('utf-8');
            };

            child.stdout?.on('data', (data: Buffer) => { stdoutChunks.push(data); });
            child.stderr?.on('data', (data: Buffer) => { stderrChunks.push(data); });

            child.on('close', (code) => {
                resolve({
                    stdout: decodeOutput(stdoutChunks).slice(0, maxOutput),
                    stderr: decodeOutput(stderrChunks).slice(0, maxOutput),
                    exitCode: code ?? 1,
                });
            });

            child.on('error', (err) => {
                resolve({ stdout: '', stderr: err.message, exitCode: 1 });
            });
        });
    });
}

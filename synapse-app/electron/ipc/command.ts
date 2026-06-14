/**
 * IPC Command Handler
 * 命令执行（child_process.spawn）+ 审批机制
 */

import { ipcMain } from 'electron';
import { spawn } from 'child_process';

export function registerCommandHandlers(): void {
    // 执行命令
    ipcMain.handle('command:exec', (_e, cmd: string, cwd?: string) => {
        return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
            const isWin = process.platform === 'win32';
            const shell = isWin ? 'cmd.exe' : '/bin/sh';
            // Windows: 先切到 UTF-8 码页 (65001)，否则 cmd 默认 GBK/CP936 输出会被 toString('utf8') 解码成乱码
            const shellArgs = isWin ? ['/c', `chcp 65001>nul & ${cmd}`] : ['-c', cmd];

            let stdout = '';
            let stderr = '';
            const maxOutput = 10000; // 防止输出过大

            const child = spawn(shell, shellArgs, {
                cwd: cwd || process.cwd(),
                env: { ...process.env },
                timeout: 30000, // 30s 超时
            });

            child.stdout?.on('data', (data: Buffer) => {
                if (stdout.length < maxOutput) {
                    stdout += data.toString();
                }
            });

            child.stderr?.on('data', (data: Buffer) => {
                if (stderr.length < maxOutput) {
                    stderr += data.toString();
                }
            });

            child.on('close', (code) => {
                resolve({
                    stdout: stdout.slice(0, maxOutput),
                    stderr: stderr.slice(0, maxOutput),
                    exitCode: code ?? 1,
                });
            });

            child.on('error', (err) => {
                resolve({ stdout: '', stderr: err.message, exitCode: 1 });
            });
        });
    });
}

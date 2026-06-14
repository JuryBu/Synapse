/**
 * IPC File Handler
 * 文件系统操作：read/write/list/search/rename/delete
 */

import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { spawn } from 'child_process';

function resolveFilePath(filePath: string): string {
    if (!filePath) return filePath;
    if (filePath === '~') return app.getPath('home');
    if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
        return path.join(app.getPath('home'), filePath.slice(2));
    }
    return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

const OFFICE_EXTENSIONS = new Set(['.doc', '.docm', '.docx', '.ppt', '.pptm', '.pptx', '.xls', '.xlsx', '.xlsm']);

function findLibreOffice(): string | null {
    const candidates = [
        process.env.LIBREOFFICE_PATH,
        process.env.SOFFICE_PATH,
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
        'soffice',
        'libreoffice',
    ].filter(Boolean) as string[];
    for (const candidate of candidates) {
        if (candidate.includes(path.sep) || candidate.includes('/')) {
            if (fs.existsSync(candidate)) return candidate;
            continue;
        }
        return candidate;
    }
    return null;
}

function convertOfficeToPdf(sourcePath: string): Promise<{ success: true; outputPath: string; format: 'pdf'; tempDir: string } | { error: true; message: string }> {
    return new Promise((resolve) => {
        const soffice = findLibreOffice();
        if (!soffice) {
            resolve({ error: true, message: '未找到 LibreOffice/soffice，无法转换 Office 文件' });
            return;
        }

        const tempDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'synapse-office-'));
        const args = [
            '--headless',
            '--nologo',
            '--nofirststartwizard',
            '--convert-to',
            'pdf',
            '--outdir',
            tempDir,
            sourcePath,
        ];

        const child = spawn(soffice, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, 60_000);

        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', err => {
            clearTimeout(timer);
            resolve({ error: true, message: `启动 LibreOffice 失败: ${err.message}` });
        });
        child.on('close', code => {
            clearTimeout(timer);
            if (code !== 0) {
                resolve({ error: true, message: timedOut ? 'Office 转换超时（60 秒）' : `Office 转换失败: ${stderr || stdout || `exit ${code}`}` });
                return;
            }

            const baseName = path.basename(sourcePath, path.extname(sourcePath));
            const expected = path.join(tempDir, `${baseName}.pdf`);
            if (fs.existsSync(expected)) {
                resolve({ success: true, outputPath: expected, format: 'pdf', tempDir });
                return;
            }
            const produced = fs.readdirSync(tempDir).find(name => name.toLowerCase().endsWith('.pdf'));
            if (produced) {
                resolve({ success: true, outputPath: path.join(tempDir, produced), format: 'pdf', tempDir });
                return;
            }
            resolve({ error: true, message: `Office 转换未生成 PDF: ${stderr || stdout || sourcePath}` });
        });
    });
}

export function registerFileHandlers(): void {
    ipcMain.handle('file:exists', (_e, filePath: string) => {
        return fs.existsSync(resolveFilePath(filePath));
    });

    // 读取文件（返回 string，与前端 SynapseAPI.file.read 类型一致）
    ipcMain.handle('file:read', (_e, filePath: string) => {
        try {
            filePath = resolveFilePath(filePath);
            if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
            const stat = fs.statSync(filePath);
            if (stat.size > 10 * 1024 * 1024) throw new Error('文件超过 10MB 限制');
            return fs.readFileSync(filePath, 'utf-8');
        } catch (err: any) {
            throw new Error(err.message);
        }
    });

    // 写入文件
    ipcMain.handle('file:write', (_e, filePath: string, content: string) => {
        try {
            filePath = resolveFilePath(filePath);
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, content, 'utf-8');
            return { success: true, path: filePath, size: Buffer.byteLength(content) };
        } catch (err: any) {
            return { error: true, message: err.message };
        }
    });

    // 读取二进制文件。用于 PDF / DOCX / PPTX 等 viewer，避免把本地文件按 UTF-8 文本读取。
    ipcMain.handle('file:readBinary', (_e, filePath: string) => {
        try {
            filePath = resolveFilePath(filePath);
            if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
            const stat = fs.statSync(filePath);
            if (stat.size > 50 * 1024 * 1024) throw new Error('文件超过 50MB 限制');
            const buffer = fs.readFileSync(filePath);
            return Array.from(buffer);
        } catch (err: any) {
            throw new Error(err.message);
        }
    });

    ipcMain.handle('file:convertOffice', async (_e, filePath: string) => {
        try {
            const resolved = resolveFilePath(filePath);
            if (!fs.existsSync(resolved)) throw new Error(`文件不存在: ${resolved}`);
            const stat = fs.statSync(resolved);
            if (stat.size > 50 * 1024 * 1024) throw new Error('文件超过 50MB 限制');
            const ext = path.extname(resolved).toLowerCase();
            if (!OFFICE_EXTENSIONS.has(ext)) throw new Error(`不支持的 Office 类型: ${ext}`);
            return await convertOfficeToPdf(resolved);
        } catch (err: any) {
            return { error: true, message: err.message };
        }
    });

    ipcMain.handle('file:cleanupTemp', (_e, targetPath: string) => {
        try {
            const resolved = resolveFilePath(targetPath);
            const tempRoot = app.getPath('temp');
            const rel = path.relative(tempRoot, resolved);
            if (rel.startsWith('..') || path.isAbsolute(rel) || !path.basename(resolved).startsWith('synapse-office-')) {
                throw new Error('只能清理 Synapse Office 临时目录');
            }
            fs.rmSync(resolved, { recursive: true, force: true });
            return { success: true };
        } catch (err: any) {
            return { error: true, message: err.message };
        }
    });

    ipcMain.handle('file:rename', (_e, oldPath: string, newPath: string) => {
        try {
            oldPath = resolveFilePath(oldPath);
            newPath = resolveFilePath(newPath);
            fs.renameSync(oldPath, newPath);
            return { success: true };
        } catch (err: any) {
            throw new Error(err.message);
        }
    });

    ipcMain.handle('file:delete', (_e, targetPath: string) => {
        try {
            targetPath = resolveFilePath(targetPath);
            fs.rmSync(targetPath, { recursive: true, force: true });
            return { success: true };
        } catch (err: any) {
            throw new Error(err.message);
        }
    });

    ipcMain.handle('file:mkdir', (_e, targetPath: string) => {
        try {
            targetPath = resolveFilePath(targetPath);
            fs.mkdirSync(targetPath, { recursive: true });
            return { success: true };
        } catch (err: any) {
            throw new Error(err.message);
        }
    });

    // 列出目录
    ipcMain.handle('file:list', (_e, dirPath: string) => {
        try {
            dirPath = resolveFilePath(dirPath);
            if (!fs.existsSync(dirPath)) return { error: true, message: `目录不存在: ${dirPath}` };
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            return entries
                .filter(e => !e.name.startsWith('.'))
                .map(e => ({
                    name: e.name,
                    path: path.join(dirPath, e.name),
                    type: e.isDirectory() ? 'directory' : 'file',
                    extension: e.isFile() ? path.extname(e.name).slice(1).toLowerCase() : undefined,
                    size: e.isFile() ? fs.statSync(path.join(dirPath, e.name)).size : undefined,
                }));
        } catch (err: any) {
            return { error: true, message: err.message };
        }
    });

    // 搜索文件内容
    ipcMain.handle('file:search', (_e, dirPath: string, pattern: string) => {
        dirPath = resolveFilePath(dirPath);
        const results: Array<{ path: string; line: number; content: string }> = [];
        const MAX_RESULTS = 50;
        function searchDir(dir: string) {
            if (results.length >= MAX_RESULTS) return;
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (results.length >= MAX_RESULTS) break;
                    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) { searchDir(full); continue; }
                    if (entry.isFile()) {
                        try {
                            const content = fs.readFileSync(full, 'utf-8');
                            const lines = content.split('\n');
                            for (let i = 0; i < lines.length && results.length < MAX_RESULTS; i++) {
                                if (lines[i].includes(pattern)) {
                                    results.push({ path: full, line: i + 1, content: lines[i].trim().slice(0, 200) });
                                }
                            }
                        } catch { /* binary file */ }
                    }
                }
            } catch { /* permission denied */ }
        }
        searchDir(dirPath);
        return results;
    });

    // grep 搜索（复用 file:search 的递归逻辑）
    ipcMain.handle('file:grep', (_e, dirPath: string, query: string, _opts?: { regex?: boolean }) => {
        const results: Array<{ path: string; line: number; content: string }> = [];
        const MAX = 50;
        function grepDir(dir: string) {
            if (results.length >= MAX) return;
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (results.length >= MAX) break;
                    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) { grepDir(full); continue; }
                    if (entry.isFile()) {
                        try {
                            const content = fs.readFileSync(full, 'utf-8');
                            const lines = content.split('\n');
                            for (let i = 0; i < lines.length && results.length < MAX; i++) {
                                if (lines[i].includes(query)) {
                                    results.push({ path: full, line: i + 1, content: lines[i].trim().slice(0, 200) });
                                }
                            }
                        } catch { /* binary file */ }
                    }
                }
            } catch { /* permission denied */ }
        }
        grepDir(dirPath);
        return results;
    });
}

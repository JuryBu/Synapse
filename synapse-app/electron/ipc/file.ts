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

type OfficeConvertResult =
    | { success: true; outputPath: string; format: 'pdf'; tempDir: string }
    | { error: true; message: string };

/**
 * ★ FIX-1：把一个本地文件系统目录转成 LibreOffice 能吃的 file URL。
 *   Windows 下绝对路径含反斜杠与盘符（如 C:\Users\...），LibreOffice 的
 *   `-env:UserInstallation=file:///...` 只接受正斜杠的 file URL，故：
 *   ①反斜杠 → 正斜杠；②对路径段做编码（保留 ':' '/' 让盘符/分隔符不被转义）。
 */
function toFileUrl(dir: string): string {
    const normalized = dir.replace(/\\/g, '/');
    // 盘符前补一个 '/'（file:///C:/...）；非盘符绝对路径（理论上 Windows 用不到）原样拼。
    const withLeadingSlash = /^[a-zA-Z]:/.test(normalized) ? `/${normalized}` : normalized;
    // encodeURI 保留 :/，把空格/中文等转义，规避带空格用户名导致的 URL 解析失败。
    return `file://${encodeURI(withLeadingSlash)}`;
}

/**
 * ★ FIX-1/FIX-2：单次转换。每次调用都用【全新独立临时 profile + 全新 tempDir】，
 *   通过 `-env:UserInstallation` 隔离 LibreOffice 用户 profile，规避默认 profile
 *   `AppData/Roaming/LibreOffice/4` 的 `.lock` 脏锁与多实例并发抢锁（真机实证：
 *   默认 profile → exit 1 size 0；独立 profile → exit 0 成功）。
 *   profile 目录与 tempDir 同前缀（synapse-office-），随 cleanupTemp 白名单一起放行清理。
 */
function convertOnce(soffice: string, sourcePath: string): Promise<OfficeConvertResult> {
    return new Promise((resolve) => {
        // tempDir 放转换产物（PDF），profileDir 放本次独立的 LibreOffice 用户 profile。
        // 两者都用 synapse-office- 前缀，cleanupTemp 白名单可放行。
        const tempDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'synapse-office-'));
        const profileDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'synapse-office-profile-'));

        const args = [
            // ★ FIX-1：独立临时 profile（必须放在最前，确保启动期就生效）。
            `-env:UserInstallation=${toFileUrl(profileDir)}`,
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

        const dropProfile = () => {
            // profile 目录是一次性的，转换结束即清，避免临时目录堆积。
            try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
        };

        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', err => {
            clearTimeout(timer);
            dropProfile();
            // 失败时同样清掉本次空 tempDir（仅在 error/非 0 分支清，成功分支保留给调用方读 PDF）。
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
            resolve({ error: true, message: `启动 LibreOffice 失败: ${err.message}` });
        });
        child.on('close', code => {
            clearTimeout(timer);
            dropProfile();
            if (code !== 0) {
                try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
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
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
            resolve({ error: true, message: `Office 转换未生成 PDF: ${stderr || stdout || sourcePath}` });
        });
    });
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * ★ FIX-2：外层带重试的转换入口。
 *   瞬时锁冲突/并发抢锁是非确定性的——前一次失败、后一次（全新 profile + tempDir）
 *   很可能成功，故失败后短延时重试，最多 OFFICE_CONVERT_ATTEMPTS 次。
 *   全部失败时给【友好文案】（疑似 LibreOffice 实例冲突 + 原始错误附后供排查）。
 */
const OFFICE_CONVERT_ATTEMPTS = 3; // 1 次正常 + 2 次重试

async function convertOfficeToPdf(sourcePath: string): Promise<OfficeConvertResult> {
    const soffice = findLibreOffice();
    if (!soffice) {
        return { error: true, message: '未找到 LibreOffice/soffice，无法转换 Office 文件' };
    }

    let lastMessage = '';
    for (let attempt = 1; attempt <= OFFICE_CONVERT_ATTEMPTS; attempt++) {
        const result = await convertOnce(soffice, sourcePath);
        if ('success' in result) return result;
        lastMessage = result.message;
        // 超时不重试（重试也大概率超时，徒增等待）；其余瞬时失败短延时后重试。
        if (result.message.includes('超时')) break;
        if (attempt < OFFICE_CONVERT_ATTEMPTS) {
            await sleep(400 * attempt); // 递增退避：400ms、800ms。
        }
    }
    return {
        error: true,
        message: `Office 转换失败（疑似 LibreOffice 实例冲突，请关闭已打开的 LibreOffice 窗口后重试）。\n原始错误：${lastMessage}`,
    };
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
            // ★ FIX-1：白名单放行 synapse-office- 前缀（含 synapse-office-profile- 独立 profile 目录，
            //   因其同样以 synapse-office- 开头，startsWith 自然命中）。
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

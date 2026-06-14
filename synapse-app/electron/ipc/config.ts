/**
 * IPC Config Handler
 * 设置读写 + safeStorage 加密 API Key
 */

import { ipcMain, safeStorage } from 'electron';
import { getDatabase } from '../database';

export function registerConfigHandlers(): void {
    const db = getDatabase();

    // 通用设置读取
    ipcMain.handle('config:get', (_e, key: string) => {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
            | { value: string }
            | undefined;
        if (!row) return null;
        try {
            return JSON.parse(row.value);
        } catch {
            return row.value;
        }
    });

    // 通用设置写入
    ipcMain.handle('config:set', (_e, key: string, value: unknown) => {
        const json = JSON.stringify(value);
        db.prepare(
            'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        ).run(key, json);
        return true;
    });

    // API Key 读取（safeStorage 解密）
    ipcMain.handle('config:getAPIKey', () => {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'apiKeys'").get() as
            | { value: string }
            | undefined;
        if (!row) return {};
        try {
            if (safeStorage.isEncryptionAvailable()) {
                const decrypted = safeStorage.decryptString(Buffer.from(row.value, 'base64'));
                return JSON.parse(decrypted);
            }
            return JSON.parse(row.value);
        } catch {
            return {};
        }
    });

    // API Key 写入（safeStorage 加密）
    ipcMain.handle('config:setAPIKey', (_e, keys: unknown) => {
        const json = JSON.stringify(keys);
        let stored: string;
        if (safeStorage.isEncryptionAvailable()) {
            stored = safeStorage.encryptString(json).toString('base64');
        } else {
            stored = json; // 降级为明文
        }
        db.prepare(
            "INSERT INTO settings (key, value, updated_at) VALUES ('apiKeys', ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        ).run(stored);
        return true;
    });
}

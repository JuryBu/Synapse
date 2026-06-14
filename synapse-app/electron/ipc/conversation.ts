/**
 * IPC Conversation Handler
 * 对话 CRUD + 消息管理 + 搜索
 */

import { ipcMain } from 'electron';
import { getDatabase } from '../database';

function toJson(value: unknown): string | null {
    return value === undefined || value === null ? null : JSON.stringify(value);
}

function fromJson<T = unknown>(value: unknown): T | undefined {
    if (typeof value !== 'string' || !value) return undefined;
    try {
        return JSON.parse(value) as T;
    } catch {
        return undefined;
    }
}

function normalizeTags(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(tag => String(tag).trim()).filter(Boolean))].slice(0, 12);
}

function mapConversation(row: any) {
    if (!row) return null;
    return {
        ...row,
        workspaceId: row.workspace_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messageCount: row.message_count,
        schemaVersion: row.schema_version ?? 1,
        summary: fromJson(row.summary_json),
        lastMessage: row.last_message ?? '',
        assistantRuns: fromJson(row.assistant_runs) ?? {},
        fileSnapshots: fromJson(row.file_snapshots) ?? {},
        pendingDiffs: fromJson(row.pending_diffs) ?? [],
        archived: Boolean(row.archived),
        tags: normalizeTags(fromJson(row.tags_json)),
        archivedAt: row.archived_at,
    };
}

function buildConversationFilters(opts?: { archived?: 'all' | 'active' | 'archived'; tags?: string[] }) {
    const where: string[] = [];
    const values: unknown[] = [];
    const archived = opts?.archived ?? 'active';
    if (archived === 'active') where.push('COALESCE(c.archived, 0) = 0');
    if (archived === 'archived') where.push('COALESCE(c.archived, 0) = 1');
    for (const tag of normalizeTags(opts?.tags)) {
        where.push('c.tags_json LIKE ?');
        values.push(`%"${tag.replace(/"/g, '\\"')}"%`);
    }
    return { where, values };
}

function mapMessage(row: any) {
    if (!row) return null;
    return {
        ...row,
        conversationId: row.conversation_id,
        toolCalls: fromJson(row.tool_calls),
        contentParts: fromJson(row.content_parts),
        attachments: fromJson(row.attachments),
        thinking: fromJson(row.thinking),
        streamState: row.stream_state,
        durationMs: row.duration_ms,
        runId: row.run_id,
        runEvents: fromJson(row.run_events),
        diffs: fromJson(row.diffs),
        rollbackSnapshotId: row.rollback_snapshot_id,
    };
}

export function registerConversationHandlers(): void {
    const db = getDatabase();

    // 创建对话
    ipcMain.handle('conversation:create', (_e, data: {
        id: string; title?: string; model?: string; mode?: string; workspaceId?: string;
        schemaVersion?: number; summary?: unknown; lastMessage?: string;
        assistantRuns?: unknown; fileSnapshots?: unknown; pendingDiffs?: unknown;
        archived?: boolean; tags?: string[];
    }) => {
        db.prepare(
            `INSERT INTO conversations (
              id, workspace_id, title, model, mode, schema_version, summary_json,
              last_message, assistant_runs, file_snapshots, pending_diffs, archived, tags_json, archived_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            data.id,
            data.workspaceId || null,
            data.title || '新对话',
            data.model || null,
            data.mode || 'planning',
            data.schemaVersion ?? 1,
            toJson(data.summary),
            data.lastMessage || '',
            toJson(data.assistantRuns ?? {}),
            toJson(data.fileSnapshots ?? {}),
            toJson(data.pendingDiffs ?? []),
            data.archived ? 1 : 0,
            toJson(normalizeTags(data.tags)),
            data.archived ? Math.floor(Date.now() / 1000) : null,
        );
        return { id: data.id };
    });

    // 获取对话列表
    ipcMain.handle('conversation:list', (_e, opts?: { workspaceId?: string; limit?: number; archived?: 'all' | 'active' | 'archived'; tags?: string[] }) => {
        const limit = opts?.limit || 50;
        const filters = buildConversationFilters(opts);
        if (opts?.workspaceId) {
            filters.where.unshift('c.workspace_id = ?');
            filters.values.unshift(opts.workspaceId);
        }
        const whereSql = filters.where.length ? `WHERE ${filters.where.join(' AND ')}` : '';
        return (db.prepare(
            `SELECT c.* FROM conversations c ${whereSql} ORDER BY c.updated_at DESC LIMIT ?`,
        ).all(...filters.values, limit) as any[]).map(mapConversation);
    });

    // 获取单个对话
    ipcMain.handle('conversation:get', (_e, id: string) => {
        return mapConversation(db.prepare('SELECT * FROM conversations WHERE id = ?').get(id));
    });

    // 更新对话
    ipcMain.handle('conversation:update', (_e, id: string, data: {
        title?: string; model?: string; schemaVersion?: number; summary?: unknown; lastMessage?: string;
        assistantRuns?: unknown; fileSnapshots?: unknown; pendingDiffs?: unknown;
        archived?: boolean; tags?: string[];
    }) => {
        const sets: string[] = ['updated_at = unixepoch()'];
        const vals: unknown[] = [];
        if (data.title !== undefined) { sets.push('title = ?'); vals.push(data.title); }
        if (data.model !== undefined) { sets.push('model = ?'); vals.push(data.model); }
        if (data.schemaVersion !== undefined) { sets.push('schema_version = ?'); vals.push(data.schemaVersion); }
        if (data.summary !== undefined) { sets.push('summary_json = ?'); vals.push(toJson(data.summary)); }
        if (data.lastMessage !== undefined) { sets.push('last_message = ?'); vals.push(data.lastMessage); }
        if (data.assistantRuns !== undefined) { sets.push('assistant_runs = ?'); vals.push(toJson(data.assistantRuns)); }
        if (data.fileSnapshots !== undefined) { sets.push('file_snapshots = ?'); vals.push(toJson(data.fileSnapshots)); }
        if (data.pendingDiffs !== undefined) { sets.push('pending_diffs = ?'); vals.push(toJson(data.pendingDiffs)); }
        if (data.archived !== undefined) {
            sets.push('archived = ?');
            vals.push(data.archived ? 1 : 0);
            sets.push('archived_at = ?');
            vals.push(data.archived ? Math.floor(Date.now() / 1000) : null);
        }
        if (data.tags !== undefined) { sets.push('tags_json = ?'); vals.push(toJson(normalizeTags(data.tags))); }
        vals.push(id);
        db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        return true;
    });

    // 删除对话（CASCADE 删消息）
    ipcMain.handle('conversation:delete', (_e, id: string) => {
        db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
        return true;
    });

    ipcMain.handle('conversation:batchDelete', (_e, ids: string[]) => {
        const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
        const tx = db.transaction(() => {
            const stmt = db.prepare('DELETE FROM conversations WHERE id = ?');
            uniqueIds.forEach(id => stmt.run(id));
        });
        tx();
        return true;
    });

    ipcMain.handle('conversation:batchUpdate', (_e, ids: string[], data: { archived?: boolean; tags?: string[] }) => {
        const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
        const sets: string[] = ['updated_at = unixepoch()'];
        const vals: unknown[] = [];
        if (data.archived !== undefined) {
            sets.push('archived = ?');
            vals.push(data.archived ? 1 : 0);
            sets.push('archived_at = ?');
            vals.push(data.archived ? Math.floor(Date.now() / 1000) : null);
        }
        if (data.tags !== undefined) {
            sets.push('tags_json = ?');
            vals.push(toJson(normalizeTags(data.tags)));
        }
        if (sets.length === 1) return true;
        const tx = db.transaction(() => {
            const stmt = db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`);
            uniqueIds.forEach(id => stmt.run(...vals, id));
        });
        tx();
        return true;
    });

    // 添加消息
    ipcMain.handle('message:add', (_e, msg: {
        id: string; conversationId: string; role: string; content: string; timestamp: number;
        model?: string; toolCalls?: unknown[]; contentParts?: unknown[]; attachments?: unknown[];
        thinking?: unknown; streamState?: string; durationMs?: number; runId?: string;
        runEvents?: unknown[]; diffs?: unknown[]; rollbackSnapshotId?: string; error?: string;
    }) => {
        db.prepare(
            `INSERT OR REPLACE INTO messages (
              id, conversation_id, role, content, timestamp, tool_calls, model,
              content_parts, attachments, thinking, stream_state, duration_ms,
              run_id, run_events, diffs, rollback_snapshot_id, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            msg.id,
            msg.conversationId,
            msg.role,
            msg.content,
            msg.timestamp,
            toJson(msg.toolCalls),
            msg.model || null,
            toJson(msg.contentParts),
            toJson(msg.attachments),
            toJson(msg.thinking),
            msg.streamState || null,
            msg.durationMs ?? null,
            msg.runId || null,
            toJson(msg.runEvents),
            toJson(msg.diffs),
            msg.rollbackSnapshotId || null,
            msg.error || null,
        );
        // 更新对话消息数和时间戳
        db.prepare(
            `UPDATE conversations
             SET message_count = (SELECT COUNT(*) FROM messages WHERE conversation_id = ?),
                 last_message = ?,
                 updated_at = unixepoch()
             WHERE id = ?`,
        ).run(msg.conversationId, msg.content.slice(0, 200), msg.conversationId);
        return true;
    });

    // 替换某个对话的全部消息，用于 autosave / rollback 后避免旧消息复活。
    ipcMain.handle('message:replaceConversation', (_e, conversationId: string, messages: Array<{
        id: string; role: string; content: string; timestamp: number;
        model?: string; toolCalls?: unknown[]; contentParts?: unknown[]; attachments?: unknown[];
        thinking?: unknown; streamState?: string; durationMs?: number; runId?: string;
        runEvents?: unknown[]; diffs?: unknown[]; rollbackSnapshotId?: string; error?: string;
    }>) => {
        const tx = db.transaction(() => {
            db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
            const insert = db.prepare(
                `INSERT INTO messages (
                  id, conversation_id, role, content, timestamp, tool_calls, model,
                  content_parts, attachments, thinking, stream_state, duration_ms,
                  run_id, run_events, diffs, rollback_snapshot_id, error
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            );
            for (const msg of messages) {
                insert.run(
                    msg.id,
                    conversationId,
                    msg.role,
                    msg.content,
                    msg.timestamp,
                    toJson(msg.toolCalls),
                    msg.model || null,
                    toJson(msg.contentParts),
                    toJson(msg.attachments),
                    toJson(msg.thinking),
                    msg.streamState || null,
                    msg.durationMs ?? null,
                    msg.runId || null,
                    toJson(msg.runEvents),
                    toJson(msg.diffs),
                    msg.rollbackSnapshotId || null,
                    msg.error || null,
                );
            }
            const last = messages[messages.length - 1];
            db.prepare(
                `UPDATE conversations
                 SET message_count = ?,
                     last_message = ?,
                     updated_at = unixepoch()
                 WHERE id = ?`,
            ).run(messages.length, last?.content?.slice(0, 200) ?? '', conversationId);
        });
        tx();
        return true;
    });

    // 获取对话消息
    ipcMain.handle('message:list', (_e, conversationId: string) => {
        const rows = db.prepare(
            'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC',
        ).all(conversationId) as any[];
        return rows.map(mapMessage);
    });

    // 搜索对话（全文）
    ipcMain.handle('conversation:search', (_e, query: string, opts?: { archived?: 'all' | 'active' | 'archived'; tags?: string[]; limit?: number }) => {
        const filters = buildConversationFilters(opts);
        const limit = opts?.limit || 50;
        try {
            const whereSql = filters.where.length ? `AND ${filters.where.join(' AND ')}` : '';
            const ftsRows = db.prepare(
                `SELECT c.*, snippet(search_index, 1, '<b>', '</b>', '...', 20) as match_snippet
                 FROM search_index si
                 JOIN conversations c ON si.source_id = c.id AND si.source_type = 'conversation'
                 WHERE search_index MATCH ?
                 ${whereSql}
                 ORDER BY rank LIMIT ?`,
            ).all(query, ...filters.values, limit) as any[];
            if (ftsRows.length > 0) return ftsRows.map(mapConversation);
        } catch {
            // Older databases may have no populated FTS rows; fall through to LIKE search.
        }

        const like = `%${query}%`;
        const filterSql = filters.where.length ? `AND ${filters.where.join(' AND ')}` : '';
        return (db.prepare(
            `SELECT DISTINCT c.*, '' as match_snippet
             FROM conversations c
             LEFT JOIN messages m ON m.conversation_id = c.id
             WHERE (
                c.title LIKE ?
                OR c.last_message LIKE ?
                OR c.tags_json LIKE ?
                OR m.content LIKE ?
             )
                ${filterSql}
             ORDER BY c.updated_at DESC
             LIMIT ?`,
        ).all(like, like, like, like, ...filters.values, limit) as any[]).map(mapConversation);
    });
}

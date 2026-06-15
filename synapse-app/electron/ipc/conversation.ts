/**
 * IPC Conversation Handler
 * 对话 CRUD + 消息管理 + 搜索
 */

import { ipcMain } from 'electron';
import { getDatabase, ensureColumn, hasColumn } from '../database';

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
        // M2-3 对话分支溯源：非分支对话两者为 null。
        parentId: row.parent_id ?? null,
        branchedFromMessageId: row.branched_from_message_id ?? null,
        // M2-6 对话级元数据：mode 由 `...row` 自带（列名同 key）；reasoning_effort 列名带下划线需显式映射。
        // 旧行（建列前）为 null，上层 loadPlatformSnapshot 回退默认。
        reasoningEffort: row.reasoning_effort ?? null,
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

function mapRecord(row: any) {
    if (!row) return null;
    const phases = fromJson<number>(row.phases_json);
    // M2-R1：batches 是真相源（v2 落 batches_json），随行返回供 recordStore.normalizeRecord 解析；
    // schemaVersion 决定是否走懒迁移（<2 且无 batches 时合成历史批）。
    const batches = fromJson<unknown[]>(row.batches_json);
    return {
        conversationId: row.conversation_id,
        batches: Array.isArray(batches) ? batches : undefined,
        contentMd: row.content_md ?? '',
        totalRounds: row.total_rounds ?? 0,
        totalSteps: row.total_steps ?? 0,
        phases: typeof phases === 'number' ? phases : 0,
        lastUpdatedRound: row.last_updated_round ?? 0,
        timeSpan: row.time_span ?? '',
        schemaVersion: row.record_schema_version ?? 1,
        updatedAt: row.updated_at,
    };
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

    // ★ M2-6 真机根因防御性自愈：reasoning_effort 列是 ensureColumn 后加的（database.ts ~line164）。
    //   若运行的库该列未迁移成功（旧构建初始化的库、迁移异常等），带该列的 INSERT/UPDATE 会整条 throw，
    //   连 mode/messages 一起存不进去（mode 列建表自带故幸存 → 表象「mode 对、reasoningEffort 错」）。
    //   这里在 handler 注册时再补一次（幂等），把列补齐到当前运行库；万一仍补不上，下方写入路径按
    //   hasReasoningEffortColumn 降级（跳过该字段，至少不拖垮整条保存）。
    try { ensureColumn(db, 'conversations', 'reasoning_effort', 'TEXT'); } catch { /* 自愈失败则靠下方降级兜底 */ }
    // 缓存列存在性（PRAGMA 不必每次写都跑）。注册期仅一次；ensureColumn 已尽力补齐，故通常为 true。
    const hasReasoningEffortColumn = hasColumn(db, 'conversations', 'reasoning_effort');

    // 创建对话
    ipcMain.handle('conversation:create', (_e, data: {
        id: string; title?: string; model?: string; mode?: string; reasoningEffort?: string; workspaceId?: string;
        schemaVersion?: number; summary?: unknown; lastMessage?: string;
        assistantRuns?: unknown; fileSnapshots?: unknown; pendingDiffs?: unknown;
        archived?: boolean; tags?: string[];
        // M2-3 对话分支：fork 时写入溯源；普通新建为 undefined → 落 NULL。
        parentId?: string | null; branchedFromMessageId?: string | null;
    }) => {
        // ★ 缺列降级：reasoning_effort 列缺失时，动态拼一条【不含该列】的 INSERT，
        //   保住 mode/messages 正常落库（不再因一个缺列整条失败）。列存在则带上（正常路径）。
        const cols = [
            'id', 'workspace_id', 'title', 'model', 'mode',
            'schema_version', 'summary_json', 'last_message',
            'assistant_runs', 'file_snapshots', 'pending_diffs', 'archived', 'tags_json', 'archived_at',
            'parent_id', 'branched_from_message_id',
        ];
        const vals: unknown[] = [
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
            data.parentId ?? null,
            data.branchedFromMessageId ?? null,
        ];
        if (hasReasoningEffortColumn) {
            // 插在 mode 之后位置一致即可（列顺序与 vals 顺序对应；这里追加到尾部并补对应值）。
            cols.push('reasoning_effort');
            // M2-6 对话级思考层级：缺省/空串落默认 'auto'（与 agentSettings 初值一致；空串也回退避免下拉落空）。
            vals.push(data.reasoningEffort || 'auto');
        }
        const placeholders = cols.map(() => '?').join(', ');
        db.prepare(
            `INSERT INTO conversations (${cols.join(', ')}) VALUES (${placeholders})`,
        ).run(...vals);
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
        title?: string; model?: string; mode?: string; reasoningEffort?: string; schemaVersion?: number; summary?: unknown; lastMessage?: string;
        assistantRuns?: unknown; fileSnapshots?: unknown; pendingDiffs?: unknown;
        archived?: boolean; tags?: string[];
        // M2-3：分支溯源一般在 create 时写定；update 仅在显式回填时生效（undefined 不动）。
        parentId?: string | null; branchedFromMessageId?: string | null;
    }) => {
        const sets: string[] = ['updated_at = unixepoch()'];
        const vals: unknown[] = [];
        if (data.title !== undefined) { sets.push('title = ?'); vals.push(data.title); }
        if (data.model !== undefined) { sets.push('model = ?'); vals.push(data.model); }
        // M2-6 对话级元数据：每次保存把该对话当前 mode / reasoning_effort 落库（undefined 时不动，保旧值）。
        if (data.mode !== undefined) { sets.push('mode = ?'); vals.push(data.mode); }
        // ★ 缺列降级：reasoning_effort 列缺失时跳过该字段，避免整条 UPDATE throw 拖垮 mode/last_message 等同批写入
        //   （真机根因：M2-6 把 reasoning_effort 耦合进同一 UPDATE，列缺失即连带其它字段一起失败）。
        //   空串也回退默认 'auto'，避免 DB 落空串导致下拉框落空。
        if (hasReasoningEffortColumn && data.reasoningEffort !== undefined) {
            sets.push('reasoning_effort = ?');
            vals.push(data.reasoningEffort || 'auto');
        }
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
        if (data.parentId !== undefined) { sets.push('parent_id = ?'); vals.push(data.parentId ?? null); }
        if (data.branchedFromMessageId !== undefined) { sets.push('branched_from_message_id = ?'); vals.push(data.branchedFromMessageId ?? null); }
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

    // ===== Record（M1 上下文 harness 过程日志）=====

    // 读取某对话的 record
    ipcMain.handle('record:get', (_e, conversationId: string) => {
        if (!conversationId) return null;
        return mapRecord(db.prepare('SELECT * FROM records WHERE conversation_id = ?').get(conversationId));
    });

    // 写入 / 覆盖 record（upsert 整条，调用方负责合并）。
    // M2-R1：batches_json（多批结构，真相源）+ record_schema_version 一并落盘；
    // content_md 仍写派生全文（v1 回滚保险 / 旧调用方兼容）。
    // ★ R5 崩溃恢复依赖：这是【单条 INSERT...ON CONFLICT DO UPDATE】，better-sqlite3 单语句即单事务、
    //   天然原子——进程在 .run() 中途崩溃不会留下半写的 batches_json（要么旧值、要么新值整体）。
    //   recordStore.appendBatch 的「崩溃可恢复」正建立在此原子性 + 其幂等校验之上；
    //   若将来拆成多条 SQL 写入，必须用 db.transaction(...) 包住，否则恢复保证破裂。
    ipcMain.handle('record:upsert', (_e, data: {
        conversationId: string; batches?: unknown[]; schemaVersion?: number;
        contentMd?: string; totalRounds?: number; totalSteps?: number;
        phases?: number; lastUpdatedRound?: number; timeSpan?: string; updatedAt?: number;
        // ★ R5 修复（问题1/4）：可选乐观并发水位门。appendBatch 落新批时传入「期望的 DB 当前末批 stepEnd」
        // (= 本批 stepStart)。仅当 DB 现有 total_steps（派生 = 末批 stepEnd）等于本值时才 DO UPDATE，
        // 否则不写（changes=0 → 返回 false）。把幂等校验下推到这条【单条原子 upsert】的 WHERE，
        // 杜绝「getRecord→内存合并→saveRecord」的交错读改写窗口（两路并发各自读到同一 priorSteps，
        // 第一路写入推进 total_steps 后，第二路 WHERE 不匹配被拒，不再后写覆盖先写）。
        // 不传（undefined）时保持原【无条件整条覆盖】语义（upsertRecord / clampToBatch 用），始终返回 true。
        expectedStepStart?: number;
    }) => {
        if (!data?.conversationId) return false;
        const args = [
            data.conversationId,
            data.contentMd ?? '',
            data.totalRounds ?? 0,
            data.totalSteps ?? 0,
            toJson(data.phases ?? 0),
            data.lastUpdatedRound ?? 0,
            data.timeSpan ?? null,
            // 全库时间戳统一为「秒」(unixepoch)，与 conversations/messages 表一致；
            // 回退也用秒，避免 idx_records_updated 与其它表跨表比较差 1000 倍。
            data.updatedAt ?? Math.floor(Date.now() / 1000),
            toJson(data.batches ?? null),
            data.schemaVersion ?? 2,
        ];
        const setClause = `
              content_md = excluded.content_md,
              total_rounds = excluded.total_rounds,
              total_steps = excluded.total_steps,
              phases_json = excluded.phases_json,
              last_updated_round = excluded.last_updated_round,
              time_span = excluded.time_span,
              updated_at = excluded.updated_at,
              batches_json = excluded.batches_json,
              record_schema_version = excluded.record_schema_version`;
        const hasGate = typeof data.expectedStepStart === 'number';
        // 带水位门时：DO UPDATE 仅当现有 total_steps == expectedStepStart 才执行（WHERE 引用绑定参数 + 当前行列）。
        // 注意：纯 INSERT（无冲突，首批且 expectedStepStart 应为 0）不受 WHERE 影响，照常插入。
        const sql = hasGate
            ? `INSERT INTO records (
                  conversation_id, content_md, total_rounds, total_steps,
                  phases_json, last_updated_round, time_span, updated_at,
                  batches_json, record_schema_version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(conversation_id) DO UPDATE SET ${setClause}
                  WHERE records.total_steps = ?`
            : `INSERT INTO records (
                  conversation_id, content_md, total_rounds, total_steps,
                  phases_json, last_updated_round, time_span, updated_at,
                  batches_json, record_schema_version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(conversation_id) DO UPDATE SET ${setClause}`;
        if (hasGate) args.push(data.expectedStepStart as number);
        const result = db.prepare(sql).run(...args);
        // 带水位门时返回真实写入与否（changes=0 表示 WHERE 不匹配、被并发推进，未写）；
        // 无水位门时整条覆盖必然生效，返回 true。
        return hasGate ? result.changes > 0 : true;
    });

    // 删除某对话的 record（对话删除时已由外键级联，这里供显式失效用）
    ipcMain.handle('record:delete', (_e, conversationId: string) => {
        if (!conversationId) return false;
        db.prepare('DELETE FROM records WHERE conversation_id = ?').run(conversationId);
        return true;
    });
}

/**
 * SQLite Database Manager
 * 使用 better-sqlite3 管理 Synapse 持久化数据
 * 路径: ~/.synapse/synapse.db
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

let db: Database.Database | null = null;

function getDbPath(): string {
    const dir = path.join(app.getPath('home'), '.synapse');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, 'synapse.db');
}

export function initDatabase(): Database.Database {
    if (db) return db;

    const dbPath = getDbPath();
    db = new Database(dbPath);

    // 启用 WAL 模式提升并发性能
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // 创建表
    db.exec(`
    -- 工作区表
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_opened INTEGER
    );

    -- 对话表
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      title TEXT NOT NULL DEFAULT '新对话',
      model TEXT,
      mode TEXT DEFAULT 'planning',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      message_count INTEGER DEFAULT 0,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
    );

    -- 消息表
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
      content TEXT NOT NULL DEFAULT '',
      timestamp INTEGER NOT NULL,
      tool_calls TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    -- Record 表（M1 上下文 harness：对话过程日志，给模型读的结构化压缩前缀）
    -- 每个对话至多一条，conversation_id 主键，随对话删除级联清理。
    CREATE TABLE IF NOT EXISTS records (
      conversation_id TEXT PRIMARY KEY,
      content_md TEXT NOT NULL DEFAULT '',
      total_rounds INTEGER NOT NULL DEFAULT 0,
      total_steps INTEGER NOT NULL DEFAULT 0,
      phases_json TEXT,
      last_updated_round INTEGER NOT NULL DEFAULT 0,
      time_span TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    -- Memory 表（M1 上下文 harness：AI 主动记忆，模型通过内置工具 memory_write/memory_query 维护）
    -- 跨对话长期记忆条目，与按对话主键的 records 表正交；不随对话删除级联（记忆可跨对话存活）。
    -- conversation_id 仅记录来源，故意不设外键，避免对话删除时连带清空记忆。
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      tags_json TEXT,
      category TEXT NOT NULL DEFAULT 'general',
      search_summary TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      conversation_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- 附件账本表（M2-R6 附件分离存储：内容寻址 + refCount GC）
    -- 对话本体/messages 只存 sha256 引用，实体二进制落盘 attachments/<sha256[:2]>/<sha256>.<ext>。
    -- 同一二进制天然去重：sha256 命中即复用、ref_count+1；移除附件 ref_count-1，归零删实体+删行(GC)。
    -- 故意不设外键：附件实体与对话生命周期正交，靠 ref_count 计数回收，不随对话级联删。
    CREATE TABLE IF NOT EXISTS attachments (
      sha256 TEXT PRIMARY KEY,
      mime TEXT,
      kind TEXT,
      size INTEGER,
      ref_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Synopsis 缓存表
    CREATE TABLE IF NOT EXISTS synopsis_cache (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      synopsis_type TEXT NOT NULL DEFAULT 'brief',
      content TEXT NOT NULL,
      chunks TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(file_path, file_hash, synopsis_type)
    );

    -- 设置表
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- FTS5 搜索索引
    CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
      title, content, source_type, source_id,
      tokenize='unicode61'
    );

    -- 索引
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_synopsis_file ON synopsis_cache(file_path);
    CREATE INDEX IF NOT EXISTS idx_records_updated ON records(updated_at);
    CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);
    CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned);
    CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
  `);

    ensureColumn(db, 'conversations', 'schema_version', 'INTEGER DEFAULT 1');
    ensureColumn(db, 'conversations', 'summary_json', 'TEXT');
    ensureColumn(db, 'conversations', 'last_message', 'TEXT');
    ensureColumn(db, 'conversations', 'assistant_runs', 'TEXT');
    ensureColumn(db, 'conversations', 'file_snapshots', 'TEXT');
    ensureColumn(db, 'conversations', 'pending_diffs', 'TEXT');
    ensureColumn(db, 'conversations', 'archived', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(db, 'conversations', 'tags_json', 'TEXT');
    ensureColumn(db, 'conversations', 'archived_at', 'INTEGER');

    // M2-3 对话分支：分支出的新对话记录其来源。parent_id = 源对话 id（树形溯源），
    // branched_from_message_id = 在源对话哪条消息处「从此分支」。两列对旧行均为 NULL（非分支对话），
    // ensureColumn 懒迁移加列不破坏旧库；新增不设外键（源对话被删后分支仍可独立存活，仅 parent_id 指向悬空 id）。
    ensureColumn(db, 'conversations', 'parent_id', 'TEXT');
    ensureColumn(db, 'conversations', 'branched_from_message_id', 'TEXT');

    // M2-6 对话级元数据：每个对话记自己的思考层级 reasoning_effort（mode 列建表时已有，line ~50）。
    // 旧行该列为 NULL，读回时由上层回退默认 'auto'；ensureColumn 懒迁移加列不破坏旧库。
    ensureColumn(db, 'conversations', 'reasoning_effort', 'TEXT');

    // M3-1a 真子代理：子代理跑完把其消息序列作为一个独立 conversation 落库（复用 conversations 表），
    // 带 parent_id=主对话 id + is_subagent=1 标记，供 M3-3 卡片点进查看其完整对话流。
    // 旧行该列为 NULL/0（普通对话非子代理）；ensureColumn 懒迁移加列不破坏旧库；IPC 读回时映射为 isSubAgent。
    ensureColumn(db, 'conversations', 'is_subagent', 'INTEGER NOT NULL DEFAULT 0');

    ensureColumn(db, 'messages', 'model', 'TEXT');
    ensureColumn(db, 'messages', 'content_parts', 'TEXT');
    ensureColumn(db, 'messages', 'attachments', 'TEXT');
    ensureColumn(db, 'messages', 'thinking', 'TEXT');
    ensureColumn(db, 'messages', 'stream_state', 'TEXT');
    ensureColumn(db, 'messages', 'duration_ms', 'INTEGER');
    ensureColumn(db, 'messages', 'run_id', 'TEXT');
    ensureColumn(db, 'messages', 'run_events', 'TEXT');
    ensureColumn(db, 'messages', 'diffs', 'TEXT');
    ensureColumn(db, 'messages', 'rollback_snapshot_id', 'TEXT');
    ensureColumn(db, 'messages', 'error', 'TEXT');

    // M2-R1 多批次 record：batches_json 落多批结构（真相源），record_schema_version 标记 v2。
    // content_md 旧列保留不删（v1 回滚保险 / 懒迁移源）。用 ensureColumn 兼容旧库。
    ensureColumn(db, 'records', 'batches_json', 'TEXT');
    ensureColumn(db, 'records', 'record_schema_version', 'INTEGER NOT NULL DEFAULT 1');

    console.log('[database] Initialized at:', dbPath);
    return db;
}

// 导出供 IPC 层做防御性自愈（见 conversation.ts：注册时再补一次 reasoning_effort 列，
// 兼容「迁移因旧构建/异常未覆盖到该列」的库）。幂等：列已存在则 no-op。
export function ensureColumn(database: Database.Database, table: string, column: string, definition: string): void {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some(c => c.name === column)) {
        database.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    }
}

/**
 * 运行期检测某表是否含某列。供写入路径在「列可能缺失」时降级，避免一条写整条 throw。
 * ★ M2-6 真机根因：reasoning_effort 列是 ensureColumn 后加的；若运行的库该列未迁移成功，
 *   带该列的 INSERT/UPDATE 会整条失败 → 连 mode/messages 也一起存不进（mode 列建表自带故幸存，
 *   造成「mode 对、reasoningEffort 错」的非对称表象）。写入侧据此判定，缺列则跳过该字段。
 */
export function hasColumn(database: Database.Database, table: string, column: string): boolean {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return columns.some(c => c.name === column);
}

export function getDatabase(): Database.Database {
    if (!db) throw new Error('Database not initialized');
    return db;
}

export function closeDatabase(): void {
    if (db) {
        db.close();
        db = null;
        console.log('[database] Closed');
    }
}

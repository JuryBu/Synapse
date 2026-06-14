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

    console.log('[database] Initialized at:', dbPath);
    return db;
}

function ensureColumn(database: Database.Database, table: string, column: string, definition: string): void {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some(c => c.name === column)) {
        database.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    }
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

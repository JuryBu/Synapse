/**
 * Record Store
 * M1 上下文 harness 的 record 层数据访问。
 *
 * record 是「给模型读」的结构化对话过程日志（markdown），用于在压缩点之前
 * 把已发生的历史浓缩成稳定前缀，命中 prompt cache。每个对话至多一条 record，
 * 以 conversationId 为主键；增量更新时只追加未覆盖的新增轮次（基于 lastUpdatedRound）。
 *
 * 数据访问统一走 platform 抽象：Electron 落 SQLite records 表，Web 落 localStorage。
 *
 * 设计参考外置 mcp-memory-store 的 RecordIndexEntry（conversationId / totalRounds /
 * totalSteps / phases / timeSpan / lastUpdatedRound），Synapse 用 SQLite 单表存储，
 * 不照搬其多文件 + 索引方案。
 */

import { platform } from '@/platform';

/** record 数据模型（运行态 / 持久化对等结构，camelCase） */
export interface SynapseRecord {
  /** 对话 ID（主键） */
  conversationId: string;
  /** 结构化过程日志正文（markdown） */
  contentMd: string;
  /** record 覆盖到的总轮次（一问一答算一轮，用户消息数） */
  totalRounds: number;
  /** record 覆盖到的总步骤数（含工具往返的所有消息条数） */
  totalSteps: number;
  /** Phase 数量（用于概览，可为 0） */
  phases: number;
  /** record 已覆盖到第几轮，增量更新的水位线 */
  lastUpdatedRound: number;
  /** 时间跨度 "YYYY-MM-DD HH:mm ~ YYYY-MM-DD HH:mm"（可空字符串） */
  timeSpan: string;
  /** 最近一次写入时间（秒级 Unix 时间戳，与全库 conversations/messages 统一单位） */
  updatedAt: number;
}

/** upsert 入参：除 conversationId 外其余字段可选，缺省走合并保留逻辑 */
export interface RecordUpsertInput {
  conversationId: string;
  contentMd?: string;
  totalRounds?: number;
  totalSteps?: number;
  phases?: number;
  lastUpdatedRound?: number;
  timeSpan?: string;
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 解析 "start ~ end" 跨度字符串两端（已格式化展示文本） */
function splitSpan(span?: string): [string, string] {
  if (!span) return ['', ''];
  const idx = span.indexOf('~');
  if (idx < 0) return [span.trim(), span.trim()];
  return [span.slice(0, idx).trim(), span.slice(idx + 1).trim()];
}

/**
 * 合并已有跨度与传入跨度：起点取「更早」、终点取「更晚」。
 * 兜底层防御——正常情况下 generateRecord 已用 priorTimeSpan 合并好整段跨度再传入；
 * 这里再保一道，确保 upsert 不会因只传本批跨度而让 record 的「对话开始时间」后移。
 * 两端为 "YYYY-MM-DD HH:mm" 时字典序与时间序一致，作概览足够。
 */
function mergeTimeSpan(existing?: string, incoming?: string): string {
  if (incoming === undefined) return existing ?? '';
  const [eStart, eEnd] = splitSpan(existing);
  const [iStart, iEnd] = splitSpan(incoming);
  const starts = [eStart, iStart].filter(Boolean);
  const ends = [eEnd, iEnd].filter(Boolean);
  const start = starts.length ? starts.reduce((a, b) => (a <= b ? a : b)) : '';
  const end = ends.length ? ends.reduce((a, b) => (a >= b ? a : b)) : '';
  if (!start && !end) return '';
  return start && end ? `${start} ~ ${end}` : start || end;
}

/** 把 platform 返回的原始行（可能是 snake_case 或 camelCase）规范成 SynapseRecord */
function normalizeRecord(raw: unknown): SynapseRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const conversationId = String(row.conversationId ?? row.conversation_id ?? '');
  if (!conversationId) return null;
  return {
    conversationId,
    contentMd: String(row.contentMd ?? row.content_md ?? ''),
    totalRounds: toNumber(row.totalRounds ?? row.total_rounds),
    totalSteps: toNumber(row.totalSteps ?? row.total_steps),
    phases: toNumber(row.phases ?? row.phases_json /* 兼容旧字段名 */ ?? row.phaseCount),
    lastUpdatedRound: toNumber(row.lastUpdatedRound ?? row.last_updated_round),
    timeSpan: String(row.timeSpan ?? row.time_span ?? ''),
    updatedAt: toNumber(row.updatedAt ?? row.updated_at, Math.floor(Date.now() / 1000)),
  };
}

/**
 * 读取某对话的 record；不存在返回 null。
 * 任何底层异常都吞掉返回 null —— record 是加速层，绝不能阻塞主对话。
 */
export async function getRecord(conversationId: string): Promise<SynapseRecord | null> {
  if (!conversationId) return null;
  try {
    const raw = await platform.conversation.getRecord?.(conversationId);
    return normalizeRecord(raw);
  } catch (err) {
    console.warn('[recordStore] getRecord failed:', err);
    return null;
  }
}

/**
 * 写入 / 更新 record —— 纯持久化层（整条覆盖语义，缺省字段保留已有值）。
 *
 * ★ 职责边界：本函数【不做内容生成与合并】。contentMd 一律按调用方给的整条覆盖；
 *   「读已有 record + 新增内容 → 合并成全文」的活由 `recordGenerator.generateRecord` 负责。
 *   唯一的特殊处理是 timeSpan 做 min/max 合并（防止整段对话开始时间随增量后移）。
 * 成功返回写入后的最新 record，失败返回 null（不抛）。
 */
export async function upsertRecord(input: RecordUpsertInput): Promise<SynapseRecord | null> {
  if (!input?.conversationId) return null;
  try {
    const existing = await getRecord(input.conversationId);
    const merged: SynapseRecord = {
      conversationId: input.conversationId,
      contentMd: input.contentMd ?? existing?.contentMd ?? '',
      totalRounds: input.totalRounds ?? existing?.totalRounds ?? 0,
      totalSteps: input.totalSteps ?? existing?.totalSteps ?? 0,
      phases: input.phases ?? existing?.phases ?? 0,
      lastUpdatedRound: input.lastUpdatedRound ?? existing?.lastUpdatedRound ?? 0,
      timeSpan: mergeTimeSpan(existing?.timeSpan, input.timeSpan),
      // 秒级 Unix 时间戳，与全库 conversations/messages 统一单位。
      updatedAt: Math.floor(Date.now() / 1000),
    };
    await platform.conversation.saveRecord?.(merged);
    return merged;
  } catch (err) {
    console.warn('[recordStore] upsertRecord failed:', err);
    return null;
  }
}

/**
 * 追加一条【纯手动补充笔记】到已有 record 末尾（字符拼接，不经 LLM）。
 *
 * ★ 用途严格限定：仅供用户/UI 手动往过程日志里补一段备注的场景，
 *   补充内容会自动带上 `[手动补充]` 标记，后续 `generateRecord` 的合并 prompt
 *   会原样保留这类内容。
 * ★ 严禁与 `generateRecord(update)` 混用于同一次写入：generateRecord 返回的是
 *   「LLM 已合并的完整全文」，若再字符拼接会造成内容重复、双标题、结构破坏。
 *   增量压缩走 generateRecord 全文重写，不要走这里。
 * - 若 record 尚不存在，等价于一次全量 upsert（以这段笔记为正文）。
 * - 不抬高 lastUpdatedRound（手动笔记与轮次水位线无关）。
 */
export async function appendManualNote(
  conversationId: string,
  note: string,
): Promise<SynapseRecord | null> {
  if (!conversationId || !note.trim()) return null;
  try {
    const marked = note.trim().startsWith('[手动补充]') ? note.trim() : `[手动补充] ${note.trim()}`;
    const existing = await getRecord(conversationId);
    if (!existing || !existing.contentMd.trim()) {
      return upsertRecord({ conversationId, contentMd: marked });
    }
    const joined = `${existing.contentMd.trimEnd()}\n\n${marked}`;
    return upsertRecord({ conversationId, contentMd: joined });
  } catch (err) {
    console.warn('[recordStore] appendManualNote failed:', err);
    return null;
  }
}

/**
 * 删除某对话的 record（对话删除 / rollback 失效时调用）。
 * 失败返回 false，不抛。
 */
export async function deleteRecord(conversationId: string): Promise<boolean> {
  if (!conversationId) return false;
  try {
    await platform.conversation.deleteRecord?.(conversationId);
    return true;
  } catch (err) {
    console.warn('[recordStore] deleteRecord failed:', err);
    return false;
  }
}

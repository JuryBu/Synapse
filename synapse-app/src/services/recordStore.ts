/**
 * Record Store
 * M2 上下文 harness 的 record 层数据访问（多批次追加架构）。
 *
 * record 是「给模型读」的结构化对话过程日志（markdown），用于在压缩点之前
 * 把已发生的历史浓缩成稳定前缀，命中 prompt cache。
 *
 * ★ M2-R1 重构：从「单条 contentMd 合并全文」改为「多批次追加」。
 *   - record = 有序批次列表 batches[]，每次压缩只【追加新批次到末尾】，已有批次永不重写。
 *   - 新批次生成输入 = 旧批骨架（只读概览）+ 本批新增原文，不再重喂全量原文让模型覆盖全程。
 *   - 防膨胀靠「改读不改写」：每批两形态——全文 contentMd / 骨架 skeleton（正则零成本提取）。
 *   - 派生水位 totalRounds/totalSteps/lastUpdatedRound/timeSpan = 末批，append 时同步。
 *
 * ★ DB 懒迁移（零丢失）：旧单条 record（content_md 非空、schema_version<2）被 getRecord 读到时，
 *   即时合成 1 个历史批次返回 schemaVersion=2 + batches=[该批]；旧 content_md 列保留不删（回滚保险）、
 *   不强制只读时回写（下次压缩 appendBatch 自然回写）。
 *
 * step 口径全程对齐「不含 tool」（RecordBatch.stepStart/stepEnd / agentLoop requestHistory /
 * clampToBatch keptSteps），任一漂移会导致批次边界与回溯保留错位。
 *
 * 数据访问统一走 platform 抽象：Electron 落 SQLite records 表，Web 落 localStorage。
 */

import { platform } from '@/platform';

/** 当前 record schema 版本：2 = 多批次架构 */
export const RECORD_SCHEMA_VERSION = 2;

/**
 * 单个 record 批次：一次压缩浓缩出的【独立完整过程日志】。
 * 批次有序排列，压缩只 append 末尾、已有批次永不重写。
 */
export interface RecordBatch {
  /** 批次序号（从 0 起，连续递增） */
  index: number;
  /** 本批覆盖的用户轮次起点（含，1 起） */
  roundStart: number;
  /** 本批覆盖的用户轮次终点（含） */
  roundEnd: number;
  /** 本批覆盖的步骤起点（不含 tool，对齐 agentLoop requestHistory 口径；= 上一批 stepEnd） */
  stepStart: number;
  /** 本批覆盖的步骤终点（不含 tool；= stepStart + 本批参与消息条数） */
  stepEnd: number;
  /** 本批独立完整过程日志（markdown） */
  contentMd: string;
  /** 本批骨架（正则从 contentMd 提取：## 标题 + 每节首行要点），渐进式读降级用 */
  skeleton: string;
  /** 模板小节数概览信号（弱语义，正常 0） */
  phases: number;
  /** 本批时间跨度 "YYYY-MM-DD HH:mm ~ YYYY-MM-DD HH:mm"（可空字符串） */
  timeSpan: string;
  /** 本批创建时间（秒级 Unix 时间戳，与全库统一单位） */
  createdAt: number;
}

/** record 数据模型（多批次架构，运行态 / 持久化对等结构，camelCase） */
export interface SynapseRecord {
  /** 对话 ID（主键） */
  conversationId: string;
  /** 有序批次列表，压缩只 append 末尾、已有永不重写 */
  batches: RecordBatch[];
  /** 派生水位：覆盖到的总轮次（= 末批 roundEnd） */
  totalRounds: number;
  /** 派生水位：覆盖到的总步骤（不含 tool，= 末批 stepEnd） */
  totalSteps: number;
  /** 派生水位：已覆盖到第几轮（= 末批 roundEnd），增量压缩水位线 */
  lastUpdatedRound: number;
  /** 派生：整段时间跨度（首批起 ~ 末批止） */
  timeSpan: string;
  /** schema 版本（2 = 多批次） */
  schemaVersion: number;
  /** 最近一次写入时间（秒级 Unix 时间戳） */
  updatedAt: number;
  /**
   * 派生只读字段：各批 contentMd 拼接的全文。
   * ★ 不再是真相源——仅为兼容旧调用方/调试保留；真相源是 batches[]。
   */
  contentMd: string;
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** 各批 contentMd 拼接成派生全文（批次间用分隔线） */
const BATCH_JOIN = '\n\n---\n\n';

function joinBatchContents(batches: RecordBatch[]): string {
  return batches.map(b => b.contentMd).filter(Boolean).join(BATCH_JOIN);
}

/** 解析 "start ~ end" 跨度字符串两端 */
function splitSpan(span?: string): [string, string] {
  if (!span) return ['', ''];
  const idx = span.indexOf('~');
  if (idx < 0) return [span.trim(), span.trim()];
  return [span.slice(0, idx).trim(), span.slice(idx + 1).trim()];
}

/** 把多批 timeSpan 合并成整段跨度：起点取首个非空 start、终点取最后非空 end */
function deriveTimeSpan(batches: RecordBatch[]): string {
  const starts: string[] = [];
  const ends: string[] = [];
  for (const b of batches) {
    const [s, e] = splitSpan(b.timeSpan);
    if (s) starts.push(s);
    if (e) ends.push(e);
  }
  const start = starts.length ? starts.reduce((a, b) => (a <= b ? a : b)) : '';
  const end = ends.length ? ends.reduce((a, b) => (a >= b ? a : b)) : '';
  if (!start && !end) return '';
  return start && end ? `${start} ~ ${end}` : start || end;
}

/**
 * 从 contentMd 本地正则提取骨架：保留每个 `## 二级标题` + 该节首行要点（零成本，不调 LLM）。
 * 用于渐进式读把中段批次降级为骨架，控制注入膨胀。
 */
export function extractSkeleton(contentMd: string): string {
  if (!contentMd || !contentMd.trim()) return '';
  const lines = contentMd.split(/\r?\n/);
  const out: string[] = [];
  // 保留一级标题（# 对话过程日志 等）作为骨架头
  for (const line of lines) {
    if (/^#\s+/.test(line)) { out.push(line.trim()); break; }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      out.push(line.trim());
      // 找该节首行非空要点
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (/^#{1,6}\s+/.test(next)) break; // 到下一个标题止
        if (next.trim()) { out.push(`  ${next.trim()}`); break; }
      }
    }
  }
  return out.join('\n').trim();
}

/** upsert 入参：整条覆盖（底层写，含 batches） */
export interface RecordUpsertInput {
  conversationId: string;
  batches: RecordBatch[];
  /** 可选覆盖 schemaVersion，缺省 RECORD_SCHEMA_VERSION */
  schemaVersion?: number;
}

/** appendBatch 入参：本批生成结果（不含 index/stepStart——由 store 依据末批派生） */
export interface AppendBatchInput {
  conversationId: string;
  /** 本批步骤起点（不含 tool）——必须 == 末批 stepEnd（无批为 0），否则视脏写拒绝 */
  stepStart: number;
  /** 本批步骤终点（不含 tool） */
  stepEnd: number;
  /** 本批用户轮次起点（含） */
  roundStart: number;
  /** 本批用户轮次终点（含） */
  roundEnd: number;
  /** 本批独立完整过程日志 */
  contentMd: string;
  /** 本批骨架（缺省由 extractSkeleton 本地提取） */
  skeleton?: string;
  /** 模板小节数（弱语义，缺省 0） */
  phases?: number;
  /** 本批时间跨度（缺省空） */
  timeSpan?: string;
}

/** 把任意原始批次行规范成 RecordBatch */
function normalizeBatch(raw: unknown, fallbackIndex: number): RecordBatch | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const contentMd = String(b.contentMd ?? b.content_md ?? '');
  const skeleton = String(b.skeleton ?? '') || extractSkeleton(contentMd);
  return {
    index: toNumber(b.index, fallbackIndex),
    roundStart: toNumber(b.roundStart ?? b.round_start),
    roundEnd: toNumber(b.roundEnd ?? b.round_end),
    stepStart: toNumber(b.stepStart ?? b.step_start),
    stepEnd: toNumber(b.stepEnd ?? b.step_end),
    contentMd,
    skeleton,
    phases: toNumber(b.phases),
    timeSpan: String(b.timeSpan ?? b.time_span ?? ''),
    createdAt: toNumber(b.createdAt ?? b.created_at, nowSec()),
  };
}

/** 由 batches 派生出完整 SynapseRecord（统一水位/timeSpan/contentMd 派生口径） */
function buildRecord(
  conversationId: string,
  batches: RecordBatch[],
  updatedAt: number,
): SynapseRecord {
  const sorted = [...batches].sort((a, b) => a.index - b.index);
  const last = sorted[sorted.length - 1];
  return {
    conversationId,
    batches: sorted,
    totalRounds: last?.roundEnd ?? 0,
    totalSteps: last?.stepEnd ?? 0,
    lastUpdatedRound: last?.roundEnd ?? 0,
    timeSpan: deriveTimeSpan(sorted),
    schemaVersion: RECORD_SCHEMA_VERSION,
    updatedAt,
    contentMd: joinBatchContents(sorted),
  };
}

/**
 * 把 platform 返回的原始行规范成 SynapseRecord，并执行【懒迁移】。
 * - 已是 v2（有 batches_json / schemaVersion>=2）→ 直接解析 batches。
 * - 旧 v1（content_md 非空、无 batches）→ 即时合成 1 个历史批次 batch{index:0,
 *   roundStart:1, roundEnd:totalRounds, stepStart:0, stepEnd:totalSteps,
 *   contentMd:旧全文, skeleton:正则提取}，返回 schemaVersion=2。
 *   旧 content_md 列保留不删（回滚保险），不在读时强制回写。
 */
function normalizeRecord(raw: unknown): SynapseRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const conversationId = String(row.conversationId ?? row.conversation_id ?? '');
  if (!conversationId) return null;

  const updatedAt = toNumber(row.updatedAt ?? row.updated_at, nowSec());
  const schemaVersion = toNumber(row.schemaVersion ?? row.record_schema_version ?? row.schema_version, 1);

  // 解析批次：可能是 batches 数组（运行态/web）或 batches_json 字符串（SQLite 行）
  let rawBatches: unknown = row.batches;
  if (rawBatches === undefined && typeof row.batches_json === 'string') {
    try { rawBatches = JSON.parse(row.batches_json as string); } catch { rawBatches = null; }
  }

  if (Array.isArray(rawBatches) && rawBatches.length > 0) {
    const batches = rawBatches
      .map((b, i) => normalizeBatch(b, i))
      .filter((b): b is RecordBatch => b !== null);
    if (batches.length > 0) return buildRecord(conversationId, batches, updatedAt);
  }

  // —— 懒迁移：v1 单条 record → 合成 1 个历史批次 ——
  const legacyContent = String(row.contentMd ?? row.content_md ?? '');
  if (legacyContent.trim() && schemaVersion < RECORD_SCHEMA_VERSION) {
    const totalRounds = toNumber(row.totalRounds ?? row.total_rounds);
    const totalSteps = toNumber(row.totalSteps ?? row.total_steps);
    let phases = toNumber(row.phases);
    if (!Number.isFinite(phases) || phases < 0) phases = 0;
    const timeSpan = String(row.timeSpan ?? row.time_span ?? '');
    const historicalBatch: RecordBatch = {
      index: 0,
      roundStart: 1,
      roundEnd: totalRounds,
      stepStart: 0,
      stepEnd: totalSteps,
      contentMd: legacyContent,
      skeleton: extractSkeleton(legacyContent),
      phases,
      timeSpan,
      createdAt: updatedAt,
    };
    return buildRecord(conversationId, [historicalBatch], updatedAt);
  }

  // 无批次、无旧全文 → 空 record，视作不存在
  return null;
}

/**
 * 读取某对话的 record（含懒迁移）；不存在返回 null。
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
 * 写入 / 覆盖 record —— 纯持久化层（整条覆盖语义，含 batches）。
 * ★ 职责边界：本函数只做派生水位计算 + 落盘，不做内容生成/合并/追加语义。
 *   追加走 appendBatch、回溯裁剪走 clampToBatch。
 * 成功返回写入后的最新 record，失败返回 null（不抛）。
 */
export async function upsertRecord(input: RecordUpsertInput): Promise<SynapseRecord | null> {
  if (!input?.conversationId) return null;
  try {
    const batches = (input.batches ?? [])
      .map((b, i) => normalizeBatch(b, i))
      .filter((b): b is RecordBatch => b !== null)
      .sort((a, b) => a.index - b.index);
    if (batches.length === 0) {
      // 空批次 = 删除
      await deleteRecord(input.conversationId);
      return null;
    }
    const record = buildRecord(input.conversationId, batches, nowSec());
    await platform.conversation.saveRecord?.(toPersistShape(record));
    return record;
  } catch (err) {
    console.warn('[recordStore] upsertRecord failed:', err);
    return null;
  }
}

/** 落盘形状：携带 batches（运行态结构）+ 派生水位 + schemaVersion，platform 层各自序列化 */
function toPersistShape(record: SynapseRecord): Record<string, unknown> {
  return {
    conversationId: record.conversationId,
    batches: record.batches,
    contentMd: record.contentMd, // 派生只读，供旧 content_md 列回写（回滚保险）
    totalRounds: record.totalRounds,
    totalSteps: record.totalSteps,
    // phases 真相源 = 各 RecordBatch.phases；这里的全批求和【仅为派生只读统计】（兼容旧 phases_json 列 / 调试）。
    // ★ 读回时 normalizeRecord 一律从 batches[].phases 取每批值，绝不用本标量回填批次（标量无法拆回各批）。
    //   仅 v1 懒迁移（无 batches）分支才用它合成那 1 个历史批的 phases。
    phases: record.batches.reduce((s, b) => s + (b.phases || 0), 0),
    lastUpdatedRound: record.lastUpdatedRound,
    timeSpan: record.timeSpan,
    schemaVersion: record.schemaVersion,
    updatedAt: record.updatedAt,
  };
}

/**
 * 追加一个新批次到 record 末尾（压缩点调用）。
 * ★ 不变式：只追加末批、已有批次零改动零重写；幂等防脏写。
 *   - 幂等校验：本批 stepStart 必须 == 末批 stepEnd（无批则 0），否则视脏写拒绝（为 fallback 重入预留）。
 *   - index 由末批 index+1 派生（无批则 0），调用方不需关心。
 * 成功返回追加后的最新 record，校验失败/异常返回 null（不抛）。
 */
export async function appendBatch(input: AppendBatchInput): Promise<SynapseRecord | null> {
  if (!input?.conversationId) return null;
  try {
    const existing = await getRecord(input.conversationId);
    const prevBatches = existing?.batches ?? [];
    const lastBatch = prevBatches[prevBatches.length - 1];
    const expectedStepStart = lastBatch?.stepEnd ?? 0;

    // 幂等防脏写：本批起点必须严格接续末批终点
    if (input.stepStart !== expectedStepStart) {
      console.warn(
        `[recordStore] appendBatch 脏写拒绝：stepStart=${input.stepStart} != 末批 stepEnd=${expectedStepStart}`,
      );
      return existing; // 不破坏已有 record，原样返回
    }
    if (input.stepEnd <= input.stepStart) {
      console.warn('[recordStore] appendBatch 空批次（stepEnd<=stepStart），跳过');
      return existing;
    }

    const nextIndex = lastBatch ? lastBatch.index + 1 : 0;
    const contentMd = String(input.contentMd ?? '');
    const newBatch: RecordBatch = {
      index: nextIndex,
      roundStart: input.roundStart,
      roundEnd: input.roundEnd,
      stepStart: input.stepStart,
      stepEnd: input.stepEnd,
      contentMd,
      skeleton: input.skeleton?.trim() || extractSkeleton(contentMd),
      phases: input.phases ?? 0,
      timeSpan: input.timeSpan ?? '',
      createdAt: nowSec(),
    };
    const merged = [...prevBatches, newBatch];
    const record = buildRecord(input.conversationId, merged, nowSec());
    await platform.conversation.saveRecord?.(toPersistShape(record));
    return record;
  } catch (err) {
    console.warn('[recordStore] appendBatch failed:', err);
    return null;
  }
}

/**
 * 各批 skeleton 拼接（渐进式读 / generateBatch 喂「旧批骨架概览」用）。
 * 可选指定截止批次 index（不含），用于「本批之前的所有旧批骨架」。
 */
export async function getRecordSkeleton(
  conversationId: string,
  beforeIndex?: number,
): Promise<string> {
  const record = await getRecord(conversationId);
  if (!record) return '';
  const batches = typeof beforeIndex === 'number'
    ? record.batches.filter(b => b.index < beforeIndex)
    : record.batches;
  return batches.map(b => b.skeleton).filter(Boolean).join(BATCH_JOIN);
}

/**
 * 取某对话 record 中【单个批次的完整全文 contentMd】（record_read 工具后端 / 渐进式读按需展开）。
 * 渐进式读把中段批次降级为骨架注入；AI 需要细节时调 record_read(batchIndex) 经本函数取回该批全文。
 * - batchIndex 按 RecordBatch.index 匹配（从 0 起，连续递增）。
 * - 找不到对话 / 找不到该批 / 该批全文为空 → 返回 null（不抛）。
 * record 是加速层，任何底层异常一律吞掉返回 null，绝不能阻塞主对话。
 */
export async function getBatch(
  conversationId: string,
  batchIndex: number,
): Promise<string | null> {
  if (!conversationId || !Number.isFinite(batchIndex)) return null;
  try {
    const record = await getRecord(conversationId);
    if (!record || record.batches.length === 0) return null;
    const batch = record.batches.find(b => b.index === batchIndex);
    const content = batch?.contentMd?.trim();
    return content ? batch!.contentMd : null;
  } catch (err) {
    console.warn('[recordStore] getBatch failed:', err);
    return null;
  }
}

/**
 * 删除某对话的 record（对话删除 / rollback 完全失效时调用）。
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

/**
 * 回溯/编辑/重试截断后，把 record 按批次裁剪到保留范围（M2-R1 批次整体保留语义，替代旧 clampRecord 数字 clamp）。
 * - keptRounds：截断后剩余的用户轮次（只算 role==='user'）。
 * - keptSteps：截断后剩余的消息条数（**不含 tool 角色**，对齐 agentLoop requestHistory 口径）。
 *
 * 行为（批次整体保留，对齐 Plan_4 M2「回溯」算例）：
 *   - 截断基准【单一口径 = stepEnd】：找到「第一个 stepEnd > keptSteps」的批次（该批被截断点穿过），
 *     take 其之前的【连续前缀】整批保留、该批及之后整批丢弃（回退原文）。
 *     —— 用 findIndex + slice 取前缀（而非 filter 全数组），保证结果恒为连续前缀，
 *        即使脏数据导致批次 roundEnd 非单调也不会从中间挖空批次。
 *   - roundEnd 仅作 sanity（断言批次单调递增），不参与 kept 过滤，避免 step/round 两口径
 *     在不同批边界相交时多丢一批。
 *   - 末批 stepEnd <= keptSteps（保留范围覆盖全部批次）→ 不动。
 *   - 裁剪后无批次（keptSteps 落在首批之前）→ 删除 record。
 * record 是加速层，失败吞异常返回 null。
 */
export async function clampToBatch(
  conversationId: string,
  keptRounds: number,
  keptSteps: number,
): Promise<SynapseRecord | null> {
  if (!conversationId) return null;
  try {
    const record = await getRecord(conversationId);
    if (!record || record.batches.length === 0) return record;

    const safeSteps = Math.max(0, keptSteps);

    // 末批整个在保留范围内 → 无需动（单一 stepEnd 口径，与下方截断基准一致）
    const last = record.batches[record.batches.length - 1];
    if (last.stepEnd <= safeSteps) return record;

    // 单一口径找第一个被截断点穿过的批（stepEnd > keptSteps），take 其之前的连续前缀。
    const cutIdx = record.batches.findIndex(b => b.stepEnd > safeSteps);
    const kept = cutIdx < 0 ? record.batches : record.batches.slice(0, cutIdx);

    // sanity：keptRounds 与保留前缀末批 roundEnd 在正常单调数据下应一致（仅告警，不改裁剪结果）
    const safeRounds = Math.max(0, keptRounds);
    const keptLast = kept[kept.length - 1];
    if (keptLast && keptLast.roundEnd > safeRounds) {
      console.warn(
        `[recordStore] clampToBatch round/step 口径偏差：保留前缀末批 roundEnd=${keptLast.roundEnd} > keptRounds=${safeRounds}（以 stepEnd 为准，仅告警）`,
      );
    }

    if (kept.length === 0) {
      await deleteRecord(conversationId);
      return null;
    }
    // 重新派生水位落盘（批次本身零改动，仅截掉尾部若干批）
    return await upsertRecord({ conversationId, batches: kept });
  } catch (err) {
    console.warn('[recordStore] clampToBatch failed:', err);
    return null;
  }
}

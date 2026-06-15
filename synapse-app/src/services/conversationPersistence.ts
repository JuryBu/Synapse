import { platform } from '@/platform';
import type { AssistantRun, FileDiffSummary, FileSnapshot, Message } from '@/store/slices/conversation';
import {
  sanitizeMessagesForPersistence,
  releaseMessageAttachments,
  migrateMessagesAttachments,
  rollbackMigratedShas,
} from './attachmentRefs';

export const CONVERSATION_SCHEMA_VERSION = 1;
export const AUTOSAVE_ID = 'autosave-current';
const AUTOSAVE_KEY = 'synapse_autosave';
const LEGACY_CONVERSATIONS_KEY = 'synapse_conversations';
const LEGACY_CONVERSATION_METADATA_KEY = 'synapse:conversation:metadata';

export interface ConversationSummary {
  id: string;
  title: string;
  lastMessage: string;
  timestamp: number;
  messageCount: number;
  model: string;
  archived?: boolean;
  tags?: string[];
}

export interface ConversationSnapshot {
  id?: string | null;
  title?: string;
  model?: string;
  archived?: boolean;
  tags?: string[];
  messages: Message[];
  assistantRuns?: Record<string, AssistantRun>;
  fileSnapshots?: Record<string, FileSnapshot>;
  pendingDiffs?: FileDiffSummary[];
  timestamp?: number;
}

export interface ConversationListFilters {
  query?: string;
  archived?: 'all' | 'active' | 'archived';
  tags?: string[];
  limit?: number;
}

export interface ConversationExportBundle {
  version: number;
  exportedAt: string;
  filters?: ConversationListFilters;
  conversations: Array<{
    summary: ConversationSummary;
    snapshot: ConversationSnapshot | null;
  }>;
}

export function createConversationId(): string {
  return `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function saveAutosaveSnapshot(snapshot: ConversationSnapshot): Promise<void> {
  const id = snapshot.id || AUTOSAVE_ID;
  const timestamp = snapshot.timestamp ?? Date.now();
  // M2-R6：落库前剥掉任何残留 base64（持 sha256 引用即清内联 data:），localStorage / 平台两条路都净化。
  const sanitizedMessages = sanitizeMessagesForPersistence(snapshot.messages);
  const normalized = {
    ...snapshot,
    id,
    messages: sanitizedMessages,
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    timestamp,
  };

  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(normalized));
  } catch {
    // localStorage may be unavailable or full; Electron persistence below is still attempted.
  }

  const metadata = {
    title: snapshot.title || '自动保存',
    model: snapshot.model,
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    lastMessage: getLastMessageText(snapshot.messages),
    assistantRuns: snapshot.assistantRuns ?? {},
    fileSnapshots: snapshot.fileSnapshots ?? {},
    pendingDiffs: snapshot.pendingDiffs ?? [],
    archived: snapshot.archived,
    tags: snapshot.tags === undefined ? undefined : normalizeTags(snapshot.tags),
  };

  await persistPlatformSnapshot(id, metadata, sanitizedMessages);
}

export async function clearAutosaveSnapshot(): Promise<void> {
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    // Ignore unavailable localStorage.
  }
  await platform.conversation.delete(AUTOSAVE_ID).catch(() => false);
}

export async function loadAutosaveSnapshot(): Promise<ConversationSnapshot | null> {
  const fromPlatform = await loadPlatformSnapshot(AUTOSAVE_ID);
  if (fromPlatform?.messages.length) return fromPlatform;

  try {
    const saved = localStorage.getItem(AUTOSAVE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    if (Array.isArray(parsed.messages)) return parsed;
  } catch {
    return null;
  }
  return null;
}

export async function saveConversationSnapshot(snapshot: ConversationSnapshot): Promise<ConversationSummary | null> {
  if (!snapshot.messages.length) return null;
  const id = !snapshot.id || snapshot.id === AUTOSAVE_ID ? createConversationId() : snapshot.id;
  const title = snapshot.title || getFallbackTitle(snapshot.messages);
  const timestamp = snapshot.timestamp ?? Date.now();
  const metadata = {
    title,
    model: snapshot.model,
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    lastMessage: getLastMessageText(snapshot.messages),
    assistantRuns: snapshot.assistantRuns ?? {},
    fileSnapshots: snapshot.fileSnapshots ?? {},
    pendingDiffs: snapshot.pendingDiffs ?? [],
    archived: snapshot.archived,
    tags: snapshot.tags === undefined ? undefined : normalizeTags(snapshot.tags),
  };

  // M2-R6：正式保存同样落库去 base64。
  const sanitizedMessages = sanitizeMessagesForPersistence(snapshot.messages);
  await persistPlatformSnapshot(id, metadata, sanitizedMessages);
  writeLegacyConversation(id, sanitizedMessages);

  return {
    id,
    title,
    lastMessage: metadata.lastMessage,
    timestamp,
    messageCount: snapshot.messages.length,
    model: snapshot.model || 'unknown',
    archived: Boolean(snapshot.archived),
    tags: normalizeTags(snapshot.tags),
  };
}

export async function listConversationSummaries(filters: string | ConversationListFilters = ''): Promise<ConversationSummary[]> {
  const normalizedFilters = normalizeFilters(filters);
  const trimmed = normalizedFilters.query.trim();
  const platformRows = await (trimmed
    ? platform.conversation.search(trimmed, {
      archived: normalizedFilters.archived,
      tags: normalizedFilters.tags,
      limit: normalizedFilters.limit,
    })
    : platform.conversation.list({
      archived: normalizedFilters.archived,
      tags: normalizedFilters.tags,
      limit: normalizedFilters.limit,
    })).catch(() => []);
  const summaries = platformRows
    .map(mapConversationSummary)
    .filter((summary): summary is ConversationSummary => Boolean(summary))
    .filter(summary => summary.id !== AUTOSAVE_ID)
    .filter(summary => summary.messageCount > 0);

  const legacy = listLegacyConversationSummaries(normalizedFilters);
  const seen = new Set(summaries.map(summary => summary.id));
  for (const summary of legacy) {
    if (!seen.has(summary.id)) summaries.push(summary);
  }

  return summaries
    .filter(summary => matchesFilters(summary, normalizedFilters))
    .sort((a, b) => b.timestamp - a.timestamp);
}

export async function loadConversationSnapshot(id: string): Promise<ConversationSnapshot | null> {
  return await loadPlatformSnapshot(id) ?? loadLegacyConversationSnapshot(id);
}

export async function renameConversation(id: string, title: string): Promise<void> {
  await platform.conversation.update(id, { title }).catch(() => false);
  updateLegacyConversationMetadata(id, { title });
}

export async function deleteConversationSnapshot(id: string): Promise<void> {
  // M2-R6 refCount GC：删对话前先把它引用的附件 sha256 收齐，删后逐个 release（归零删实体）。
  // 删消息记录会丢失引用信息，故必须在 delete 之前读取。失败吞掉，不阻塞删除主流程。
  await releaseConversationAttachments(id);
  await platform.conversation.delete(id).catch(() => false);
  deleteLegacyConversation(id);
}

export async function deleteConversationSnapshots(ids: string[]): Promise<void> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (!uniqueIds.length) return;

  // M2-R6 refCount GC：批量删同样先收集再 release。
  await Promise.all(uniqueIds.map(id => releaseConversationAttachments(id)));

  if (platform.conversation.batchDelete) {
    await platform.conversation.batchDelete(uniqueIds).catch(async () => {
      await Promise.all(uniqueIds.map(id => platform.conversation.delete(id).catch(() => false)));
    });
  } else {
    await Promise.all(uniqueIds.map(id => platform.conversation.delete(id).catch(() => false)));
  }

  uniqueIds.forEach(deleteLegacyConversation);
}

/** 删对话前：读出其消息、收集附件 sha256 并 release（refCount-1，归零 GC）。失败静默。 */
async function releaseConversationAttachments(id: string): Promise<void> {
  try {
    const snapshot = await loadPlatformSnapshot(id) ?? loadLegacyConversationSnapshot(id);
    if (snapshot?.messages?.length) {
      await releaseMessageAttachments(snapshot.messages);
    }
  } catch {
    // GC 是加速/清理层，绝不阻塞删除主流程。
  }
}

/**
 * M2-R6 懒迁移入口：把一个 snapshot 里旧内联 base64 抽离成 sha256 引用，若有变更则回写 DB（按 id 持久化）。
 * 「用到才迁、不阻塞渲染」——调用方（AgentPanel / ConversationList）在 load 之后 fire-and-forget 调用，
 * 迁移成功后下次加载即引用态。
 *
 * onMigrated 回调（可选）：迁移确有变更时，把【迁移后的引用态 messages + 对话 id】交回调用方，
 * 由调用方决定是否安全地用其更新 store（需自行校验 store 当前对话未被切换/未追加新消息，再 dispatch）。
 * 不提供回调则仅回写 DB（store 保持旧 base64 态，下次加载即引用态）。
 *
 * 返回迁移后的 messages（changed=false 时即原 messages）。
 */
/**
 * 按 conversationId 的在途迁移锁（模块级 Map<id, Promise>）。
 * ★ Codex 中风险修复（并发迁移竞态）：AgentPanel 挂载迁 AUTOSAVE、ConversationList 切换迁目标对话，
 *   多入口/多窗口/重载下若对同一 DB 行（仍内联 base64）在首个迁移回写完成前重入，两路各 put 一遍 →
 *   refCount 翻倍，writeback 幂等只在【完成后】生效，竞态窗口内防不住。
 *   同 id 复用同一 in-flight 迁移 Promise，串行化首个迁移；后到的复用结果，不再重复 put。
 */
const inflightMigrations = new Map<string, Promise<Message[]>>();

export function migrateSnapshotAttachments(
  snapshot: ConversationSnapshot,
  onMigrated?: (id: string, messages: Message[]) => void,
): Promise<Message[]> {
  if (!snapshot?.messages?.length) return Promise.resolve(snapshot?.messages ?? []);
  const id = snapshot.id || AUTOSAVE_ID;
  const existing = inflightMigrations.get(id);
  if (existing) return existing;
  const task = runSnapshotMigration(id, snapshot, onMigrated)
    .finally(() => { inflightMigrations.delete(id); });
  inflightMigrations.set(id, task);
  return task;
}

async function runSnapshotMigration(
  id: string,
  snapshot: ConversationSnapshot,
  onMigrated?: (id: string, messages: Message[]) => void,
): Promise<Message[]> {
  const { messages, changed, newShas } = await migrateMessagesAttachments(snapshot.messages);
  if (!changed) return snapshot.messages;
  const refMessages = sanitizeMessagesForPersistence(messages);
  // 回写：仅替换消息体（已是引用态，sanitize 再兜一道），保持元数据不变。
  // ★ Codex 中风险②修复：必须把【所有读取来源】都回写成引用态，否则下次 load 仍读到旧 base64 →
  //   重复 put 抬高 ref_count 且永不清。来源含：平台 DB（loadPlatformSnapshot）、legacy map（loadLegacyConversationSnapshot）、
  //   AUTOSAVE_KEY localStorage 镜像。三者全覆盖才真正闭环（迁移幂等）。
  // ★ Codex 中风险修复（回写失败 → 重复 put）：迁移在回写前已 put 成功(refCount+1)。若回写抛错，
  //   DB 仍是旧内联态，下次 load 再次 hasInlineBase64 → 再 put → refCount 单调上涨、GC 永远追不平。
  //   故回写抛错时把本轮新增引用 newShas 逐个 release 回滚，并【不通知 onMigrated】（store 保持旧 base64 态，
  //   下次重迁会重新 put），使「put 与持有关系」严格守恒。
  try {
    const existing = await platform.conversation.get(id).catch(() => null);
    if (existing) {
      // 平台 DB 有行：replaceMessages 覆盖即闭环（下次 loadPlatformSnapshot 优先返回引用态）。
      await platform.conversation.replaceMessages(id, refMessages.map(message => ({
        ...message,
        conversationId: id,
      })));
      // 顺带清理同 id 的 legacy 残留（若存在），避免它日后又被当旧数据读出。
      if (id in readLegacyConversationMap()) writeLegacyConversation(id, refMessages);
    } else if (id in readLegacyConversationMap()) {
      // 纯 legacy 对话（平台 DB 无行、仅 synapse_conversations map 有）：必须回写 legacy map，
      // 否则每次打开都重新 put、ref_count 暴涨且 base64 永留。覆盖为引用态后下次不再迁移。
      writeLegacyConversation(id, refMessages);
    } else {
      // 平台 DB 与 legacy 均无该 id 的行：无处可回写，下次 load 仍会读到旧 base64 重迁 →
      // 与「回写失败」同源，回滚本轮引用避免 refCount 漂移。
      await rollbackMigratedShas(newShas);
      return snapshot.messages;
    }
    // 同步 localStorage 自动保存镜像（若当前就是 autosave）。
    if (id === AUTOSAVE_ID) {
      try {
        const saved = localStorage.getItem(AUTOSAVE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved);
          parsed.messages = refMessages;
          localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(parsed));
        }
      } catch { /* localStorage 不可用则跳过 */ }
    }
  } catch {
    // 回写失败：回滚本轮新增引用，保持 DB 旧内联态（下次再迁），不通知 onMigrated。
    await rollbackMigratedShas(newShas);
    return snapshot.messages;
  }
  // 回写成功后通知调用方（让其把 store 也修正成引用态，杜绝 store 残留 base64 反复被 autosave 写回）。
  try {
    onMigrated?.(id, messages);
  } catch {
    // 回调异常不影响迁移结果。
  }
  return messages;
}

export async function updateConversationMetadata(
  id: string,
  metadata: { title?: string; archived?: boolean; tags?: string[] },
): Promise<void> {
  const normalized = normalizeMetadataPatch(metadata);
  await platform.conversation.update(id, normalized).catch(() => false);
  updateLegacyConversationMetadata(id, normalized);
}

export async function updateConversationsMetadata(
  ids: string[],
  metadata: { archived?: boolean; tags?: string[] },
): Promise<void> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (!uniqueIds.length) return;
  const normalized = normalizeMetadataPatch(metadata);

  if (platform.conversation.batchUpdate) {
    await platform.conversation.batchUpdate(uniqueIds, normalized).catch(async () => {
      await Promise.all(uniqueIds.map(id => platform.conversation.update(id, normalized).catch(() => false)));
    });
  } else {
    await Promise.all(uniqueIds.map(id => platform.conversation.update(id, normalized).catch(() => false)));
  }

  uniqueIds.forEach(id => updateLegacyConversationMetadata(id, normalized));
}

export async function exportConversationSnapshot(id: string): Promise<ConversationSnapshot | null> {
  return loadConversationSnapshot(id);
}

export async function exportConversationSnapshots(
  ids: string[],
  filters?: ConversationListFilters,
): Promise<ConversationExportBundle> {
  const wanted = new Set(ids);
  const summaries = (await listConversationSummaries({ ...(filters ?? {}), archived: filters?.archived ?? 'all' }))
    .filter(summary => wanted.has(summary.id));
  const conversations = await Promise.all(summaries.map(async summary => ({
    summary,
    snapshot: await exportConversationSnapshot(summary.id),
  })));

  return {
    version: CONVERSATION_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    filters,
    conversations,
  };
}

async function loadPlatformSnapshot(id: string): Promise<ConversationSnapshot | null> {
  try {
    const conversation = await platform.conversation.get(id);
    if (!conversation) return null;
    const messages = await platform.conversation.listMessages(id);
    return {
      id,
      title: conversation.title,
      model: conversation.model,
      archived: Boolean(conversation.archived),
      tags: normalizeTags(conversation.tags),
      messages: messages as Message[],
      assistantRuns: conversation.assistantRuns ?? {},
      fileSnapshots: conversation.fileSnapshots ?? {},
      pendingDiffs: conversation.pendingDiffs ?? [],
      timestamp: normalizeTimestamp(conversation.updatedAt ?? conversation.timestamp),
    };
  } catch {
    return null;
  }
}

async function persistPlatformSnapshot(
  id: string,
  metadata: {
    title: string;
    model?: string;
    schemaVersion: number;
    lastMessage: string;
    assistantRuns: Record<string, AssistantRun>;
    fileSnapshots: Record<string, FileSnapshot>;
    pendingDiffs: FileDiffSummary[];
    archived?: boolean;
    tags?: string[];
  },
  messages: Message[],
): Promise<void> {
  const existing = await platform.conversation.get(id).catch(() => null);
  let createdNew = false;
  // M2-R6 终极防线：所有平台落库都从这里走，内部再 sanitize 一道（幂等），
  // 即便上游漏调 sanitizeMessagesForPersistence 也保证 DB 绝不含 base64。
  const safeMessages = sanitizeMessagesForPersistence(messages);
  try {
    if (existing) {
      await platform.conversation.update(id, metadata);
    } else {
      await platform.conversation.create({ id, ...metadata });
      createdNew = true;
    }

    await platform.conversation.replaceMessages(id, safeMessages.map(message => ({
      ...message,
      conversationId: id,
    })));
  } catch (error) {
    if (createdNew) await platform.conversation.delete(id).catch(() => false);
    throw error;
  }
}

function mapConversationSummary(row: any): ConversationSummary | null {
  if (!row?.id) return null;
  return {
    id: row.id,
    title: row.title || '新对话',
    lastMessage: row.lastMessage || row.last_message || '',
    timestamp: normalizeTimestamp(row.updatedAt ?? row.timestamp ?? row.createdAt),
    messageCount: Number(row.messageCount ?? row.message_count ?? 0),
    model: row.model || 'unknown',
    archived: Boolean(row.archived),
    tags: normalizeTags(row.tags),
  };
}

function normalizeTimestamp(value: unknown): number {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return Date.now();
  return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

function getLastMessageText(messages: Message[]): string {
  const last = messages[messages.length - 1];
  return last?.content?.slice(0, 200) ?? '';
}

function getFallbackTitle(messages: Message[]): string {
  const firstUser = messages.find(message => message.role === 'user')?.content?.trim();
  if (!firstUser) return '新对话';
  return firstUser.slice(0, 30) + (firstUser.length > 30 ? '...' : '');
}

function readLegacyConversationMap(): Record<string, Message[]> {
  try {
    return JSON.parse(localStorage.getItem(LEGACY_CONVERSATIONS_KEY) || '{}');
  } catch {
    return {};
  }
}

function readLegacyConversationMetadata(): Record<string, Partial<ConversationSummary>> {
  try {
    return JSON.parse(localStorage.getItem(LEGACY_CONVERSATION_METADATA_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeLegacyConversationMetadata(metadata: Record<string, Partial<ConversationSummary>>): void {
  try {
    localStorage.setItem(LEGACY_CONVERSATION_METADATA_KEY, JSON.stringify(metadata));
  } catch {
    // Ignore unavailable localStorage.
  }
}

function writeLegacyConversation(id: string, messages: Message[]): void {
  try {
    const stored = readLegacyConversationMap();
    stored[id] = messages;
    localStorage.setItem(LEGACY_CONVERSATIONS_KEY, JSON.stringify(stored));
  } catch {
    // Legacy compatibility is best-effort; platform persistence is primary.
  }
}

function deleteLegacyConversation(id: string): void {
  try {
    const stored = readLegacyConversationMap();
    delete stored[id];
    localStorage.setItem(LEGACY_CONVERSATIONS_KEY, JSON.stringify(stored));
    const metadata = readLegacyConversationMetadata();
    delete metadata[id];
    writeLegacyConversationMetadata(metadata);
  } catch {
    // Ignore unavailable localStorage.
  }
}

function updateLegacyConversationMetadata(id: string, patch: Partial<ConversationSummary>): void {
  const metadata = readLegacyConversationMetadata();
  const current = metadata[id] ?? {};
  metadata[id] = {
    ...current,
    ...patch,
    tags: patch.tags === undefined ? current.tags : normalizeTags(patch.tags),
  };
  writeLegacyConversationMetadata(metadata);
}

function loadLegacyConversationSnapshot(id: string): ConversationSnapshot | null {
  const messages = readLegacyConversationMap()[id];
  if (!Array.isArray(messages)) return null;
  const metadata = readLegacyConversationMetadata()[id] ?? {};
  return {
    id,
    title: metadata.title || getFallbackTitle(messages),
    archived: Boolean(metadata.archived),
    tags: normalizeTags(metadata.tags),
    messages,
    timestamp: Date.now(),
  };
}

function listLegacyConversationSummaries(filters: ConversationListFilters): ConversationSummary[] {
  const lowerQuery = filters.query?.toLowerCase() ?? '';
  const metadata = readLegacyConversationMetadata();
  return Object.entries(readLegacyConversationMap())
    .filter(([, messages]) => Array.isArray(messages))
    .map(([id, messages]) => {
      const meta = metadata[id] ?? {};
      const title = meta.title || getFallbackTitle(messages);
      const lastMessage = getLastMessageText(messages);
      return {
        id,
        title,
        lastMessage,
        timestamp: Math.max(...messages.map(message => Number(message.timestamp) || 0), 0) || Date.now(),
        messageCount: messages.length,
        model: messages.find(message => message.model)?.model || 'unknown',
        archived: Boolean(meta.archived),
        tags: normalizeTags(meta.tags),
      };
    })
    .filter(summary => {
      if (!lowerQuery) return true;
      const messages = readLegacyConversationMap()[summary.id] ?? [];
      return [summary.title, summary.lastMessage, summary.model, ...(summary.tags ?? []), ...messages.map(message => message.content)]
        .join('\n')
        .toLowerCase()
        .includes(lowerQuery);
    })
    .filter(summary => matchesFilters(summary, filters));
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags
    .map(tag => String(tag).trim())
    .filter(Boolean))]
    .slice(0, 12);
}

function normalizeFilters(filters: string | ConversationListFilters): ConversationListFilters & {
  query: string;
  archived: 'all' | 'active' | 'archived';
  tags: string[];
  limit: number;
} {
  if (typeof filters === 'string') {
    return { query: filters, archived: 'active', tags: [], limit: 100 };
  }
  return {
    query: filters.query ?? '',
    archived: filters.archived ?? 'active',
    tags: normalizeTags(filters.tags),
    limit: filters.limit ?? 100,
  };
}

function normalizeMetadataPatch<T extends { tags?: string[] }>(patch: T): T {
  if (patch.tags === undefined) return patch;
  return { ...patch, tags: normalizeTags(patch.tags) };
}

function matchesFilters(summary: ConversationSummary, filters: ConversationListFilters): boolean {
  const archivedFilter = filters.archived ?? 'active';
  if (archivedFilter === 'active' && summary.archived) return false;
  if (archivedFilter === 'archived' && !summary.archived) return false;
  const requiredTags = normalizeTags(filters.tags);
  if (requiredTags.length) {
    const summaryTags = new Set(normalizeTags(summary.tags).map(tag => tag.toLowerCase()));
    if (!requiredTags.every(tag => summaryTags.has(tag.toLowerCase()))) return false;
  }
  return true;
}

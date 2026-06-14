import { platform } from '@/platform';
import type { AssistantRun, FileDiffSummary, FileSnapshot, Message } from '@/store/slices/conversation';

export const CONVERSATION_SCHEMA_VERSION = 1;
const AUTOSAVE_ID = 'autosave-current';
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
  const normalized = {
    ...snapshot,
    id,
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

  await persistPlatformSnapshot(id, metadata, snapshot.messages);
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

  await persistPlatformSnapshot(id, metadata, snapshot.messages);
  writeLegacyConversation(id, snapshot.messages);

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
  await platform.conversation.delete(id).catch(() => false);
  deleteLegacyConversation(id);
}

export async function deleteConversationSnapshots(ids: string[]): Promise<void> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (!uniqueIds.length) return;

  if (platform.conversation.batchDelete) {
    await platform.conversation.batchDelete(uniqueIds).catch(async () => {
      await Promise.all(uniqueIds.map(id => platform.conversation.delete(id).catch(() => false)));
    });
  } else {
    await Promise.all(uniqueIds.map(id => platform.conversation.delete(id).catch(() => false)));
  }

  uniqueIds.forEach(deleteLegacyConversation);
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
  try {
    if (existing) {
      await platform.conversation.update(id, metadata);
    } else {
      await platform.conversation.create({ id, ...metadata });
      createdNew = true;
    }

    await platform.conversation.replaceMessages(id, messages.map(message => ({
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

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' }; attachmentId?: string }
  | { type: 'file'; file: { filename: string; mimeType?: string; data?: string; url?: string }; attachmentId?: string };

export interface AttachmentRef {
  id: string;
  name: string;
  path?: string;
  mimeType?: string;
  size?: number;
  kind: 'image' | 'document' | 'text' | 'archive' | 'other';
  previewUrl?: string;
  payloadUrl?: string;
  status: 'pending' | 'ready' | 'error' | 'sent';
  error?: string;
}

export interface ThinkingBlock {
  content: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  collapsed?: boolean;
  status: 'pending' | 'streaming' | 'complete' | 'error';
}

export type StreamState = 'idle' | 'pending' | 'streaming' | 'complete' | 'error' | 'aborted';
export type StreamModeUsed = 'real' | 'pseudo' | 'off';

export interface FileDiffSummary {
  id: string;
  path: string;
  changeType: 'created' | 'edited' | 'deleted';
  additions: number;
  deletions: number;
  status: 'pending' | 'accepted' | 'rejected' | 'mixed' | 'superseded';
  snapshotId?: string;
  beforeHash?: string;
  afterHash?: string;
  hunks?: FileDiffHunk[];
}

export interface FileDiffHunk {
  id?: string;
  status?: 'pending' | 'accepted' | 'rejected' | 'mixed';
  oldStart: number;
  newStart: number;
  oldLines: number;
  newLines: number;
  blocks?: FileDiffBlock[];
  lines: Array<{
    type: 'context' | 'add' | 'delete';
    content: string;
    oldLine?: number;
    newLine?: number;
  }>;
}

export interface FileDiffBlock {
  id?: string;
  status?: 'pending' | 'accepted' | 'rejected';
  oldStart: number;
  newStart: number;
  oldLines: number;
  newLines: number;
  lineStart: number;
  lineEnd: number;
  lines: FileDiffHunk['lines'];
}

export interface AssistantRunEvent {
  id: string;
  runId: string;
  messageId?: string;
  type: 'started' | 'stream_mode' | 'content_delta' | 'thinking_delta' | 'tool_call' | 'file_change' | 'done' | 'error' | 'aborted';
  timestamp: number;
  content?: string;
  toolCallId?: string;
  diffId?: string;
  error?: string;
  streamMode?: StreamModeUsed;
  fallbackReason?: string;
}

export interface AssistantRun {
  id: string;
  messageId?: string;
  startedAt: number;
  endedAt?: number;
  model?: string;
  status: StreamState;
  streamMode?: StreamModeUsed;
  fallbackReason?: string;
  events: AssistantRunEvent[];
}

export interface FileSnapshot {
  id: string;
  path: string;
  contentHash?: string;
  content?: string;
  createdAt: number;
  reason: 'before_ai_edit' | 'manual_checkpoint' | 'rollback';
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  contentParts?: MessageContentPart[];
  attachments?: AttachmentRef[];
  thinking?: ThinkingBlock;
  timestamp: number;
  model?: string;
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
  streamState?: StreamState;
  streamMode?: StreamModeUsed;
  fallbackReason?: string;
  showStreamCursor?: boolean;
  showGeneratingPlaceholder?: boolean;
  durationMs?: number;
  runId?: string;
  runEvents?: AssistantRunEvent[];
  diffs?: FileDiffSummary[];
  rollbackSnapshotId?: string;
  error?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  status: 'pending' | 'running' | 'success' | 'error';
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  updatedAt: number;
}

interface ConversationState {
  schemaVersion: number;
  id: string | null;
  title: string;
  messages: Message[];
  assistantRuns: Record<string, AssistantRun>;
  fileSnapshots: Record<string, FileSnapshot>;
  pendingDiffs: FileDiffSummary[];
  isStreaming: boolean;
  streamingContent: string;
  model: string;
  tokenCount: number;
  tokenUsage: TokenUsage | null;
  pendingMessage: string;
}

const CONVERSATION_SCHEMA_VERSION = 1;

function textToContentParts(content: string): MessageContentPart[] {
  return content ? [{ type: 'text', text: content }] : [];
}

function normalizeMessage(message: Message): Message {
  const content = message.content ?? '';
  const contentParts = Array.isArray(message.contentParts)
    ? message.contentParts
    : textToContentParts(content);
  return {
    ...message,
    content,
    contentParts,
    streamState: message.streamState ?? (message.isStreaming ? 'streaming' : undefined),
  };
}

function buildInlineBlocks(hunk: FileDiffHunk, hunkId: string): FileDiffBlock[] {
  const blocks: FileDiffBlock[] = [];
  let startIndex: number | null = null;

  const flush = (endIndex: number) => {
    if (startIndex === null) return;
    const lines = hunk.lines.slice(startIndex, endIndex + 1);
    const oldNumbers = lines.map(line => line.oldLine).filter((line): line is number => line !== undefined);
    const newNumbers = lines.map(line => line.newLine).filter((line): line is number => line !== undefined);
    blocks.push({
      id: `${hunkId}:block:${blocks.length}_${oldNumbers[0] ?? 0}_${newNumbers[0] ?? 0}`,
      status: 'pending',
      oldStart: oldNumbers[0] ?? 0,
      newStart: newNumbers[0] ?? 0,
      oldLines: oldNumbers.length,
      newLines: newNumbers.length,
      lineStart: startIndex,
      lineEnd: endIndex,
      lines,
    });
    startIndex = null;
  };

  hunk.lines.forEach((line, index) => {
    if (line.type === 'context') {
      flush(index - 1);
      return;
    }
    if (startIndex === null) startIndex = index;
  });
  flush(hunk.lines.length - 1);
  return blocks;
}

function normalizeHunk(diffId: string, hunk: FileDiffHunk, index: number): FileDiffHunk {
  const hunkId = hunk.id ?? `${diffId}:hunk:${index}`;
  const defaultBlockStatus = hunk.status === 'accepted' || hunk.status === 'rejected' ? hunk.status : 'pending';
  const blocks = (hunk.blocks && hunk.blocks.length > 0 ? hunk.blocks : buildInlineBlocks(hunk, hunkId)).map((block, blockIndex) => ({
    ...block,
    id: block.id ?? `${hunkId}:block:${blockIndex}_${block.oldStart ?? 0}_${block.newStart ?? 0}`,
    status: block.status ?? defaultBlockStatus,
  }));
  const normalized = {
    ...hunk,
    id: hunkId,
    status: hunk.status ?? 'pending',
    blocks,
  };
  return { ...normalized, status: summarizeBlockStatus(normalized) };
}

function normalizeDiff(diff: FileDiffSummary): FileDiffSummary {
  const normalized = {
    ...diff,
    hunks: diff.hunks?.map((hunk, index) => normalizeHunk(diff.id, hunk, index)),
  };
  return { ...normalized, status: summarizeDiffStatus(normalized) };
}

function summarizeBlockStatus(hunk: FileDiffHunk): NonNullable<FileDiffHunk['status']> {
  const blocks = hunk.blocks ?? [];
  if (blocks.length === 0) return hunk.status ?? 'pending';
  if (blocks.every(block => block.status === 'accepted')) return 'accepted';
  if (blocks.every(block => block.status === 'rejected')) return 'rejected';
  if (blocks.some(block => !block.status || block.status === 'pending')) return 'pending';
  return 'mixed';
}

function summarizeDiffStatus(diff: FileDiffSummary): FileDiffSummary['status'] {
  const hunks = diff.hunks ?? [];
  if (hunks.length === 0) return diff.status;
  if (hunks.every(hunk => hunk.status === 'accepted')) return 'accepted';
  if (hunks.every(hunk => hunk.status === 'rejected')) return 'rejected';
  if (hunks.some(hunk => !hunk.status || hunk.status === 'pending')) return 'pending';
  return 'mixed';
}

const initialState: ConversationState = {
  schemaVersion: CONVERSATION_SCHEMA_VERSION,
  id: null,
  title: '新对话',
  messages: [],
  assistantRuns: {},
  fileSnapshots: {},
  pendingDiffs: [],
  isStreaming: false,
  streamingContent: '',
  model: '',
  tokenCount: 0,
  tokenUsage: null,
  pendingMessage: '',
};

export const conversationSlice = createSlice({
  name: 'conversation',
  initialState,
  reducers: {
    setConversation(state, action: PayloadAction<{
      id: string;
      title: string;
      messages: Message[];
      assistantRuns?: Record<string, AssistantRun>;
      fileSnapshots?: Record<string, FileSnapshot>;
      pendingDiffs?: FileDiffSummary[];
      model?: string;
    }>) {
      state.schemaVersion = CONVERSATION_SCHEMA_VERSION;
      state.id = action.payload.id;
      state.title = action.payload.title;
      state.messages = action.payload.messages.map(normalizeMessage);
      state.assistantRuns = action.payload.assistantRuns ?? {};
      state.fileSnapshots = action.payload.fileSnapshots ?? {};
      state.pendingDiffs = (action.payload.pendingDiffs ?? []).map(normalizeDiff);
      state.model = action.payload.model ?? state.model;
    },
    addMessage(state, action: PayloadAction<Message>) {
      state.messages.push(normalizeMessage(action.payload));
    },
    updateMessage(state, action: PayloadAction<{ id: string; content: string; contentParts?: MessageContentPart[] }>) {
      const msg = state.messages.find(m => m.id === action.payload.id);
      if (msg) {
        msg.content = action.payload.content;
        msg.contentParts = action.payload.contentParts ?? textToContentParts(action.payload.content);
      }
    },
    updateMessageMeta(state, action: PayloadAction<{ id: string; changes: Partial<Message> }>) {
      const msg = state.messages.find(m => m.id === action.payload.id);
      if (msg) Object.assign(msg, action.payload.changes);
    },
    appendMessageContent(state, action: PayloadAction<{ id: string; content: string }>) {
      const msg = state.messages.find(m => m.id === action.payload.id);
      if (msg) {
        msg.content += action.payload.content;
        const parts = msg.contentParts ?? [];
        const last = parts[parts.length - 1];
        if (last?.type === 'text') {
          last.text += action.payload.content;
        } else {
          parts.push({ type: 'text', text: action.payload.content });
        }
        msg.contentParts = parts;
      }
    },
    setMessageAttachments(state, action: PayloadAction<{ id: string; attachments: AttachmentRef[] }>) {
      const msg = state.messages.find(m => m.id === action.payload.id);
      if (msg) msg.attachments = action.payload.attachments;
    },
    appendMessageThinking(state, action: PayloadAction<{ id: string; content: string; status?: ThinkingBlock['status'] }>) {
      const msg = state.messages.find(m => m.id === action.payload.id);
      if (msg) {
        msg.thinking = {
          content: `${msg.thinking?.content ?? ''}${action.payload.content}`,
          startedAt: msg.thinking?.startedAt ?? Date.now(),
          collapsed: msg.thinking?.collapsed ?? true,
          status: action.payload.status ?? 'streaming',
        };
      }
    },
    setMessageStreamState(state, action: PayloadAction<{ id: string; streamState: StreamState; durationMs?: number; error?: string; streamMode?: StreamModeUsed; fallbackReason?: string }>) {
      const msg = state.messages.find(m => m.id === action.payload.id);
      if (msg) {
        msg.streamState = action.payload.streamState;
        msg.isStreaming = action.payload.streamState === 'streaming' || action.payload.streamState === 'pending';
        if (action.payload.durationMs !== undefined) msg.durationMs = action.payload.durationMs;
        if (action.payload.error !== undefined) msg.error = action.payload.error;
        if (action.payload.streamMode !== undefined) msg.streamMode = action.payload.streamMode;
        if (action.payload.fallbackReason !== undefined) msg.fallbackReason = action.payload.fallbackReason;
      }
    },
    addMessageDiff(state, action: PayloadAction<{ messageId: string; diff: FileDiffSummary }>) {
      const msg = state.messages.find(m => m.id === action.payload.messageId);
      if (msg) {
        msg.diffs = [...(msg.diffs ?? []), normalizeDiff(action.payload.diff)];
      }
      state.pendingDiffs.push(normalizeDiff(action.payload.diff));
    },
    updateDiffStatus(state, action: PayloadAction<{ diffId: string; status: FileDiffSummary['status'] }>) {
      const applyStatus = (diff: FileDiffSummary): FileDiffSummary => {
        if (diff.id !== action.payload.diffId) return diff;
        if (action.payload.status !== 'accepted' && action.payload.status !== 'rejected') {
          return { ...diff, status: action.payload.status };
        }
        const hunkStatus = action.payload.status;
        const hunks = diff.hunks?.map((hunk, index) => {
          const normalized = normalizeHunk(diff.id, hunk, index);
          const blocks = normalized.blocks?.map(block => {
            const currentStatus = block.status ?? 'pending';
            return currentStatus === 'pending' ? { ...block, status: hunkStatus } : block;
          });
          const nextHunk = { ...normalized, blocks };
          return { ...nextHunk, status: summarizeBlockStatus(nextHunk) };
        });
        const next = { ...diff, hunks };
        return {
          ...next,
          status: summarizeDiffStatus(next),
        };
      };
      state.pendingDiffs = state.pendingDiffs.map(applyStatus);
      for (const msg of state.messages) {
        if (!msg.diffs) continue;
        msg.diffs = msg.diffs.map(applyStatus);
      }
    },
    updateHunkStatus(state, action: PayloadAction<{ diffId: string; hunkId: string; status: NonNullable<FileDiffBlock['status']> }>) {
      const apply = (diff: FileDiffSummary): FileDiffSummary => {
        if (diff.id !== action.payload.diffId || !diff.hunks) return diff;
        const next = {
          ...diff,
          hunks: diff.hunks.map((hunk, index) => {
            const id = hunk.id ?? `${diff.id}:hunk:${index}`;
            return id === action.payload.hunkId
              ? {
                ...hunk,
                id,
                blocks: hunk.blocks?.map((block, blockIndex) => ({
                  ...block,
                  id: block.id ?? `${id}:block:${blockIndex}_${block.oldStart ?? 0}_${block.newStart ?? 0}`,
                  status: (block.status ?? 'pending') === 'pending' ? action.payload.status : block.status,
                })),
              }
              : normalizeHunk(diff.id, { ...hunk, id }, index);
          }),
        };
        const normalizedNext = {
          ...next,
          hunks: next.hunks?.map((hunk) => ({ ...hunk, status: summarizeBlockStatus(hunk) })),
        };
        return { ...normalizedNext, status: summarizeDiffStatus(normalizedNext) };
      };

      state.pendingDiffs = state.pendingDiffs.map(apply);
      for (const msg of state.messages) {
        if (!msg.diffs) continue;
        msg.diffs = msg.diffs.map(apply);
      }
    },
    updateDiffBlockStatus(state, action: PayloadAction<{ diffId: string; hunkId: string; blockId: string; status: NonNullable<FileDiffBlock['status']> }>) {
      const apply = (diff: FileDiffSummary): FileDiffSummary => {
        if (diff.id !== action.payload.diffId || !diff.hunks) return diff;
        const next = {
          ...diff,
          hunks: diff.hunks.map((rawHunk, hunkIndex) => {
            const hunk = normalizeHunk(diff.id, rawHunk, hunkIndex);
            if (hunk.id !== action.payload.hunkId) return hunk;
            const blocks = hunk.blocks?.map((block, blockIndex) => {
              const id = block.id ?? `${hunk.id}:block:${blockIndex}_${block.oldStart ?? 0}_${block.newStart ?? 0}`;
              return id === action.payload.blockId ? { ...block, id, status: action.payload.status } : { ...block, id };
            });
            const nextHunk = { ...hunk, blocks };
            return { ...nextHunk, status: summarizeBlockStatus(nextHunk) };
          }),
        };
        return { ...next, status: summarizeDiffStatus(next) };
      };

      state.pendingDiffs = state.pendingDiffs.map(apply);
      for (const msg of state.messages) {
        if (!msg.diffs) continue;
        msg.diffs = msg.diffs.map(apply);
      }
    },
    addAssistantRun(state, action: PayloadAction<AssistantRun>) {
      state.assistantRuns[action.payload.id] = action.payload;
    },
    addRunEvent(state, action: PayloadAction<AssistantRunEvent>) {
      const run = state.assistantRuns[action.payload.runId];
      if (run) {
        run.events.push(action.payload);
        if (action.payload.type === 'done') {
          run.status = 'complete';
          run.endedAt = action.payload.timestamp;
        }
        if (action.payload.type === 'stream_mode' && action.payload.streamMode) {
          run.streamMode = action.payload.streamMode;
          run.fallbackReason = action.payload.fallbackReason;
        }
        if (action.payload.type === 'error' || action.payload.type === 'aborted') {
          run.status = action.payload.type === 'error' ? 'error' : 'aborted';
          run.endedAt = action.payload.timestamp;
        }
      }
      if (action.payload.messageId) {
        const msg = state.messages.find(m => m.id === action.payload.messageId);
        if (msg) msg.runEvents = [...(msg.runEvents ?? []), action.payload];
      }
    },
    recordFileSnapshot(state, action: PayloadAction<FileSnapshot>) {
      state.fileSnapshots[action.payload.id] = action.payload;
    },
    setStreaming(state, action: PayloadAction<boolean>) {
      state.isStreaming = action.payload;
    },
    appendStreamingContent(state, action: PayloadAction<string>) {
      state.streamingContent += action.payload;
    },
    clearStreamingContent(state) {
      state.streamingContent = '';
    },
    setModel(state, action: PayloadAction<string>) {
      state.model = action.payload;
    },
    setTokenUsage(state, action: PayloadAction<Omit<TokenUsage, 'updatedAt'>>) {
      state.tokenUsage = { ...action.payload, updatedAt: Date.now() };
      state.tokenCount = action.payload.totalTokens;
    },
    setPendingMessage(state, action: PayloadAction<string>) {
      state.pendingMessage = action.payload;
    },
    clearConversation(state) {
      state.id = null;
      state.title = '新对话';
      state.messages = [];
      state.assistantRuns = {};
      state.fileSnapshots = {};
      state.pendingDiffs = [];
      state.isStreaming = false;
      state.streamingContent = '';
      state.tokenCount = 0;
      state.tokenUsage = null;
    },
    setTitle(state, action: PayloadAction<string>) {
      state.title = action.payload;
    },
    // 编辑用户消息 → 修改内容 + 截断该消息之后的所有消息
    editMessage(state, action: PayloadAction<{ id: string; content: string }>) {
      const idx = state.messages.findIndex(m => m.id === action.payload.id);
      if (idx >= 0) {
        state.messages[idx].content = action.payload.content;
        state.messages[idx].contentParts = textToContentParts(action.payload.content);
        // 截断后续消息
        state.messages = state.messages.slice(0, idx + 1);
      }
    },
    // 回溯到某条消息（保留该消息及之前的所有消息）
    truncateAt(state, action: PayloadAction<string>) {
      const idx = state.messages.findIndex(m => m.id === action.payload);
      if (idx >= 0) {
        state.messages = state.messages.slice(0, idx + 1);
      }
    },
    // 删除单条消息
    deleteMessage(state, action: PayloadAction<string>) {
      state.messages = state.messages.filter(m => m.id !== action.payload);
    },
  },
});

export const {
  setConversation, addMessage, updateMessage,
  updateMessageMeta, appendMessageContent, setMessageAttachments,
  appendMessageThinking, setMessageStreamState,
  addMessageDiff, updateDiffStatus, updateHunkStatus, updateDiffBlockStatus, addAssistantRun, addRunEvent, recordFileSnapshot,
  setStreaming, appendStreamingContent, clearStreamingContent,
  setModel, setTokenUsage, setPendingMessage, clearConversation, setTitle,
  editMessage, truncateAt, deleteMessage,
} = conversationSlice.actions;

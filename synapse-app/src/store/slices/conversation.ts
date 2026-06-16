import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

// M2-R6 附件引用层：image_url / file part 内联 base64 不再落库/发送，统一以 sha256 内容寻址引用。
//   - sha256：put 返回的内容地址，落库/发送的唯一权威；url/data 是【内存态即时预览】(blobURL/dataUrl)，落库前必清。
//   - size/mime/name：引用元数据，R4 token 估算在「未还原成 base64」时按 size 折算视觉占用，不必先 get 还原。
//   - url 仍保留：发 API 前 agentLoop 按 sha256 get 还原成真 dataUrl 填回 url（模型需要真图）。
export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' }; attachmentId?: string; sha256?: string; size?: number; mime?: string; name?: string }
  | { type: 'file'; file: { filename: string; mimeType?: string; data?: string; url?: string; sha256?: string; size?: number }; attachmentId?: string };

export interface AttachmentRef {
  id: string;
  name: string;
  path?: string;
  mimeType?: string;
  size?: number;
  kind: 'image' | 'document' | 'text' | 'archive' | 'other';
  // previewUrl / payloadUrl 为【内存态】即时预览（blobURL 或 dataUrl），落库前会被 sanitize 清掉，DB 绝不含 base64。
  previewUrl?: string;
  payloadUrl?: string;
  // M2-R6：附件实体的 sha256 内容地址（落库/发送的唯一权威引用；上传时 platform.attachment.put 返回）。
  sha256?: string;
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
  /**
   * ★ M4-8-S3：重连进度【瞬态】字段——退避重试期间显示「reconnect i/N」，收到实质数据/本轮收尾即清。
   *   绝不持久化：sanitizeMessagesForPersistence 显式剔除、branchConversation 子集复制时剥离，
   *   保证历史恢复后消息不带残留假「重连中」（Plan_5 风险二）。
   */
  reconnect?: { attempt: number; max: number };
  /**
   * ★ M4-8-S4：端到端总计时（ms）——整个 agent loop 完成（用户发出 → 含多轮工具调用全部完成）耗时，
   *   只挂在 loop【最终完成消息】那一条上（不在每条 run 上重复，见 Plan_5 风险四）。
   *   逐条 run 计时仍走各自的 durationMs，互不干扰。
   */
  endToEndMs?: number;
  runId?: string;
  runEvents?: AssistantRunEvent[];
  diffs?: FileDiffSummary[];
  rollbackSnapshotId?: string;
  error?: string;
  /**
   * ★ M3-3a：本消息关联的 Multi-AI 工作流运行实例 id（multiAI.workflowRuns[runId]）。
   *   仅 @MultiAI 工作流触发的 assistant 汇总消息带此字段；MessageBubble 据此在消息体内渲染 <WorkflowCard runId=.../>
   *   （实时四色子代理卡片），纯文本汇总 content 作为 fallback/可折叠。普通对话消息无此字段，零回归。
   *   注：workflowRuns 是运行态（不持久化），重启后该 runId 查不到 → WorkflowCard 自然回退只显示文本汇总。
   */
  workflowRunId?: string;
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
  // M2-3 对话分支溯源：分支出的对话记其来源（DB 一直对，此前 store 未接回 → 渲染显示 null）。
  //   parentId = 源对话 id；branchedFromMessageId = 在源对话哪条消息处「从此分支」。非分支对话为 null。
  parentId: string | null;
  branchedFromMessageId: string | null;
  // M4-2-S4 当前对话工作区归属：以工作区 path 为稳定身份键（null = Global 无归属）。
  //   新建对话默认归当前工作区（S5 接线），恢复/分支回填，UI 改归属经 setConversationWorkspace。
  workspacePath: string | null;
  // ★ M4-6-S4 对话目标（/goal 设定）：随对话持久化（DB goal 列 + autosave）。
  //   设目标后每轮 agentLoop.run 读取并经 promptBuilder.build 注入 <current_goal> 段（每轮自动注入）。
  //   空串/undefined 视为未设目标（build 不注入该段）。clearConversation 清空、setConversation 换身份时回填。
  goal?: string;
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
  parentId: null,
  branchedFromMessageId: null,
  workspacePath: null,
  goal: undefined,
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
      // M2-3：分支/加载对话时回填溯源。语义为「undefined 不覆盖」——懒迁移回写、重命名回写等
      //   不带这两字段的 setConversation 不会把已有溯源清成 null（避免回写副作用抹掉分支来源）。
      //   切换/加载/分支这类「换对话身份」的入口必须显式传（含 null）以正确刷新。
      parentId?: string | null;
      branchedFromMessageId?: string | null;
      // M4-2-S4：工作区归属可选回填，沿用「undefined 不覆盖」语义——懒迁移回写等不带该字段的 setConversation
      //   不会把已有归属清成 null。切换/加载/恢复这类「换对话身份」的入口须显式传（含 null=Global）以正确刷新。
      workspacePath?: string | null;
      // ★ M4-6-S4：对话目标可选回填，沿用「'goal' in payload 才覆盖」语义——懒迁移回写等不带该字段的
      //   setConversation 不会把已设目标清掉。切换/加载/恢复这类「换对话身份」的入口须显式传（含 undefined）以正确刷新。
      goal?: string;
    }>) {
      state.schemaVersion = CONVERSATION_SCHEMA_VERSION;
      state.id = action.payload.id;
      state.title = action.payload.title;
      state.messages = action.payload.messages.map(normalizeMessage);
      state.assistantRuns = action.payload.assistantRuns ?? {};
      state.fileSnapshots = action.payload.fileSnapshots ?? {};
      state.pendingDiffs = (action.payload.pendingDiffs ?? []).map(normalizeDiff);
      state.model = action.payload.model ?? state.model;
      if ('parentId' in action.payload) state.parentId = action.payload.parentId ?? null;
      if ('branchedFromMessageId' in action.payload) {
        state.branchedFromMessageId = action.payload.branchedFromMessageId ?? null;
      }
      if ('workspacePath' in action.payload) state.workspacePath = action.payload.workspacePath ?? null;
      // ★ M4-6-S4：换对话身份时回填 goal（'goal' in payload 才覆盖，含显式 undefined→清空；不带则不动）。
      if ('goal' in action.payload) state.goal = action.payload.goal || undefined;
    },
    // M4-2-S4：手动改当前对话工作区归属（S6/S7「移动到…」用）。null = 改归 Global。
    setConversationWorkspace(state, action: PayloadAction<string | null>) {
      state.workspacePath = action.payload ?? null;
    },
    // ★ M4-6-S4：设定 / 清空当前对话目标（/goal 命令用）。空串/undefined → 清空（视为未设目标）。
    //   随对话持久化（autosave effect 依赖 conversation.goal 重落库；DB goal 列；切换/恢复回填）。
    setGoal(state, action: PayloadAction<string | undefined>) {
      const next = (action.payload ?? '').trim();
      state.goal = next || undefined;
    },
    /**
     * ★ M4-6-S4 手动 /compact 闭环第 (1) 步「截断 store.messages + 刷新注入前缀」（见 agentLoop.compactNow JSDoc 职责边界）。
     *   compactNow 只生成 record 批次 + 落库 + 同步 autosave，【不】动 store.messages；本 reducer 由 /compact thunk
     *   在 compactNow 之后调用，把对话历史真正收敛为：
     *     头部 1 条 system「压缩摘要」消息（content = recordMd，承载被压段的 record 摘要，下一轮 run 作历史前缀发出 →
     *     即「刷新注入前缀」）  +  最近 keepRecent 条原文。
     *   这样被压段从可见对话流移除、后续组装只剩 keep 尾部；摘要已物化进 system 消息。
     *   ★ M4-6 审查修复（问题6）：thunk 在本 reducer 之后【不再】调 clampToBatch——/compact 是「头部压缩」，
     *   record 水位由 compactNow 的 appendBatch 正确前进即可；clampToBatch 是「尾部截断/编辑」专用，在此会把刚写的
     *   record 批误删（keptSteps=最近几条 < record.totalSteps 累计量 → 误判超界）。详见 AgentPanel compactNow helper。
     *   summaryPrefix 为空（无 record 可压）时为 no-op，避免插入空摘要。
     */
    applyManualCompact(state, action: PayloadAction<{ summaryPrefix: string; keepRecent: number }>) {
      const summary = (action.payload.summaryPrefix ?? '').trim();
      if (!summary) return; // 无可压缩内容 → 不动。
      const keep = Math.max(0, action.payload.keepRecent);
      // 仅在确有可压段（消息数 > keep）时压缩；否则历史本就很短，无需动。
      if (state.messages.length <= keep) return;
      const tail = keep > 0 ? state.messages.slice(state.messages.length - keep) : [];
      const summaryMessage: Message = normalizeMessage({
        id: `compact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        role: 'system',
        content: summary,
        timestamp: Date.now(),
      });
      state.messages = [summaryMessage, ...tail];
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
    /**
     * ★ M4-8-S3：设置/清除消息的【瞬态】重连进度。
     *   reconnect 有值 → 写入（退避重试中，气泡显示 reconnect i/N）；
     *   reconnect 为 null/undefined → 清除（收到实质数据 / 本轮收尾，提示消失）。
     *   该字段不持久化（sanitize + branch 双重剔除）。
     */
    setMessageReconnect(state, action: PayloadAction<{ id: string; reconnect: { attempt: number; max: number } | null }>) {
      const msg = state.messages.find(m => m.id === action.payload.id);
      if (msg) {
        if (action.payload.reconnect) {
          msg.reconnect = action.payload.reconnect;
        } else {
          delete msg.reconnect;
        }
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
      // M2-3：新对话无分支来源。
      state.parentId = null;
      state.branchedFromMessageId = null;
      // ★ M4-2 审查修复：clearConversation 必须把工作区归属重置为 null（Global），让注释（ConversationList /
      //   AgentPanel S5 两处「clear 把 workspacePath 重置为 null」）与行为一致。新建入口紧跟的
      //   setConversationWorkspace 仍会覆盖为当前工作区（不冲突）；而删当前对话 / 批量删含当前 / 清空全部历史
      //   这三条 clear 后无 setConversationWorkspace 的路径，借此正确回到 Global 空态——否则 store 残留被删对话的
      //   归属，导致 S7 切换器顶部仍显旧工作区徽标、且空态下发首条消息会让新对话错误继承被删对话的归属。
      state.workspacePath = null;
      // ★ M4-6-S4：新对话无目标——清空 goal，避免新对话误继承上条对话的 goal 注入系统提示。
      state.goal = undefined;
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
        // M2-R6：编辑后消息变纯文本，原附件引用一并丢弃（contentParts 已重置，attachments 也清空），
        // 与 AgentPanel.handleEdit 对被编辑消息的 release 守恒；否则 store 残留指向已 GC 实体的 sha256。
        state.messages[idx].attachments = undefined;
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
  setConversation, setConversationWorkspace, setGoal, applyManualCompact, addMessage, updateMessage,
  updateMessageMeta, appendMessageContent, setMessageAttachments,
  appendMessageThinking, setMessageStreamState, setMessageReconnect,
  addMessageDiff, updateDiffStatus, updateHunkStatus, updateDiffBlockStatus, addAssistantRun, addRunEvent, recordFileSnapshot,
  setStreaming, appendStreamingContent, clearStreamingContent,
  setModel, setTokenUsage, setPendingMessage, clearConversation, setTitle,
  editMessage, truncateAt, deleteMessage,
} = conversationSlice.actions;

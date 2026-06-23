import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { ExtractedToken } from '@/services/inputCommands/richInput/types';
import type { EditorFileType } from '@/services/editorFileTypes';

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

/**
 * ★ show_artifact：AI 主动推给用户的「产物卡片」——指向一个【已存在的文件】，用户点卡片在中部编辑器打开。
 *   是 FileDiffSummary（文件改动 diff chip）的孪生体，但更简单：只承载「打开这个文件」所需的最小信息，
 *   不含 diff/snapshot/行数统计（产物只展示已存在文件，工具不写盘）。
 *   - path：文件路径（工具 handler 记录时的原始路径，打开链路据此 openTab）。
 *   - label：卡片显示名（缺省取文件名）。
 *   - editorType：handler 预解析的编辑器类型（resolveEditorType 按扩展名判定），打开时直接用对的查看器
 *     （office/pdf/image 等），避免一律按 'code' 打开。旧数据/未解析时 undefined → 打开链路兜底 'code'。
 */
export interface MessageArtifact {
  id: string;
  path: string;
  label: string;
  editorType?: EditorFileType;
}

/**
 * ★ task_boundary（Plan_5 §10）：Plan 模式任务边界。对话级、随对话持久化（JSON 列）。
 *   不进请求体、不参与 record 摘要、不影响压缩/轮次/token——纯 UI 层结构。steps 内联在 boundary。
 */
export interface TaskBoundaryStep {
  id: string;
  text: string;
  timestamp: number;          // ms（Date.now()）
  toolCallIds?: string[];     // 可选：本 step 关联的 toolCall id（预留）
}

/** headline/summary 的一次历史变更（★ 比 Antigravity 多做的「历史标题概括变迁」时间线）。 */
export interface TaskHeadlineHistoryEntry {
  headline: string;
  summary: string;
  timestamp: number;          // ms
}

export interface TaskBoundary {
  id: string;
  headline: string;
  summary: string;
  status: 'active' | 'done' | 'aborted';
  startedAt: number;          // ms
  endedAt?: number;           // done/aborted 时回填
  anchorMessageId?: string;   // 边界【开始】锚定的 assistant 消息 id（卡片吞消息区间上界）
  endAnchorMessageId?: string;// ★ 边界【收口】时刻最后一条消息 id（卡片吞消息区间下界；active 未收口=延伸到当前末尾）
  startRound?: number;        // 对齐 M5-2 轮次地基（可选，首版可不填）
  endRound?: number;
  steps: TaskBoundaryStep[];
  history: TaskHeadlineHistoryEntry[];  // ★ 该边界 headline/summary 变更时间线（含初始项）
}

/** 对话级「当前大标题 + 概述」镜像（顶部/卡片直接读；变更同步进 active boundary.history）。 */
export interface TaskHeadline {
  headline: string;
  summary: string;
  updatedAt: number;          // ms
}

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
  /** ★ worktree 隔离（审查 HIGH）：产生此 diff 时的执行上下文 id（= ctx.contextId）。回滚/审阅据此经
   *  resolveWorktreePath 重定向到当时的 worktree，避免落到主工作区（created 误删同名文件 / edited afterHash 不匹配）。
   *  旧 diff 无此字段（undefined）→ 重定向短路 = 主工作区，行为同改造前，向后兼容。 */
  contextId?: string;
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
  /**
   * ★ M6 收尾 D1：发送时 RichTextInput.extract() 产出的有序 atomic token（{type, id, value, displayLabel?}），
   *   仅用于「编辑历史消息时无损还原 @ 高亮块」，不进 LLM 上下文（不计入 token、不影响 record 摘要）。
   *   旧消息无此字段（DB rich_tokens=NULL）→ 编辑回填降级为纯文本（与 D1 之前完全一致，非回归）。
   */
  richTokens?: ExtractedToken[];
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
  /**
   * ★ H6（M8 第七轮反馈）：本条【用户消息】的语义小标题（≤12 字）。本轮开始时由系统模型 fire-and-forget
   *   生成（generateSubtitleFromText），供「消息导航」浮层快速跳转定位。非瞬态——随消息落库（DB subtitle 列），
   *   sanitize 黑名单不剔除天然透传。仅 user 消息生成；assistant/tool 无此字段。可由用户手动改写覆盖。
   */
  subtitle?: string;
  /** ★ H6：subtitle 生成/手改的时间戳（ms）。竞态守卫与「是否已生成」判断据此。 */
  subtitleGeneratedAt?: number;
  runId?: string;
  runEvents?: AssistantRunEvent[];
  diffs?: FileDiffSummary[];
  /**
   * ★ show_artifact：本消息附带的产物卡片（AI 主动推的「已存在文件」入口）。与 diffs 并列、互不影响——
   *   diffs 是 AI 改动的文件（带 diff/审阅），artifacts 只是 AI 让用户「看一眼这个已存在文件」（点开即在编辑器打开）。
   *   消费链由 agentLoop 紧挨 consumeTrackedFileChanges 处 consumeTrackedArtifacts + dispatch addMessageArtifact。
   */
  artifacts?: MessageArtifact[];
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

/**
 * ★ H4-2（M8 第七轮反馈）：生成中插话的【排队消息】。运行态——绝不落库（刷新/重开自然清空，
 *   不进 sanitizeMessagesForPersistence、不进任何持久化快照）。
 *   生成中用户发消息不再被静默丢弃，而是入队，本轮 agent loop 结束（isStreaming true→false 下降沿）
 *   时由 AgentPanel 取队首走正常发送逻辑发出去（自然继承 H4-1 归属开关、@/斜杠命令分流等全部链路）。
 */
export interface QueuedMessage {
  id: string;                          // 队列项稳定 id（React key + 按 id 单独取消）
  text: string;                        // 入队时刻输入框纯文本（extract().plainText）
  contentParts?: MessageContentPart[]; // 入队时刻已组装的 content parts（含图片引用）
  attachments?: AttachmentRef[];       // 入队时刻就绪附件（status='ready'，发送时转 'sent'）
  richTokens?: ExtractedToken[];       // 富文本 atomic token 锚点（编辑历史无损还原；不进 LLM 上下文）
  enqueuedAt: number;                  // 入队时间戳（ms）
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  // cancelled：生成被中断 / 上次会话未执行完，恢复时收尾为此态（区别于转圈的 pending/running）。
  status: 'pending' | 'running' | 'success' | 'error' | 'cancelled';
  executionTime?: number; // ms，执行耗时（success/error 时回填，供 ToolCallCard 显示）
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
  // ★ H4-2：生成中插话的排队消息（运行态，绝不落库；刷新/重开自然清空）。本轮结束自动发队首。
  queuedMessages: QueuedMessage[];
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
  // ★ task_boundary（Plan_5 §10）：对话级任务边界数组 + 当前大标题镜像。随对话持久化（JSON 列）。
  //   仅 Plan 模式 + taskBoundaryEnabled 时由 AI 工具写入；clearConversation 清空、setConversation 回填。
  taskBoundaries?: TaskBoundary[];
  taskHeadline?: TaskHeadline;
  // ★ M5-BPC：本对话【后台预压缩触发水位】覆盖（留空=用全局 agentSettings.bpc.bpcThreshold）。
  //   scheduler.evaluateWater 读 effectiveBpcThreshold = conversation.bpcThresholdOverride ?? agentSettings.bpc.bpcThreshold。
  //   ★ 是 number：undefined=未覆盖；持久化/回填严禁 `x||undefined`（0 falsy 陷阱），统一 typeof==='number' 判定。
  bpcThresholdOverride?: number;
  // ★ M5-BPC：本对话【硬阻塞压缩水位】覆盖（留空=用全局 agentSettings.bpc.compactThreshold）。同 number 口径。
  compactThresholdOverride?: number;
}

const CONVERSATION_SCHEMA_VERSION = 1;

/**
 * ★ task_boundary 截断同步（M7 第四轮，治 review HIGH「回溯/编辑/清空截断 messages 时不清理 taskBoundaries」）：
 *   回溯/编辑/清空把 state.messages 截短后调用——以保留下来的消息为界裁剪任务边界：
 *     ① anchorMessageId 已不在保留消息里的边界整条丢弃（其锚消息被截掉了，否则会漂到末尾成孤儿僵尸卡）；
 *     ② endAnchorMessageId 落在被截区的，清掉（区间下界失效，渲染退化为延伸到当前末尾）；
 *     ③ 仍保留但 status==='active' 的收口为 done（它的 end_task_boundary 工具调用随被截轮一起撤销、
 *        永不会再执行，不收口会永久脉冲「进行中」）。
 *   ⚠️ 只在【真发生截断】时调（保留消息数 < 原数）——回溯到最后一条 = no-op，不应误收口正在进行的边界。
 */
function clampTaskBoundariesAfterTruncation(state: ConversationState) {
  if (!state.taskBoundaries || state.taskBoundaries.length === 0) return;
  const ids = new Set(state.messages.map(m => m.id));
  const now = Date.now();
  state.taskBoundaries = state.taskBoundaries.filter(b => !!b.anchorMessageId && ids.has(b.anchorMessageId));
  for (const b of state.taskBoundaries) {
    if (b.endAnchorMessageId && !ids.has(b.endAnchorMessageId)) b.endAnchorMessageId = undefined;
    if (b.status === 'active') { b.status = 'done'; b.endedAt = now; }
  }
}

function textToContentParts(content: string): MessageContentPart[] {
  return content ? [{ type: 'text', text: content }] : [];
}

function normalizeMessage(message: Message, restoring = false): Message {
  const content = message.content ?? '';
  const contentParts = Array.isArray(message.contentParts)
    ? message.contentParts
    : textToContentParts(content);
  // ★ 命令转圈修复（恢复路径专属）：从持久化/切换对话恢复消息时，收尾上次会话残留的「未完成态」，
  //   避免重开后工具卡片永久转圈、消息卡在 streaming。仅 restoring=true 时生效——addMessage 新加
  //   正要流式的消息走 restoring=false，绝不能被强制收尾（否则打断刚发起的流式）。
  if (restoring) {
    const toolCalls = message.toolCalls?.map(tc =>
      (tc.status === 'pending' || tc.status === 'running')
        ? (tc.result
            ? { ...tc, status: 'success' as const }              // 有结果说明实际已完成（沿用 FIX-13 语义）
            : { ...tc, status: 'cancelled' as const, result: '⚠️ 上次会话中断，工具未执行完成' })
        : tc
    );
    const restoredStream = (message.streamState === 'streaming' || message.streamState === 'pending')
      ? 'aborted' as const
      : message.streamState;
    return { ...message, content, contentParts, toolCalls, isStreaming: false, streamState: restoredStream };
  }
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
  queuedMessages: [], // ★ H4-2：排队消息初始为空（运行态）
  model: '',
  tokenCount: 0,
  tokenUsage: null,
  pendingMessage: '',
  parentId: null,
  branchedFromMessageId: null,
  workspacePath: null,
  goal: undefined,
  taskBoundaries: undefined,
  taskHeadline: undefined,
  // ★ M5-BPC：本对话阈值覆盖默认未设（用全局默认）。
  bpcThresholdOverride: undefined,
  compactThresholdOverride: undefined,
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
      // ★ M5-BPC：本对话阈值覆盖可选回填，沿用「'key' in payload 才覆盖」语义（含显式 undefined→清空）。
      //   不带则不动（懒迁移回写等不带这两字段的 setConversation 不抹掉已设覆盖）。number 口径。
      bpcThresholdOverride?: number;
      compactThresholdOverride?: number;
      taskBoundaries?: TaskBoundary[];
      taskHeadline?: TaskHeadline;
    }>) {
      state.schemaVersion = CONVERSATION_SCHEMA_VERSION;
      state.id = action.payload.id;
      state.title = action.payload.title;
      state.messages = action.payload.messages.map((m) => normalizeMessage(m, true)); // restoring：恢复对话时收尾残留未完成态（防工具卡片永久转圈）
      state.assistantRuns = action.payload.assistantRuns ?? {};
      state.fileSnapshots = action.payload.fileSnapshots ?? {};
      state.pendingDiffs = (action.payload.pendingDiffs ?? []).map(normalizeDiff);
      // ★ H4-2：换对话身份（切换/加载/分支） → 清空排队队列（运行态，绝不跨对话带过去）。
      state.queuedMessages = [];
      state.model = action.payload.model ?? state.model;
      if ('parentId' in action.payload) state.parentId = action.payload.parentId ?? null;
      if ('branchedFromMessageId' in action.payload) {
        state.branchedFromMessageId = action.payload.branchedFromMessageId ?? null;
      }
      if ('workspacePath' in action.payload) state.workspacePath = action.payload.workspacePath ?? null;
      // ★ M4-6-S4：换对话身份时回填 goal（'goal' in payload 才覆盖，含显式 undefined→清空；不带则不动）。
      if ('goal' in action.payload) state.goal = action.payload.goal || undefined;
      // ★ task_boundary：换对话身份时回填（'key' in payload 才覆盖，含显式 undefined→清空；不带则不动）。
      if ('taskBoundaries' in action.payload) state.taskBoundaries = action.payload.taskBoundaries ?? undefined;
      if ('taskHeadline' in action.payload) state.taskHeadline = action.payload.taskHeadline ?? undefined;
      // ★ M5-BPC：换对话身份时回填阈值覆盖（'key' in payload 才覆盖；number 用 typeof 判定，绝不用 `||` 吞 0）。
      if ('bpcThresholdOverride' in action.payload) {
        const v = action.payload.bpcThresholdOverride;
        state.bpcThresholdOverride = typeof v === 'number' && Number.isFinite(v) ? v : undefined;
      }
      if ('compactThresholdOverride' in action.payload) {
        const v = action.payload.compactThresholdOverride;
        state.compactThresholdOverride = typeof v === 'number' && Number.isFinite(v) ? v : undefined;
      }
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
    // ★ task_boundary（Plan_5 §10）：开新任务边界，前一个 active 自动收为 done。新边界初始 history 含一条初始项。
    beginTaskBoundary(state, action: PayloadAction<{ id: string; headline: string; summary?: string; anchorMessageId?: string; startRound?: number; at?: number }>) {
      const now = action.payload.at ?? Date.now();
      if (!state.taskBoundaries) state.taskBoundaries = [];
      for (const b of state.taskBoundaries) {
        if (b.status === 'active') { b.status = 'done'; b.endedAt = now; }
      }
      const headline = action.payload.headline;
      const summary = action.payload.summary ?? '';
      state.taskBoundaries.push({
        id: action.payload.id,
        headline, summary,
        status: 'active',
        startedAt: now,
        anchorMessageId: action.payload.anchorMessageId,
        startRound: action.payload.startRound,
        steps: [],
        history: [{ headline, summary, timestamp: now }],
      });
      state.taskHeadline = { headline, summary, updatedAt: now };
    },
    // ★ 设/更新顶部大标题+概述：刷镜像 + 给当前 active boundary.history push 一条（AI 每个小标题调一次）。
    //   无 active 时只刷镜像、不 push（history 无处挂，合理降级）。
    setTaskHeadline(state, action: PayloadAction<{ headline: string; summary?: string; at?: number }>) {
      const now = action.payload.at ?? Date.now();
      const headline = action.payload.headline;
      // ★ summary 缺省（undefined）= 不改、保留旧值；传空串 '' = 显式清空。配合 toolRegistry handler 缺省传 undefined
      //   （review MEDIUM：之前 handler 恒传 ''，把 reducer 「?? 旧值」兜底架空 → 只换标题会误清空概括 + 污染 history）。
      const summary = action.payload.summary !== undefined
        ? action.payload.summary
        : (state.taskHeadline?.summary ?? '');
      state.taskHeadline = { headline, summary, updatedAt: now };
      const active = state.taskBoundaries?.find(b => b.status === 'active');
      if (active) {
        active.headline = headline;
        active.summary = summary;
        // ★ 判重：与最后一条 history 完全相同则不重复 push（防重复/空变更调用撑大变迁时间线）。
        const last = active.history[active.history.length - 1];
        if (!last || last.headline !== headline || last.summary !== summary) {
          active.history.push({ headline, summary, timestamp: now });
        }
      }
    },
    // ★ 给当前 active 边界追加一条进度 step。无 active 则 no-op（AI 该先 begin）。
    appendTaskStep(state, action: PayloadAction<{ id: string; text: string; toolCallIds?: string[]; at?: number }>) {
      const active = state.taskBoundaries?.find(b => b.status === 'active');
      if (!active) return;
      active.steps.push({
        id: action.payload.id,
        text: action.payload.text,
        timestamp: action.payload.at ?? Date.now(),
        toolCallIds: action.payload.toolCallIds,
      });
    },
    // ★ 显式收口当前/指定边界（用户拍板：AI 显式调结束工具收口，不自动推断）。aborted=true 收为 'aborted'（红）。
    endTaskBoundary(state, action: PayloadAction<{ id?: string; aborted?: boolean; at?: number } | undefined>) {
      const p = action.payload ?? {};
      const now = p.at ?? Date.now();
      const target = p.id
        ? state.taskBoundaries?.find(b => b.id === p.id)
        : state.taskBoundaries?.find(b => b.status === 'active');
      if (!target) return;
      target.status = p.aborted ? 'aborted' : 'done';
      target.endedAt = now;
      // ★ 记录收口时刻最后一条消息 id 作为「吞消息」区间下界（卡片按 [anchor, endAnchor] 归组本边界期间的消息）。
      const lastMsg = state.messages[state.messages.length - 1];
      if (lastMsg) target.endAnchorMessageId = lastMsg.id;
    },
    // ★ M5-BPC：设定 / 清空本对话【预压触发水位】覆盖（SettingsPanel 本对话覆盖入口 / 命令用）。
    //   合法有限 number → 设；undefined/NaN/非数字 → 清空（视为未覆盖，回退全局默认）。
    //   ★ 绝不用 `x||undefined`——0 是合法 number 会被吞（虽阈值现实不为 0，留作正确口径）。随对话持久化。
    setBpcThresholdOverride(state, action: PayloadAction<number | undefined>) {
      const v = action.payload;
      state.bpcThresholdOverride = typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    },
    // ★ M5-BPC：设定 / 清空本对话【硬阻塞压缩水位】覆盖。同 number 口径。
    setCompactThresholdOverride(state, action: PayloadAction<number | undefined>) {
      const v = action.payload;
      state.compactThresholdOverride = typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    },
    // ★ M5-1 压缩归一：原 applyManualCompact reducer 已删除。
    //   压缩有且仅有一套（手动 /compact ＝ 自动压缩，完全同一套逻辑，仅触发方式不同）：压缩【不删任何 store.messages】，
    //   只在压缩点画 batchDivider 分隔线（AgentPanel.batchDividerByIdx，读 record 各批 stepEnd → 消息下标）。
    //   原 reducer 把 state.messages 收敛为 [system 摘要, ...keep 尾] 删了 store 消息，违背核心原则「UI/本地永不删减」，
    //   故彻底删除。/compact 现只调 agentLoop.compactNow（生成 record 批次 + 落库），绝不截断 store。
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
    /**
     * ★ show_artifact：把一张产物卡片挂到指定消息上（孪生 addMessageDiff，但更简单——
     *   artifact 无审阅态，故不入 pendingDiffs，只追加到该消息的 artifacts 列表）。
     */
    addMessageArtifact(state, action: PayloadAction<{ messageId: string; artifact: MessageArtifact }>) {
      const msg = state.messages.find(m => m.id === action.payload.messageId);
      if (msg) {
        msg.artifacts = [...(msg.artifacts ?? []), action.payload.artifact];
      }
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
    // ★ H4-2：把一条消息加入排队队列（生成中插话）。上限护栏在调用方（AgentPanel）拦——满了不 dispatch、给提示。
    enqueueMessage(state, action: PayloadAction<QueuedMessage>) {
      state.queuedMessages.push(action.payload);
    },
    // ★ H4-2：从队列移除一条。不传 index → 删队首（本轮结束自动发后调）；传 index/id → 用户单独取消某条。
    //   ⚠️ Redux 单向流：reducer 不返回值。调用方需在 dispatch 前自行读 queuedMessages[0] 取内容，再 dequeue 移除。
    dequeueMessage(state, action: PayloadAction<{ index?: number; id?: string } | undefined>) {
      const p = action.payload ?? {};
      if (p.id !== undefined) {
        state.queuedMessages = state.queuedMessages.filter(m => m.id !== p.id);
        return;
      }
      const idx = typeof p.index === 'number' ? p.index : 0;
      if (idx >= 0 && idx < state.queuedMessages.length) {
        state.queuedMessages.splice(idx, 1);
      }
    },
    // ★ H4-2：清空整个排队队列。Stop / 切换对话 / 新建 / 分支 入口调用（防中止后乱发、防串台）。
    clearQueue(state) {
      state.queuedMessages = [];
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
      // ★ H4-2：换对话身份 → 清空排队队列（防上条对话残留排队消息串台进新对话）。
      state.queuedMessages = [];
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
      // ★ M5-BPC：新对话无阈值覆盖——清空，避免新对话误继承上条对话的 BPC/压缩阈值覆盖。
      state.bpcThresholdOverride = undefined;
      state.compactThresholdOverride = undefined;
      // ★ task_boundary：新对话/清空——清掉任务边界与大标题，避免新对话误继承上条对话的边界。
      state.taskBoundaries = undefined;
      state.taskHeadline = undefined;
    },
    setTitle(state, action: PayloadAction<string>) {
      state.title = action.payload;
    },
    // 编辑用户消息 → 修改内容 + 截断该消息之后的所有消息
    editMessage(state, action: PayloadAction<{ id: string; content: string; contentParts?: MessageContentPart[]; attachments?: AttachmentRef[]; richTokens?: ExtractedToken[] }>) {
      const idx = state.messages.findIndex(m => m.id === action.payload.id);
      if (idx >= 0) {
        state.messages[idx].content = action.payload.content;
        // ★ C6：带 contentParts/attachments 则写入（编辑保留/新增图，AgentPanel.handleEdit 已按 KEPT/REMOVED 守恒 release）；
        //   不带（旧调用）则退回纯文本（向后兼容）。
        state.messages[idx].contentParts = action.payload.contentParts ?? textToContentParts(action.payload.content);
        state.messages[idx].attachments = action.payload.attachments && action.payload.attachments.length > 0
          ? action.payload.attachments
          : undefined;
        // ★ D1：带 richTokens 则写入（编辑后用户增删的最新 token 集合）；不带（旧调用）则置 undefined。
        state.messages[idx].richTokens = action.payload.richTokens && action.payload.richTokens.length > 0
          ? action.payload.richTokens
          : undefined;
        // 截断后续消息
        const editTruncated = idx < state.messages.length - 1;
        state.messages = state.messages.slice(0, idx + 1);
        if (editTruncated) clampTaskBoundariesAfterTruncation(state);
      }
    },
    // 回溯到某条消息（保留该消息及之前的所有消息）
    truncateAt(state, action: PayloadAction<string>) {
      const idx = state.messages.findIndex(m => m.id === action.payload);
      if (idx >= 0) {
        const truncated = idx < state.messages.length - 1;
        state.messages = state.messages.slice(0, idx + 1);
        if (truncated) clampTaskBoundariesAfterTruncation(state);
      }
    },
    // 删除单条消息
    deleteMessage(state, action: PayloadAction<string>) {
      state.messages = state.messages.filter(m => m.id !== action.payload);
      // ★ task_boundary：删消息可能删掉某边界的 anchor/endAnchor。清理引用被删消息的边界（anchor 没了整条丢弃，
      //   endAnchor 没了清下界）——但【不收口 active】：删单条不等于打断进行中任务（区别于回溯/编辑的整段截断）。
      if (state.taskBoundaries && state.taskBoundaries.length > 0) {
        const ids = new Set(state.messages.map(m => m.id));
        state.taskBoundaries = state.taskBoundaries.filter(b => !b.anchorMessageId || ids.has(b.anchorMessageId));
        for (const b of state.taskBoundaries) {
          if (b.endAnchorMessageId && !ids.has(b.endAnchorMessageId)) b.endAnchorMessageId = undefined;
        }
      }
    },
    // ★ Plan_5 M5-3：清空所有消息（回溯到第 1 轮之前等「无任何消息保留」场景）。对话本体 id/title/goal
    //   保留，仅消息归零——区别于 clearConversation（重置整个对话）。
    clearMessages(state) {
      state.messages = [];
      // ★ task_boundary：消息归零 → 所有边界 anchor 都不在保留集 → clamp 自然全丢弃（防孤儿卡漂末尾）。
      clampTaskBoundariesAfterTruncation(state);
    },
    // ★ FIX-13：工具执行完成后回写 toolCall 的 status/result/耗时。此前 toolCall 创建为 'pending'，
    //   执行完从不回写 → ToolCallCard 永远显示 spinning（转圈不停）。按 messageId+toolCallId 定位回写。
    updateToolCallStatus(state, action: PayloadAction<{ messageId: string; toolCallId: string; status: ToolCall['status']; result?: string; executionTime?: number }>) {
      const msg = state.messages.find(m => m.id === action.payload.messageId);
      const tc = msg?.toolCalls?.find(t => t.id === action.payload.toolCallId);
      if (!tc) return;
      tc.status = action.payload.status;
      if (action.payload.result !== undefined) tc.result = action.payload.result;
      if (action.payload.executionTime !== undefined) tc.executionTime = action.payload.executionTime;
    },
  },
});

export const {
  setConversation, setConversationWorkspace, setGoal,
  beginTaskBoundary, setTaskHeadline, appendTaskStep, endTaskBoundary,
  setBpcThresholdOverride, setCompactThresholdOverride, addMessage, updateMessage,
  updateMessageMeta, appendMessageContent, setMessageAttachments,
  appendMessageThinking, setMessageStreamState, setMessageReconnect,
  addMessageDiff, addMessageArtifact, updateDiffStatus, updateHunkStatus, updateDiffBlockStatus, addAssistantRun, addRunEvent, recordFileSnapshot,
  setStreaming, appendStreamingContent, clearStreamingContent,
  enqueueMessage, dequeueMessage, clearQueue,
  setModel, setTokenUsage, setPendingMessage, clearConversation, setTitle,
  editMessage, truncateAt, deleteMessage, clearMessages, updateToolCallStatus,
} = conversationSlice.actions;

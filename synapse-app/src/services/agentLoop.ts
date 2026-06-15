/**
 * Agent Loop Engine
 * 多轮工具调用循环，最大 25 轮
 */

import { AIClient, type ChatMessage, type ToolCallRequest } from './aiClient';
import { store, type RootState } from '../store';
import {
  addMessage, updateMessage, updateMessageMeta, appendMessageContent,
  appendMessageThinking, setMessageStreamState, setStreaming,
  clearStreamingContent, setTitle, setTokenUsage,
  addAssistantRun, addRunEvent, addMessageDiff, recordFileSnapshot,
  type AttachmentRef, type MessageContentPart, type StreamModeUsed,
} from '../store/slices/conversation';
import { setConnectionStatus } from '../store/slices/agentSettings';
import { addNotification } from '../store/slices/notifications';
import { promptBuilder, compressContext, MAX_CONTEXT_TOKENS, COMPRESSION_THRESHOLD, estimateTokens, countConversationTokens } from './systemPrompt';
import { getRecord, appendBatch, getRecordSkeleton, type RecordBatch, type SynapseRecord } from './recordStore';
import { generateBatch } from './recordGenerator';
import { AUTOSAVE_ID, saveAutosaveSnapshot } from './conversationPersistence';
import { consumeTrackedFileChanges } from './fileChangeTracker';
import { restoreApiMessagesAttachments, chatContentToTextWithPlaceholder } from './attachmentRefs';

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface ToolExecutor {
  (name: string, args: Record<string, any>): Promise<string>;
}

const MAX_TOOL_ROUNDS = 25;

function generateId(prefix = 'msg'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getMessageText(message: any): string {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.contentParts)) {
    return message.contentParts
      .filter((part: any) => part?.type === 'text')
      .map((part: any) => part.text)
      .join('');
  }
  return '';
}

function toChatMessage(message: any): ChatMessage {
  const content = Array.isArray(message.contentParts) && message.contentParts.length > 0
    ? message.contentParts
    : getMessageText(message);
  return { role: message.role, content } as ChatMessage;
}

function chatContentToText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part: any) => part?.type === 'text')
    .map((part: any) => part.text)
    .join('');
}

/**
 * M2-R4 修复（问题2 多模态低估）：chatContentToText 只取文本 part，
 * 但图片/附件 part 会随请求体实际发送并占用大量 token。
 * 这里对【非文本 part】做体积近似，计入压缩触发判定，避免「带图/附件对话」组装量系统性偏小、压缩偏晚。
 *
 * 估算口径（保守粗估，宁多勿少，方向与触发判定一致）：
 *   - image_url：base64 data URI 按其编码长度折算 token（≈ 字符数 * 0.25，与 estimateTokens 英文系数一致）；
 *                ★ M2-R6：附件分离后历史图 part 落库/判定时是【sha256 引用态】（url 非 data:），此刻还没还原成
 *                  base64（还原推迟到发送前 restoreApiMessagesAttachments），但发送时会膨胀回完整 base64 进请求体。
 *                  故引用态按 part.size（原始字节，put 返回写入）折算：base64 字符数≈字节*4/3，token≈base64字符*0.25
 *                  ⇒ ≈ 字节/3。用 Math.ceil(size/3) 估，与「还原成 base64 后按长度估」同量级，避免带图对话压缩偏晚。
 *                外链 http url（无 size、非 data:）走视觉 token 固定估值（detail=low 约 85，high/auto 约 1100）。
 *   - file：优先按 file_data/data（base64）长度折算；其次按 size（同 image 口径 字节/3）；都无则固定占位下限。
 * 文本 part 不在此计（由 chatContentToText → countConversationTokens 统一计）。
 */
const IMAGE_TOKENS_LOW = 85;       // detail=low 视觉 token（OpenAI 量级）
const IMAGE_TOKENS_HIGH = 1100;   // detail=high/auto 视觉 token 上界近似
const FILE_ID_PLACEHOLDER_TOKENS = 256; // 仅有 file_id（体积不可见）时的保守占位估值
/** size(原始字节) → 发送时 base64 进请求体的近似 token：base64 字符≈字节*4/3，token≈字符*0.25 ⇒ ≈字节/3。 */
function estimateBytesAsBase64Tokens(size: number): number {
  return Math.ceil(size / 3);
}
function estimateNonTextPartsTokens(content: ChatMessage['content']): number {
  if (typeof content === 'string') return 0;
  let total = 0;
  for (const part of content as any[]) {
    if (!part || part.type === 'text') continue;
    if (part.type === 'image_url') {
      const url: string = part.image_url?.url || '';
      if (url.startsWith('data:')) {
        // base64 内联图：按 data URI 编码长度折算（base64 字符直接进请求体）
        total += Math.ceil(url.length * 0.25);
      } else if (typeof part.size === 'number' && part.size > 0) {
        // M2-R6 引用态：发送前会还原成 base64，按引用元数据 size 估其发送占用。
        total += estimateBytesAsBase64Tokens(part.size);
      } else {
        const detail = part.image_url?.detail;
        total += detail === 'low' ? IMAGE_TOKENS_LOW : IMAGE_TOKENS_HIGH;
      }
    } else if (part.type === 'file') {
      const data: string = part.file?.file_data || part.file?.data || '';
      const size: number = typeof part.file?.size === 'number' ? part.file.size : 0;
      if (data) total += Math.ceil(data.length * 0.25);
      else if (size > 0) total += estimateBytesAsBase64Tokens(size);
      else total += FILE_ID_PLACEHOLDER_TOKENS;
    }
  }
  return total;
}

/** 截断标记：超长单条被截断时插入，提示模型该消息内容已被裁剪。 */
const TRUNCATION_NOTICE = '\n\n[…内容过长，已截断以避免超出上下文窗口…]';

/**
 * M2-R4 问题4 修复：「少条超长」危险态（compressContext 返回 overLimitWithoutCompression=true）下，
 * 切片压缩无可压缩余量，直接全量发送会撑爆窗口。这里对发送体里【最长的文本 part】按比例截断，
 * 把组装总量压回 threshold 以下（尽力而为），避免请求被服务端拒绝或截断。
 *
 * 注意：只截断 text part，保留图片/附件 part 结构（它们体积无法靠裁字符缩小，且模型仍需感知其存在）；
 * 返回新的消息数组（不就地修改 requestHistory，避免污染 store / record 切片口径）。
 *
 * @param messages   待发送历史（apiHistory，含 string 或 ChatContentPart[] content）
 * @param fixedTokens systemPrompt + tools + 非文本 part 的固定占用（不可截断部分）
 * @param threshold  目标上限（token）；截断后总量尽量 ≤ 该值
 */
function truncateOverLongHistory(
  messages: ChatMessage[],
  fixedTokens: number,
  threshold: number,
): ChatMessage[] {
  // 当前文本侧总量
  const textTokensOf = (m: ChatMessage) => estimateTokens(chatContentToText(m.content));
  let textTotal = messages.reduce((s, m) => s + textTokensOf(m), 0);
  let budget = threshold - fixedTokens;
  if (budget < 0) budget = 0;
  // 文本侧可用预算（给文本 part 的总额度）
  if (textTotal <= budget) return messages; // 固定占用已把超额吃掉，文本无需截断

  // 找最长文本消息，按比例把它截到「让文本总量回到预算」所需的目标长度。
  // 一次只截最长的一条通常够用（少条超长场景往往是单条巨型粘贴）；循环兜底处理多条都很长的情况。
  const result = messages.map(m => ({ ...m })) as ChatMessage[];
  let truncatedAny = false;
  for (let guard = 0; guard < result.length && textTotal > budget; guard++) {
    // 选当前文本最长的一条
    let idx = -1;
    let maxTok = -1;
    for (let i = 0; i < result.length; i++) {
      const t = textTokensOf(result[i]);
      if (t > maxTok) { maxTok = t; idx = i; }
    }
    if (idx < 0 || maxTok <= 0) break;

    const overflow = textTotal - budget;            // 还需削减的 token
    const target = Math.max(0, maxTok - overflow);  // 该条文本截断后的目标 token
    // 目标 token → 目标字符数（按英文系数 0.25 反推，保守偏短，宁可多截一点不撑爆）
    const targetChars = Math.max(0, Math.floor(target / 0.25));

    const text = chatContentToText(result[idx].content);
    if (text.length <= targetChars) break; // 已无法再削（避免死循环）
    const kept = text.slice(0, targetChars) + TRUNCATION_NOTICE;

    // 写回：原为纯文本 → 直接替换；原为 parts → 只重建文本 part（合并为一个），保留非文本 part
    const orig = result[idx].content;
    if (typeof orig === 'string') {
      result[idx] = { ...result[idx], content: kept };
    } else {
      const nonText = (orig as any[]).filter(p => p?.type !== 'text');
      result[idx] = {
        ...result[idx],
        content: [{ type: 'text', text: kept } as any, ...nonText],
      };
    }
    truncatedAny = true;
    textTotal = result.reduce((s, m) => s + textTokensOf(m), 0);
  }

  if (truncatedAny) {
    console.warn(
      `[agentLoop] 少条超长历史已截断：固定占用 ${fixedTokens} tokens，目标阈值 ${Math.floor(threshold)} tokens。`,
    );
  }
  return result;
}

/** record 注入分级策略常量（M2-R3 渐进式读） */
const RECORD_HEAD_FULL = 1;   // 头部保底全文批数（最老 N 批）
const RECORD_TAIL_FULL = 2;   // 尾部保底全文批数（最新 N 批）
/** record 注入总量预算占当前模型 contextWindow 的比例 */
const RECORD_BUDGET_RATIO = 0.4;
const BATCH_JOIN = '\n\n---\n\n';

/** 渲染一个被降级为骨架的批次：明确标注可用 record_read 展开全文 */
function renderSkeletonBatch(batch: RecordBatch): string {
  const skeleton = (batch.skeleton || '').trim();
  const header = `[批次${batch.index} 骨架，可用 record_read(batchIndex=${batch.index}) 展开全文]`;
  return skeleton ? `${header}\n${skeleton}` : header;
}

/**
 * M2-R3 渐进式读：把多批 record 分级拼成注入前缀（替代 R1 临时态「头骨架 + 末批全文」全批拼接）。
 *
 * 分级规则：
 *   ① 头 RECORD_HEAD_FULL 批（最老）全文保底——保住开头背景。
 *   ② 尾 RECORD_TAIL_FULL 批（最新）全文保底——保住最近进展。
 *   ③ 中间批默认降级为【骨架】，并明确标注「可用 record_read 展开全文」让 AI 知道能按需取回。
 *   ④ token 预算 = contextWindow * RECORD_BUDGET_RATIO；先扣除头尾全文占用，
 *      再从最新中间批往前累加全文，预算内的中间批升级为全文、超预算的保持骨架。
 *   批次少（≤ 头+尾，即 ≤3）时全部全文，无中间批。
 *
 * @param contextWindow 当前模型真实上下文窗口（token），用于预算；缺省回退 MAX_CONTEXT_TOKENS。
 */
function buildRecordPrefix(record: SynapseRecord, contextWindow?: number): string {
  const batches = record.batches ?? [];
  if (batches.length === 0) return record.contentMd ?? '';
  if (batches.length === 1) return batches[0].contentMd;

  const win = contextWindow && contextWindow > 0 ? contextWindow : MAX_CONTEXT_TOKENS;
  const budget = Math.max(0, Math.floor(win * RECORD_BUDGET_RATIO));

  const n = batches.length;
  // 标记哪些 index 用全文
  const fullIdx = new Set<number>();
  // 预算约束的是【总注入量】而非仅全文量：骨架批的输出文本也占 token，
  // 先把所有批的骨架占用预扣进 usedTokens（基线），再用剩余预算把批从骨架升级为全文，
  // 升级增量 = 全文 token - 骨架 token（避免重复计费）。
  let usedTokens = 0;
  const skeletonCost = (b: RecordBatch) => estimateTokens(renderSkeletonBatch(b));
  for (const b of batches) usedTokens += skeletonCost(b);

  /** 把批从骨架升级为全文：累加「全文 - 骨架」增量。force=true 时无视预算（用于尾批保底）。 */
  const markFull = (b: RecordBatch, force = false): boolean => {
    if (fullIdx.has(b.index)) return true;
    const delta = Math.max(0, estimateTokens(b.contentMd) - skeletonCost(b));
    if (!force && usedTokens + delta > budget) return false;
    fullIdx.add(b.index);
    usedTokens += delta;
    return true;
  };

  // 批次足够少（头+尾即覆盖全部）→ 默认全部全文；但仍跑预算约束（聚焦点④：预算用真实 contextWindow）。
  // 保底优先：从最新批往最老批升级全文，预算内的升级、超预算的降级为骨架；
  // 至少强制保留尾 1 批全文（即便超预算也不能丢最近进展）。
  if (n <= RECORD_HEAD_FULL + RECORD_TAIL_FULL) {
    let downgraded = 0;
    for (let i = n - 1; i >= 0; i--) {
      const isLastTail = i === n - 1;            // 最新一批：强制全文保底
      if (!markFull(batches[i], isLastTail)) downgraded++;
    }
    if (downgraded > 0) {
      console.warn(
        `[agentLoop] buildRecordPrefix: 小批次(${n}≤${RECORD_HEAD_FULL + RECORD_TAIL_FULL})全文超预算(${budget} tokens)，` +
        `已将 ${downgraded} 个较老批降级为骨架（尾批强制全文保底）。`,
      );
    }
    return batches
      .map(b => (fullIdx.has(b.index) ? b.contentMd : renderSkeletonBatch(b)))
      .filter(Boolean)
      .join(BATCH_JOIN);
  }

  // 头尾保底：先放头 RECORD_HEAD_FULL 批 + 尾 RECORD_TAIL_FULL 批为全文（强制，保住背景与最近进展）
  for (let i = 0; i < RECORD_HEAD_FULL; i++) markFull(batches[i], true);
  for (let i = n - RECORD_TAIL_FULL; i < n; i++) markFull(batches[i], true);

  // 中间批（头尾之间）从最新往最老，剩余预算内逐个升级为全文（升级增量已扣除骨架基线）
  for (let i = n - RECORD_TAIL_FULL - 1; i >= RECORD_HEAD_FULL; i--) {
    markFull(batches[i]);
    // 超预算的中间批保持骨架（不 break：更老的批可能更短仍放得下，继续尝试）
  }

  return batches
    .map(b => (fullIdx.has(b.index) ? b.contentMd : renderSkeletonBatch(b)))
    .filter(Boolean)
    .join(BATCH_JOIN);
}

export class AgentLoop {
  private client: AIClient;
  private tools: ToolDefinition[] = [];
  private toolExecutor: ToolExecutor | null = null;
  private running = false;
  /**
   * R5 压缩点专用中止器【集合】：每个在途的【record 压缩 LLM 生成】（generateBatch）登记一个独立 controller。
   * 与 this.client（主对话 client）相互独立——主对话靠 this.client.abort()，压缩靠这里。
   *
   * ★ R5 修复（并发/重入归属）：原先用单个实例字段 this.compressController 跨 run 共享，
   *   快速连发/编辑重试触发的第二次 run 会无条件覆盖它、且其 finally 置 null 会误清别人的 controller，
   *   导致 stop() abort 不到旧压缩、或把新压缩的 controller 误置空（双双失去 stop 能力）。
   *   现改为：controller 为【每次 run 的局部变量】，进入压缩分支时 add 到本集合、finally 只 delete 自己那个；
   *   stop() 遍历集合 abort 全部在途压缩并 clear。归属清晰、互不误伤。
   *   （叠加 run() 入口重入闸后，正常情况下集合至多 1 个；集合是「即便重入闸将来被绕过也不误伤」的双保险。）
   */
  private compressControllers = new Set<AbortController>();

  constructor(client: AIClient) {
    this.client = client;
  }

  registerTools(tools: ToolDefinition[], executor: ToolExecutor) {
    this.tools = tools;
    this.toolExecutor = executor;
  }

  stop() {
    this.running = false;
    this.client.abort();
    // R5：中断【所有】正在进行的 record 压缩生成（若有），让 generateBatch 立即返回 null 走降级，
    // 而非傻等 60s timeout。遍历集合 abort 全部在途 controller 后整体 clear（已 abort 的不再复用）。
    for (const controller of this.compressControllers) controller.abort();
    this.compressControllers.clear();
  }

  async run(userMessage: string, opts?: { skipUserMessage?: boolean; contentParts?: MessageContentPart[]; attachments?: AttachmentRef[] }): Promise<void> {
    // ★ R5 修复（重入闸，问题1/2 核心防线）：run() 已在跑时拒绝二次进入。
    // 背景：压缩窗口期（可达 60s 的 generateBatch）原先 isStreaming 仍为 false——它要进 while 循环才首次
    // dispatch(setStreaming(true))，而压缩分支在它之前。UI 的 handleSend/autosave 都以 isStreaming 为闸门，
    // 压缩期被当空闲，用户再点发送/编辑/重试会复用同一 AgentLoop 单例再次 run()，造成两路压缩对同一
    // conversationId 并发（appendBatch 非事务 read-modify-write 交错 → 丢批/脏写），且第二次 run 覆盖
    // this.running 与压缩 controller（旧压缩失去 stop 控制）。这里入口即挡住二次 run，从源头杜绝并发重入。
    if (this.running) {
      console.warn('[AgentLoop] run() 被拒绝：上一轮仍在进行（压缩/生成中），忽略本次重入请求。');
      store.dispatch(addNotification({
        type: 'info',
        title: '正在处理中',
        message: '上一条还在生成或压缩历史，请稍候再发送',
        duration: 2500,
      }));
      return;
    }
    this.running = true;
    // ★ R5 修复（问题1）：进入即点亮 isStreaming，让 handleSend/autosave 的 isStreaming 闸门【覆盖整个压缩窗口】，
    // 不再留「压缩期 isStreaming=false 被当空闲」的重入缝隙。下方 while 循环每轮也会 dispatch(true)（幂等无害）。
    store.dispatch(setStreaming(true));
    try {
    // Stage 14: 确保 RULES 已加载
    const { extensionManager } = await import('./extensionManager');
    await extensionManager.loadRulesFromFS().catch(() => { });
    const rootState = store.getState() as RootState;
    const state = rootState.conversation;
    const currentModel = (rootState as any).agentSettings?.currentModel || '';
    const messages: ChatMessage[] = state.messages
      .filter((m: any) => m.role !== 'tool') // tool 结果消息用 agentLoop 内部管理
      .map(toChatMessage);

    // Add user message (skip for edit/retry since message already exists)
    if (!opts?.skipUserMessage) {
      const userMsg = {
        id: generateId(),
        role: 'user' as const,
        content: userMessage,
        contentParts: opts?.contentParts,
        attachments: opts?.attachments,
        timestamp: Date.now(),
        model: currentModel,
      };
      store.dispatch(addMessage(userMsg));
    }
    // Build system prompt with mode context
    const workspaceName = (rootState as any).workspace?.name;
    const currentMode = (rootState as any).agentSettings?.mode || 'planning';
    const maxRounds = currentMode === 'fast' ? 3 : MAX_TOOL_ROUNDS;
    const userContentForApi = opts?.contentParts?.length ? opts.contentParts : userMessage;
    const promptInjection = (rootState as any).settings?.promptInjection;
    const toolsEnabled = promptInjection?.injectTools ?? true;

    const systemPrompt = promptBuilder.build({
      workspaceName: workspaceName || undefined,
      mode: currentMode,
      promptInjection,
    });

    // Apply context compression before sending
    const requestHistory: ChatMessage[] = opts?.skipUserMessage
      ? messages
      : [...messages, { role: 'user', content: userContentForApi }];

    // 用当前模型真实 contextWindow + API 真实 token 数驱动压缩（回退写死上限/字符估算）
    const agentSettingsState = (rootState as any).agentSettings;
    const currentModelOption = agentSettingsState?.availableModels?.find((m: any) => m.id === agentSettingsState?.currentModel);
    const modelContextWindow = currentModelOption?.capabilities?.contextWindow
      || currentModelOption?.contextWindow
      || MAX_CONTEXT_TOKENS;
    // M2-R4（90% 触发 B方案）：压缩触发判定基于「本轮实际将发送的组装请求体」本地 tokenize，
    // 而非上一轮 API 滞后 token。组装 = systemPrompt + tools schema + 全部历史原文（文本 + 图片/附件体积近似）。
    // tools 计入条件对齐实际发送处（line ~422：mode!=='fast' && toolsEnabled && tools.length>0）。
    // 多模态修复（问题2）：历史里非文本 part（图片/附件）会随请求体发送，文本侧 countConversationTokens
    // 计不到，这里用 estimateNonTextPartsTokens 单独累加计入 assembledTokens，避免带图/附件对话组装量偏小、压缩偏晚。
    const requestHistoryText = requestHistory.map(m => ({ role: m.role, content: chatContentToText(m.content) }));
    const systemTokens = estimateTokens(systemPrompt);
    const toolsTokens = (toolsEnabled && currentMode !== 'fast' && this.tools.length > 0)
      ? estimateTokens(JSON.stringify(this.tools))
      : 0;
    const nonTextTokens = requestHistory.reduce((sum, m) => sum + estimateNonTextPartsTokens(m.content), 0);
    const assembledTokens = systemTokens + toolsTokens + countConversationTokens(requestHistoryText) + nonTextTokens;
    // 兜底口径修复（问题1/3）：用上一轮 API 实测 promptTokens（纯输入侧）而非 totalTokens 取 max。
    // totalTokens = prompt_tokens + completion_tokens（含上一轮模型输出），与本轮纯输入侧 assembledTokens 量纲不同，
    // 取 max 会被上一轮 completion 长度污染、系统性高估。promptTokens 才与 assembledTokens 同口径（=实际发送的输入）。
    // 该兜底仅对「本地粗估异常偏小（如 tokenizer 系数偏差、上轮已压缩但本轮全量组装漏算）」场景生效：
    // 正常情况 assembledTokens（本轮全量未压缩）通常更大占主导，兜底不介入。
    const apiRealTokens = (rootState as any).conversation?.tokenUsage?.promptTokens || 0;
    const triggerTokens = Math.max(assembledTokens, apiRealTokens);
    const { compressed, wasCompressed, overLimitWithoutCompression } = compressContext(
      requestHistoryText,
      modelContextWindow,
      triggerTokens,
    );

    // M2-R1: 压缩时优先用 record（多批次结构化摘要）作稳定前缀以命中 prompt cache；
    // 压缩点【追加一个新批次】（appendBatch，已有批次永不重写），注入前缀按渐进式读拼接
    //（末批全文 + 之前批次骨架）。无对话 id / 生成失败时回退到 compressContext 的字符截断。
    //
    // ★ R5 健壮性契约（可中止 + 回到压缩前一刻 + 崩溃恢复），务必维持：
    //   1. 可中止：本批 generateBatch 透传 compressController.signal；用户 stop() 时 abort →
    //      generateBatch 立即返回 null（不傻等 60s），落入下方「batchResult 为假」分支 → 不调 appendBatch。
    //   2. 回到压缩前一刻：generateBatch 失败/中止 → 不进 appendBatch → record 维持压缩前状态（旧批不动）。
    //      此时 recordMd 仍可能是【旧 record 的渐进式前缀】（非空，line ~391 已先算好），那是压缩前的合法快照，
    //      apiHistory 用它作摘要前缀；旧 record 都没有时 recordMd 为 null → 走 compressContext 字符截断回退。
    //      两条路都不丢 store.messages（apiHistory 只是「本轮发送给模型的视图」，不改动 store）。
    //   3. 崩溃恢复：appendBatch 落库是【原子 + 幂等】的——
    //      原子：Electron 走 record:upsert 单条 INSERT...ON CONFLICT DO UPDATE（better-sqlite3 单语句即单事务），
    //            Web 走 writeWebRecord 单次 localStorage.setItem 整对象写入；二者皆「要么整批写入、要么完全没写」。
    //      幂等：appendBatch 要求 stepStart == 末批 stepEnd 才追加（否则脏写拒绝、原样返回旧 record）。
    //      故「generateBatch 成功但 appendBatch 写库中途崩溃」时，要么这批没落库（重启后 getRecord 拿压缩前一致态，
    //      下次压缩从同一 priorSteps 重算本批，不重复不丢）、要么整批已落库（下次压缩 priorSteps 前移、续记下一批）。
    let apiHistory: ChatMessage[];
    if (wasCompressed) {
      const keepCount = compressed.length - 1; // compressContext 保留的最近原文条数（含 tool 口径）
      // R5：为本次压缩生成新建独立中止器，作为【本 run 的局部变量】并登记到实例集合。
      // 局部变量保证归属——不会被并发/重入 run 覆盖引用；登记集合让 stop() 能遍历 abort 到它。
      const compressController = new AbortController();
      this.compressControllers.add(compressController);
      // 问题1 修复：新对话 store.conversation.id 为 null，但 autosave 已把当前对话落到
      // AUTOSAVE_ID('autosave-current')（含 conversations 行，FK 满足），故 record 回退用它，
      // 让新对话的 record 多批次也能触发。（正式保存时 record 迁移到新 id 见 Task_4 小本本。）
      const conversationId = ((rootState as any).conversation?.id as string | null) || AUTOSAVE_ID;
      let recordMd: string | null = null;
      if (conversationId) {
        try {
          const existingRecord = await getRecord(conversationId);

          // 被压缩段 = 去掉「最近 keepCount 条原文」之前的全部历史（含 tool）。
          const keepStartIdx = Math.max(0, requestHistory.length - keepCount);
          const compressedSegment = requestHistory.slice(0, keepStartIdx);

          // ★ step 口径对齐 record（全程不含 tool）：把被压缩段过滤掉 tool 后，
          //   才是 record 应覆盖到的「不含 tool」消息序列；本批 = 该序列里超出末批 stepEnd 的尾部。
          const coveredEligible = compressedSegment.filter(m => m.role !== 'tool');
          const priorSteps = existingRecord?.totalSteps ?? 0;       // = 末批 stepEnd（不含 tool）
          const priorRounds = existingRecord?.totalRounds ?? 0;     // = 末批 roundEnd
          const batchSlice = coveredEligible.slice(priorSteps);     // 本批切片（不含 tool，与上一批不重叠）

          recordMd = existingRecord ? buildRecordPrefix(existingRecord, modelContextWindow) : null;

          if (batchSlice.length > 0) {
            const batchUserCount = batchSlice.filter(m => m.role === 'user').length;
            const roundStart = priorRounds + 1;
            const roundEnd = priorRounds + batchUserCount;
            const stepStart = priorSteps;
            const stepEnd = priorSteps + batchSlice.length;
            // 旧批骨架只读概览：本批之前所有批次的 skeleton 拼接（getRecordSkeleton）。
            const priorSkeleton = existingRecord
              ? await getRecordSkeleton(conversationId)
              : '';

            const batchResult = await generateBatch({
              conversationId,
              messages: batchSlice.map(m => ({
                role: m.role as 'user' | 'assistant' | 'system' | 'tool',
                // ★ M2-R6：record 源用占位版（图片/附件 → 「[图片 name]」），绝不含 base64，且比直接丢弃更可读。
                content: chatContentToTextWithPlaceholder(m.content),
              })),
              priorSkeleton,
              roundStart,
              roundEnd,
              workspaceName: workspaceName || undefined,
            }, compressController.signal); // R5：透传本 run 局部 compressController 的 signal，用户 stop 时立即降级返回 null
            if (batchResult) {
              const updated = await appendBatch({
                conversationId,
                stepStart,
                stepEnd,
                roundStart,
                roundEnd,
                contentMd: batchResult.contentMd,
                skeleton: batchResult.skeleton,
                phases: batchResult.phases,
                timeSpan: batchResult.timeSpan,
              });
              if (updated) {
                recordMd = buildRecordPrefix(updated, modelContextWindow);
                // ★ R5 修复（问题3：record 水位 vs messages 缺口）：appendBatch 已把【本批覆盖到的 step】落库，
                // 但触发本轮压缩的新 user 消息此刻可能还没被 autosave（700ms 防抖 + 压缩期同步占住事件循环，
                // 且压缩成功后立即进 while 重新点亮 isStreaming 关掉 autosave 闸门）。这里主动同步持久化一次
                // store.messages，保证「record 已覆盖的消息」在 DB 里一定存在——否则崩溃恢复后 record 水位会指向
                // messages 里不存在的 step，造成水位错位。持久化失败吞掉（record/autosave 都是加速层，绝不阻塞主对话）。
                try {
                  const liveConversation = (store.getState() as RootState).conversation;
                  await saveAutosaveSnapshot({
                    id: liveConversation.id,
                    title: liveConversation.title,
                    messages: liveConversation.messages,
                    model: currentModel,
                    assistantRuns: liveConversation.assistantRuns,
                    fileSnapshots: liveConversation.fileSnapshots,
                    pendingDiffs: liveConversation.pendingDiffs,
                    timestamp: Date.now(),
                  });
                } catch (saveErr) {
                  console.warn('[agentLoop] 压缩后同步 autosave 失败（不阻塞主对话）:', saveErr);
                }
              }
            }
          }
        } catch (err) {
          console.warn('[agentLoop] record 压缩失败，回退字符截断:', err);
        } finally {
          // R5：本次压缩生成结束（成功/降级/中止/异常）即从集合移除【自己这个】 controller，
          // 只 delete 局部变量，绝不整体置空——避免误清别的在途 run 登记的 controller（归属隔离）。
          this.compressControllers.delete(compressController);
        }
      }
      apiHistory = recordMd
        ? [{ role: 'system', content: `[对话历史摘要]\n\n${recordMd}` } as ChatMessage, ...requestHistory.slice(-keepCount)]
        : [compressed[0] as ChatMessage, ...requestHistory.slice(-(compressed.length - 1))];
      store.dispatch(addNotification({
        type: 'info',
        title: '上下文压缩',
        message: recordMd ? '历史已压缩为 record 摘要' : '对话历史已压缩以保持性能',
        duration: 3000,
      }));
    } else if (overLimitWithoutCompression) {
      // M2-R4 问题4：少条超长危险态——无法切片压缩，对发送体最长文本 part 做截断保护，防撑爆窗口。
      // fixedTokens = systemPrompt + tools + 非文本 part（图片/附件，不可靠裁字符缩小）的固定占用。
      const fixedTokens = systemTokens + toolsTokens + nonTextTokens;
      const threshold = modelContextWindow * COMPRESSION_THRESHOLD;
      apiHistory = truncateOverLongHistory(requestHistory, fixedTokens, threshold);
      store.dispatch(addNotification({
        type: 'warning',
        title: '上下文超长',
        message: '单条消息过长且无法压缩，已截断部分内容以避免超出上下文窗口',
        duration: 4000,
      }));
    } else {
      apiHistory = requestHistory;
    }

    // Prepend system prompt to compressed messages
    let apiMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...apiHistory,
    ];

    // ★ M2-R6 发送前还原：历史 / 当前消息里的 image_url / file part 在 store / DB 中是 sha256 引用态（无 base64），
    // 这里按 sha256 调 platform.attachment.get 还原成真 dataUrl 再发给模型（模型需要真图）。
    // 只还原【实际要发送的这部分】（压缩后 apiHistory 里保留的最近原文）——开销最小，被摘要替代的历史图不白还原。
    // 还原后的真 base64 仅活在本次发送的 apiMessages（局部变量），绝不回写 store / DB。
    // 实体缺失则降级为文字占位（见 restoreApiMessagesAttachments），不阻断发送。失败吞掉走原 apiMessages。
    apiMessages = await restoreApiMessagesAttachments(apiMessages).catch(() => apiMessages);

    // Auto-generate title from first message
    if (!opts?.skipUserMessage && (store.getState() as RootState).conversation.messages.length <= 1) {
      const title = userMessage.slice(0, 30) + (userMessage.length > 30 ? '...' : '');
      store.dispatch(setTitle(title));
    }

    let round = 0;

    while (this.running && round < maxRounds) {
      round++;
      store.dispatch(setStreaming(true));
      store.dispatch(clearStreamingContent());

      let fullContent = '';
      let lastError = '';
      let wasAborted = false;
      const pendingToolCalls: ToolCallRequest[] = [];
      const runId = generateId('run');
      const assistantMessageId = generateId();
      const runStartedAt = Date.now();
      const agentRuntimeSettings = (store.getState() as RootState).agentSettings;
      const showThinking = agentRuntimeSettings.showThinking ?? true;
      const outputStrategy = agentRuntimeSettings.outputStrategy ?? ((agentRuntimeSettings.enableStreaming ?? true) ? 'auto' : 'off');
      const showStreamCursor = outputStrategy !== 'off' && (agentRuntimeSettings.showStreamCursor ?? true);
      const showGeneratingPlaceholder = agentRuntimeSettings.showGeneratingPlaceholder ?? true;
      let streamModeUsed: StreamModeUsed | undefined = outputStrategy === 'pseudo' ? 'pseudo' : outputStrategy === 'off' ? 'off' : undefined;
      let fallbackReason: string | undefined;
      let fallbackNotified = false;
      let streamModeRecorded = false;
      store.dispatch(addAssistantRun({
        id: runId,
        startedAt: runStartedAt,
        model: currentModel,
        status: 'streaming',
        streamMode: streamModeUsed,
        events: [],
      }));
      store.dispatch(addRunEvent({
        id: generateId('evt'),
        runId,
        messageId: assistantMessageId,
        type: 'started',
        timestamp: runStartedAt,
      }));
      store.dispatch(addMessage({
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        timestamp: runStartedAt,
        model: currentModel,
        runId,
        isStreaming: true,
        streamState: 'pending',
        streamMode: streamModeUsed,
        showStreamCursor,
        showGeneratingPlaceholder,
      }));

      const noteStreamMode = (chunkMode?: StreamModeUsed, reason?: string) => {
        if (!chunkMode && !reason) return;
        const modeChanged = !!chunkMode && chunkMode !== streamModeUsed;
        const reasonChanged = !!reason && reason !== fallbackReason;
        if (streamModeRecorded && !modeChanged && !reasonChanged) return;
        if (chunkMode) streamModeUsed = chunkMode;
        if (reason) fallbackReason = reason;
        streamModeRecorded = true;
        store.dispatch(updateMessageMeta({
          id: assistantMessageId,
          changes: {
            streamMode: streamModeUsed,
            fallbackReason,
          },
        }));
        store.dispatch(addRunEvent({
          id: generateId('evt'),
          runId,
          messageId: assistantMessageId,
          type: 'stream_mode',
          timestamp: Date.now(),
          streamMode: streamModeUsed,
          fallbackReason,
        }));
        if (reason && !fallbackNotified) {
          fallbackNotified = true;
          store.dispatch(addNotification({
            type: 'info',
            title: '输出策略已降级',
            message: reason.slice(0, 200),
            duration: 3000,
          }));
        }
      };

      try {
        const stream = this.client.streamChat(
          apiMessages,
          // Fast mode: don't pass tools (no agentic behavior)
          currentMode === 'fast' || !toolsEnabled ? undefined : (this.tools.length > 0 ? this.tools : undefined),
        );

        for await (const chunk of stream) {
          if (!this.running) break;
          noteStreamMode(chunk.streamMode, chunk.fallbackReason);

          if (chunk.type === 'content' && chunk.content) {
            fullContent += chunk.content;
            store.dispatch(appendMessageContent({ id: assistantMessageId, content: chunk.content }));
            store.dispatch(setMessageStreamState({ id: assistantMessageId, streamState: 'streaming', streamMode: streamModeUsed, fallbackReason }));
            store.dispatch(addRunEvent({
              id: generateId('evt'),
              runId,
              messageId: assistantMessageId,
              type: 'content_delta',
              timestamp: Date.now(),
              content: chunk.content,
            }));
          }
          if (chunk.type === 'thinking' && chunk.thinking && showThinking) {
            store.dispatch(appendMessageThinking({ id: assistantMessageId, content: chunk.thinking, status: 'streaming' }));
            store.dispatch(setMessageStreamState({ id: assistantMessageId, streamState: 'streaming', streamMode: streamModeUsed, fallbackReason }));
            store.dispatch(addRunEvent({
              id: generateId('evt'),
              runId,
              messageId: assistantMessageId,
              type: 'thinking_delta',
              timestamp: Date.now(),
              content: chunk.thinking,
            }));
          }
          if (chunk.type === 'tool_call' && chunk.toolCall) {
            pendingToolCalls.push(chunk.toolCall);
            store.dispatch(addRunEvent({
              id: generateId('evt'),
              runId,
              messageId: assistantMessageId,
              type: 'tool_call',
              timestamp: Date.now(),
              toolCallId: chunk.toolCall.id,
            }));
          }
          if (chunk.type === 'error') {
            if (chunk.error === 'aborted') {
              wasAborted = true;
              break;
            }
            lastError = String(chunk.error);
            store.dispatch(setConnectionStatus('failed'));
            console.error('[AgentLoop] Stream error:', chunk.error);
            store.dispatch(addRunEvent({
              id: generateId('evt'),
              runId,
              messageId: assistantMessageId,
              type: 'error',
              timestamp: Date.now(),
              error: lastError,
            }));
          }
          // Stage 5: 捕获 API 返回的真实 token 使用量
          if (chunk.type === 'done' && chunk.usage) {
            store.dispatch(setTokenUsage(chunk.usage));
          }
        }
      } catch (err: any) {
        lastError = err.message || '未知网络错误';
        console.error('[AgentLoop] Exception:', err);
        store.dispatch(addRunEvent({
          id: generateId('evt'),
          runId,
          type: 'error',
          timestamp: Date.now(),
          error: lastError,
        }));
      }

      if (!this.running) wasAborted = true;
      store.dispatch(setStreaming(false));

      if (wasAborted) {
        const abortedAt = Date.now();
        if (!fullContent) {
          store.dispatch(updateMessage({ id: assistantMessageId, content: '已停止生成' }));
        }
        store.dispatch(updateMessageMeta({
          id: assistantMessageId,
          changes: {
            durationMs: abortedAt - runStartedAt,
            thinking: showThinking
              ? {
                content: (store.getState() as RootState).conversation.messages.find((m: any) => m.id === assistantMessageId)?.thinking?.content ?? '',
                startedAt: runStartedAt,
                endedAt: abortedAt,
                durationMs: abortedAt - runStartedAt,
                collapsed: true,
                status: 'error',
              }
              : undefined,
          },
        }));
        store.dispatch(setMessageStreamState({ id: assistantMessageId, streamState: 'aborted', durationMs: abortedAt - runStartedAt, streamMode: streamModeUsed, fallbackReason }));
        store.dispatch(addRunEvent({
          id: generateId('evt'),
          runId,
          messageId: assistantMessageId,
          type: 'aborted',
          timestamp: abortedAt,
        }));
        break;
      }

      // P0-4 修复: 处理 3 种情况
      // 1. 有文本内容（可能附带 tool_calls）
      // 2. 无文本但有 tool_calls（OpenAI 合法情况）
      // 3. 完全空响应（异常）
      if (fullContent || pendingToolCalls.length > 0) {
        store.dispatch(setConnectionStatus('configured'));
        const completedAt = Date.now();
        store.dispatch(updateMessageMeta({
          id: assistantMessageId,
          changes: {
            durationMs: completedAt - runStartedAt,
            streamState: 'complete',
            streamMode: streamModeUsed,
            fallbackReason,
            isStreaming: false,
            toolCalls: pendingToolCalls.length > 0
              ? pendingToolCalls.map(tc => ({
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
                status: 'pending' as const,
              }))
              : undefined,
            thinking: showThinking
              ? {
                ...((store.getState() as RootState).conversation.messages.find((m: any) => m.id === assistantMessageId)?.thinking ?? {
                  content: '',
                  startedAt: runStartedAt,
                  collapsed: true,
                }),
                endedAt: completedAt,
                durationMs: completedAt - runStartedAt,
                status: 'complete',
              }
              : undefined,
          },
        }));
        store.dispatch(setMessageStreamState({ id: assistantMessageId, streamState: 'complete', durationMs: completedAt - runStartedAt, streamMode: streamModeUsed, fallbackReason }));
        store.dispatch(addRunEvent({
          id: generateId('evt'),
          runId,
          messageId: assistantMessageId,
          type: 'done',
          timestamp: completedAt,
        }));
        apiMessages.push({
          role: 'assistant',
          content: fullContent || '',
          tool_calls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
        });
      } else if (lastError) {
        const errorMsg = `⚠️ AI 请求失败: ${lastError}`;
        const errorAt = Date.now();
        store.dispatch(updateMessage({ id: assistantMessageId, content: errorMsg }));
        store.dispatch(setMessageStreamState({ id: assistantMessageId, streamState: 'error', durationMs: errorAt - runStartedAt, error: lastError, streamMode: streamModeUsed, fallbackReason }));
        store.dispatch(addNotification({
          type: 'error',
          title: 'AI 响应错误',
          message: lastError.slice(0, 200),
        }));
        break;
      } else {
        const emptyAt = Date.now();
        store.dispatch(updateMessage({ id: assistantMessageId, content: '⚠️ AI 返回了空响应，请检查模型选择或 API 配置。' }));
        store.dispatch(setMessageStreamState({ id: assistantMessageId, streamState: 'error', durationMs: emptyAt - runStartedAt, error: 'empty_response', streamMode: streamModeUsed, fallbackReason }));
        store.dispatch(addRunEvent({
          id: generateId('evt'),
          runId,
          type: 'error',
          timestamp: emptyAt,
          error: 'empty_response',
        }));
        break;
      }

      // Execute tool calls if any
      if (pendingToolCalls.length > 0 && this.toolExecutor) {
        for (const tc of pendingToolCalls) {
          if (!this.running) break;
          try {
            const args = JSON.parse(tc.function.arguments);
            const result = await this.toolExecutor(tc.function.name, args);
            const fileChanges = consumeTrackedFileChanges();
            for (const change of fileChanges) {
              store.dispatch(recordFileSnapshot(change.snapshot));
              if (assistantMessageId) {
                store.dispatch(addMessageDiff({ messageId: assistantMessageId, diff: change.diff }));
              }
              store.dispatch(addRunEvent({
                id: generateId('evt'),
                runId,
                messageId: assistantMessageId || undefined,
                type: 'file_change',
                timestamp: Date.now(),
                diffId: change.diff.id,
              }));
            }

            store.dispatch(addMessage({
              id: generateId(),
              role: 'tool',
              content: result,
              timestamp: Date.now(),
            }));
            apiMessages.push({
              role: 'tool',
              content: result,
              tool_call_id: tc.id,
            });
          } catch (err: any) {
            const errorResult = `Error: ${err.message}`;
            apiMessages.push({
              role: 'tool',
              content: errorResult,
              tool_call_id: tc.id,
            });
          }
        }
        // Continue loop for next round
        continue;
      }

      // No tool calls = conversation complete
      break;
    }
    } finally {
      // ★ R5 修复（问题1）：无论正常结束 / break / 抛出未捕获异常，都在 finally 统一收尾：
      // 关掉 isStreaming 闸门、清流式残留、释放 running。避免「入口点亮 isStreaming 后中途抛异常」
      // 留下 isStreaming=true + running=true 永久卡死（handleSend/autosave 再也进不来）。
      store.dispatch(clearStreamingContent());
      store.dispatch(setStreaming(false));
      this.running = false;
    }
  }

}

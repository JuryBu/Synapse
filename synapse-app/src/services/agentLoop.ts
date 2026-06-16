/**
 * Agent Loop Engine
 * 多轮工具调用循环，最大 25 轮
 */

import { AIClient, type ChatMessage, type ToolCallRequest } from './aiClient';
import { store, type RootState } from '../store';
import {
  addMessage, updateMessage, updateMessageMeta, appendMessageContent,
  appendMessageThinking, setMessageStreamState, setMessageReconnect, setStreaming,
  clearStreamingContent, setTitle, setTokenUsage,
  addAssistantRun, addRunEvent, addMessageDiff, recordFileSnapshot,
  type AttachmentRef, type MessageContentPart, type StreamModeUsed,
} from '../store/slices/conversation';
import { setConnectionStatus } from '../store/slices/agentSettings';
import { addNotification } from '../store/slices/notifications';
import { promptBuilder, renderOpenFilesSection, compressContext, COMPRESSION_THRESHOLD, estimateTokens, countConversationTokens } from './systemPrompt';
import { getRecord, appendBatch, getRecordSkeleton, type RecordBatch, type SynapseRecord } from './recordStore';
import { generateBatch } from './recordGenerator';
import { runSystemModelOnce } from './systemModelClient';
import { AUTOSAVE_ID, saveAutosaveSnapshot } from './conversationPersistence';
import { generateId } from './ids';
import { consumeTrackedFileChanges } from './fileChangeTracker';
import { restoreApiMessagesAttachments, chatContentToTextWithPlaceholder } from './attachmentRefs';
import { getModelContextWindow } from '../store/selectors/modelSelectors';

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface ToolExecutor {
  /**
   * @param contextId 当前执行上下文 id（worktree 按需 / M3 并行子代理隔离用）：
   *   透传给 toolRegistry.execute，由 worktree 相关工具据此定位「本上下文」的活动 worktree，避免并行串台。
   *   现阶段 = conversationId（含 AUTOSAVE_ID），M3 阶段 = agentId/subagentId。
   */
  (name: string, args: Record<string, any>, contextId?: string): Promise<string>;
}

const MAX_TOOL_ROUNDS = 25;

/**
 * ★ M4-5-S3 工作区感知：<open_files> 注入的打开文件数上限（已决 20）。
 * 超出只列前 20，并标注「等 N 个」，避免几十个 tab 时 prompt 膨胀（M4-5 风险4）。
 */
const OPEN_FILES_LIMIT = 20;

/**
 * ★ M4-5 审查 medium#1：<open_files> 过滤的【非文件视图 tab type 黑名单】。
 * 这些 tab 不对应可读文件，filePath 要么为空（welcome/settings），要么是非文件协议/blob
 * （review='review://changes'、attachment=blob objectUrl）——一律不得注入 <open_files>，
 * 否则误导模型去读不存在/读不了的「文件」，attachment 的 objectUrl 还会随机漂移破坏 cache 前缀。
 */
const NON_FILE_TAB_TYPES = new Set<string>([
  'welcome', 'settings', 'workflow', 'review', 'showcase', 'unsupported', 'attachment',
]);

/** ★ M4-5-S4 自动标题：截断占位字符上限（首条消息立即可见的临时标题）。 */
const TITLE_PLACEHOLDER_CHARS = 30;
/** ★ M4-5-S4 自动标题：系统模型生成目标 ≤15 字，清洗时硬截留余量到此上限，防截断丢字（已决 ~20）。 */
const TITLE_HARD_CHARS = 20;
/** ★ M4-5-S4 自动标题：失败重试次数（已决 1 次）。 */
const TITLE_RETRY = 1;
/** ★ M4-5-S4 自动标题：重试间隔（毫秒，已决 ~800ms）。 */
const TITLE_RETRY_INTERVAL_MS = 800;
/** ★ M4-5-S4 自动标题：生成提示词（≤15 字、仅输出标题、无标点/引号/前缀）。 */
const TITLE_SYSTEM_PROMPT = '你是对话标题助手。只输出一个不超过 15 个汉字的中文短标题概括用户这轮提问的主题，不要任何标点、引号、书名号、前缀或解释，只输出标题本身。';

/**
 * ★ M4-5-S4：清洗系统模型生成的标题。
 * - trim；去掉外层成对引号 / 书名号 / 反引号；去掉「标题：」「Title:」类前缀；去换行只取首行；
 * - 硬截到 TITLE_HARD_CHARS（防超长）。清洗后为空返回 null（调用方据此走降级保留占位）。
 */
function sanitizeTitle(raw: string | null): string | null {
  if (!raw) return null;
  let t = raw.trim();
  if (!t) return null;
  // 只取首行（模型偶尔多吐解释行）
  t = t.split(/\r?\n/)[0].trim();
  // 去掉常见前缀（标题：/ 题目：/ Title:）
  t = t.replace(/^(标题|题目|title)\s*[:：]\s*/i, '').trim();
  // 去掉外层成对引号 / 书名号 / 反引号（可能嵌套，循环剥）
  let changed = true;
  while (changed && t.length >= 2) {
    changed = false;
    const pairs: Array<[string, string]> = [['"', '"'], ["'", "'"], ['「', '」'], ['『', '』'], ['《', '》'], ['`', '`'], ['"', '"'], ["'", "'"]];
    for (const [open, close] of pairs) {
      if (t.startsWith(open) && t.endsWith(close) && t.length > open.length + close.length) {
        t = t.slice(open.length, t.length - close.length).trim();
        changed = true;
        break;
      }
    }
  }
  if (!t) return null;
  if (t.length > TITLE_HARD_CHARS) t = t.slice(0, TITLE_HARD_CHARS);
  return t || null;
}

// ★ M4-2-S2：运行态 id 生成收敛到共享 services/ids.ts（crypto.randomUUID + 回退，保留 prefix），
//   治问题 2b(1) 弱熵同毫秒碰撞。原本地 generateId 已删，调用点签名不变（仍 generateId('run'/'evt'/...)）。

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
 * M2-R4（问题2 多模态低估）→ M4-1（问题4 多模态严重高估治本）：
 * chatContentToText 只取文本 part，但图片/附件 part 会随请求体实际发送并占用 token，
 * 故对【非文本 part】单独折算 token 计入压缩触发判定，避免「带图/附件对话」组装量与触发判定失真。
 *
 * ★★ M4-1 核心口径修正（治本，根治问题4「新对话带图即触发上下文过长截断」）：
 *   传输字节数 ≠ token。旧实现把 base64 data URI 的【编码字符长度】当 token（`url.length * 0.25`）
 *   或把【原始字节数】当 token（`size / 3`），对图片高估约 11~1100 倍——3.9MB 图（base64≈520 万字符）
 *   被估成约 130 万 token，远超阈值 128000 * 0.9 = 115200，撑爆判定后误触发 truncate。
 *   真实情况：网关把图片按【视觉 token】计（与图片体积/base64 长度完全解耦），单图固定量级 85~1100 token。
 *
 * 修正后的口径：
 *   - image_url（data: 内联 / size 引用态 / 外链 http，三条分支统一）：一律走 imageVisionTokens(detail)，
 *     与 base64/字节体积彻底解耦——detail=low → 85，detail=high/auto/未指定 → 1100（OpenAI 视觉 token 量级）。
 *     单图无论多大固定约 1100 token，130 万 → 1100，约降 1100 倍，根治高估。
 *   - file：网关对 file 也是【解码后按内容算 token】，base64 传输长度不是真 token。
 *     故按 estimateFileContentTokens——有 base64 时先解出原始字节数（base64 长度 * 3/4），
 *     再按 FILE_TOKENS_PER_BYTE(0.3) 折算；仅 size 时 size * 0.3；都无走 FILE_ID_PLACEHOLDER_TOKENS。
 * 文本 part 不在此计（由 chatContentToText → countConversationTokens 统一计）。
 */
const IMAGE_TOKENS_LOW = 85;       // detail=low 视觉 token（OpenAI 量级，与图片体积无关）
const IMAGE_TOKENS_HIGH = 1100;    // detail=high/auto/未指定 视觉 token 上界近似（与图片体积无关）
const FILE_ID_PLACEHOLDER_TOKENS = 256; // 仅有 file_id（内容不可见）时的保守占位估值
/**
 * 文件内容 token / 原始字节系数：网关解码 base64 后按内容算 token，
 * 混合文本约 0.3 token/字节（英文真实约 0.25，取 0.3 保守上界，宁多勿少，方向与触发判定一致）。
 */
const FILE_TOKENS_PER_BYTE = 0.3;

/** 图片视觉 token：与 base64/字节体积完全解耦，仅由 detail 决定（low=85，high/auto/未指定=1100）。 */
function imageVisionTokens(detail?: string): number {
  return detail === 'low' ? IMAGE_TOKENS_LOW : IMAGE_TOKENS_HIGH;
}

/**
 * 文件内容 token 估算：网关解码后按内容算 token，传输 base64 长度不是真 token。
 *   - 有 base64（file_data/data，可能带 `data:...;base64,` 前缀）：剥头取 payload 长度 → 原始字节 ≈ 长度*3/4
 *     → token ≈ 原始字节 * FILE_TOKENS_PER_BYTE。零解码开销（只取长度不真解码）。
 *   - 仅 size（原始字节）：size * FILE_TOKENS_PER_BYTE。
 *   - 都无：FILE_ID_PLACEHOLDER_TOKENS 占位。
 */
function estimateFileContentTokens(data: string, size: number): number {
  if (data) {
    // 剥掉 `data:...;base64,` 头（与 attachmentRefs 的 comma 切法一致，但只取长度不解码，零开销）
    const commaIdx = data.indexOf(',');
    const b64Len = data.startsWith('data:') && commaIdx >= 0 ? data.length - commaIdx - 1 : data.length;
    const rawBytes = b64Len * 0.75; // base64 长度 * 3/4 ≈ 原始字节
    return Math.ceil(rawBytes * FILE_TOKENS_PER_BYTE);
  }
  if (size > 0) return Math.ceil(size * FILE_TOKENS_PER_BYTE);
  return FILE_ID_PLACEHOLDER_TOKENS;
}

function estimateNonTextPartsTokens(content: ChatMessage['content']): number {
  if (typeof content === 'string') return 0;
  let total = 0;
  for (const part of content as any[]) {
    if (!part || part.type === 'text') continue;
    if (part.type === 'image_url') {
      // 三条分支（data: 内联 / size 引用态 / 外链 http）统一走视觉固定值，与体积彻底解耦。
      total += imageVisionTokens(part.image_url?.detail);
    } else if (part.type === 'file') {
      const data: string = part.file?.file_data || part.file?.data || '';
      const size: number = typeof part.file?.size === 'number' ? part.file.size : 0;
      total += estimateFileContentTokens(data, size);
    }
  }
  return total;
}

/** 截断标记：超长单条被截断时插入，提示模型该消息内容已被裁剪。 */
const TRUNCATION_NOTICE = '\n\n[…内容过长，已截断以避免超出上下文窗口…]';

/**
 * M4-1-S4 护栏：truncate 时给文本侧的最小预算保底（token）。
 * 即便 fixedTokens 已逼近 threshold（budget 算出来 ≤ 0），也至少给当前消息留 1024 token 正文，
 * 宁可总量略超阈值也不发空消息（标准网关按真实 token 计、估算略超不影响）。
 */
const MIN_TEXT_BUDGET = 1024;

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
  // M4-1-S4：budget 最小保底——即便 fixedTokens 逼近 threshold（budget ≤ 0），也至少给文本留 MIN_TEXT_BUDGET，
  // 保证再极端也不把当前消息正文截成空（宁可略超阈值也不发空消息）。
  let budget = Math.max(threshold - fixedTokens, MIN_TEXT_BUDGET);
  // 文本侧可用预算（给文本 part 的总额度）
  if (textTotal <= budget) return messages; // 固定占用已把超额吃掉，文本无需截断

  // M4-1-S4 当前消息保护：最后一条即本轮「当前消息」。若它自身文本 token < budget（不是超长的元凶），
  // 则绝不截它——只截更早的历史长文本。仅当当前消息自身就超 budget（单条巨型粘贴）时才允许截它（否则无法压回）。
  const currentIdx = messages.length - 1;
  const protectCurrent = currentIdx >= 0 && textTokensOf(messages[currentIdx]) < budget;

  // 找最长文本消息，按比例把它截到「让文本总量回到预算」所需的目标长度。
  // 一次只截最长的一条通常够用（少条超长场景往往是单条巨型粘贴）；循环兜底处理多条都很长的情况。
  const result = messages.map(m => ({ ...m })) as ChatMessage[];
  let truncatedAny = false;
  for (let guard = 0; guard < result.length && textTotal > budget; guard++) {
    // 选当前文本最长的一条（受保护的当前消息排除在候选外）
    let idx = -1;
    let maxTok = -1;
    for (let i = 0; i < result.length; i++) {
      if (protectCurrent && i === currentIdx) continue; // 保护当前消息：不参与截断选择
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

/** record 注入批拼接分隔符 */
const BATCH_JOIN = '\n\n---\n\n';

/**
 * ★ M4-5-S2 prompt cache 稳定化：稳定渲染头部全文批数（最老 N 批）。
 * 方案 B 固定规则：头 N 批全文 + 其余批一律骨架（带 record_read 可展开标注）。
 * 取 2（合理小值）：保住开头背景与早期关键决策，其余走骨架确定性渲染、cache 友好。
 *
 * ★ M4-5-S2 删死代码说明：原 buildRecordPrefix（按 contextWindow 预算动态骨架↔全文升降级）是
 *   prompt-cache 前缀漂移真因，已被 buildStableRecordPrefix 全量取代、无任何调用方，连同其独占的
 *   RECORD_HEAD_FULL / RECORD_TAIL_FULL / RECORD_BUDGET_RATIO 常量一并删除。record_read 工具的按需
 *   单批展开是独立路径（不经此函数），功能不回退。renderSkeletonBatch 仍由稳定版复用故保留。
 */
const STABLE_HEAD_FULL = 2;

/**
 * ★ M4-5-S2：压缩注入到 apiMessages[1] 的固定文案前缀（常量化，确保前缀字符串本身永不漂移）。
 * 与 buildStableRecordPrefix 的确定性渲染配合，让「record 批集合不变 → apiMessages[1].content 逐字不变」。
 */
const RECORD_INJECTION_PREFIX = '[对话历史摘要]\n\n';

/** 渲染一个被降级为骨架的批次：明确标注可用 record_read 展开全文 */
function renderSkeletonBatch(batch: RecordBatch): string {
  const skeleton = (batch.skeleton || '').trim();
  const header = `[批次${batch.index} 骨架，可用 record_read(batchIndex=${batch.index}) 展开全文]`;
  return skeleton ? `${header}\n${skeleton}` : header;
}

/**
 * ★ M4-5-S2 prompt cache 稳定化：record 注入前缀的【确定性渲染】版本（已落批确定性形态）。
 *
 * 真因（被本函数根治）：原 buildRecordPrefix 按 contextWindow 预算在【骨架 ↔ 全文】之间动态升降级
 *   （line 274-282 markFull 受 budget 约束），导致同一 record 在「窗口 / 批数」变化时渲染不同 →
 *   压缩注入拼到 apiMessages[1] 的前缀漂移 → prompt cache 失效。
 *
 * 修法 = 与窗口预算彻底解耦的固定规则（方案 B）：
 *   - 头 STABLE_HEAD_FULL 批（最老）全文：保住开头背景与早期关键决策。
 *   - 其余所有批一律骨架：渲染规则固定（renderSkeletonBatch，带 record_read 可展开标注，功能不回退）。
 *   - 完全不接受 contextWindow / 不跑 RECORD_BUDGET_RATIO / 不做任何动态升降级。
 *
 * 由此「record 批集合不变（contentMd / skeleton / index 不变）」时，本函数输出【逐字不变】——
 * apiMessages[1] 前缀稳定，是 cache 命中的前提（端点是否真命中由端点决定，见 Plan_5 openQuestion 5）。
 *
 * 边界（与 buildRecordPrefix 同口径，保确定性）：
 *   - 零批 → record.contentMd（旧单文档态兼容）。
 *   - 单批 → 该批全文。
 *
 * 服务对象：自动压缩（现有 ~90% 水位）与未来 /compact 手动压缩共用此稳定前缀。
 */
function buildStableRecordPrefix(record: SynapseRecord): string {
  const batches = record.batches ?? [];
  if (batches.length === 0) return record.contentMd ?? '';
  if (batches.length === 1) return batches[0].contentMd;

  // 固定规则：批序位 < STABLE_HEAD_FULL 的（最老 N 批）走全文，其余一律骨架。
  // 仅依赖批在数组中的位置与各批内容，不依赖 contextWindow / 批数预算 → 确定性。
  return batches
    .map((b, i) => (i < STABLE_HEAD_FULL ? b.contentMd : renderSkeletonBatch(b)))
    .filter(Boolean)
    .join(BATCH_JOIN);
}

export class AgentLoop {
  private client: AIClient;
  private tools: ToolDefinition[] = [];
  private toolExecutor: ToolExecutor | null = null;
  private running = false;
  /**
   * M2-5 / M3：本 AgentLoop 实例的【执行上下文 id】。
   * - 单 agent（主对话）：构造时不传 → 执行工具时回退当前对话 id（conversation.id ?? AUTOSAVE_ID），
   *   worktree 活动态随对话身份走，与「切换对话不串台」配套。
   * - M3 子代理：构造时传 subagentId → 每个子代理实例各自一个稳定 contextId，并行 enter_worktree 互不覆盖。
   */
  private readonly contextId?: string;
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

  constructor(client: AIClient, opts?: { contextId?: string }) {
    this.client = client;
    this.contextId = opts?.contextId;
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

    // ★ M4-5-S3 工作区感知：从 editorTabs 读当前打开的【文件 tab】，过滤非文件视图后映射为 openFiles 概要。
    //   - 只取路径/名/类型，绝不读正文（正文走读文件工具按需取）。
    //   - 上限 OPEN_FILES_LIMIT(20)：超出只列前 20，追加一个「等 N 个」占位项（path/type 空，渲染时优雅省略）。
    //   ★ M4-5 审查 medium#1：过滤判据从「filePath 非空」收紧为「filePath 非空 且 type 不属于非文件视图」。
    //     根因：原假设「非文件视图 filePath 必为空」与代码现实不符——review tab 的 filePath='review://changes'、
    //     attachment tab 的 filePath=blob objectUrl，均非空，会绕过原过滤被当成「可读文件」注入 <open_files>，
    //     诱导模型调读文件工具去读不存在的 review:// 协议 / 读不了的 blob URL；且 objectUrl 每次打开都变，
    //     会让该段内容随机漂移、进一步破坏 cache 前缀稳定性。故按 type 黑名单一并排除这些非文件视图 tab。
    const editorTabs = (rootState as any).editorTabs;
    const activeTabId: string | null = editorTabs?.activeTabId ?? null;
    const allTabs: Array<{ id: string; filePath?: string; fileName?: string; type?: string }> = Array.isArray(editorTabs?.tabs) ? editorTabs.tabs : [];
    const fileTabs = allTabs.filter(t =>
      typeof t.filePath === 'string'
      && t.filePath.trim().length > 0
      && !NON_FILE_TAB_TYPES.has(t.type ?? ''),
    );
    const activeTab = activeTabId ? fileTabs.find(t => t.id === activeTabId) : undefined;
    const activeFilePath = activeTab?.filePath || undefined;
    const openFiles = fileTabs.slice(0, OPEN_FILES_LIMIT).map(t => ({
      path: t.filePath as string,
      name: t.fileName || (t.filePath as string),
      type: t.type || 'file',
    }));
    if (fileTabs.length > OPEN_FILES_LIMIT) {
      // 溢出占位项：name 承载「等 N 个」提示，path/type 留空（systemPrompt 渲染时省略方括号与第二行）。
      openFiles.push({ path: '', name: `…等 ${fileTabs.length - OPEN_FILES_LIMIT} 个文件未列出`, type: '' });
    }

    const systemPrompt = promptBuilder.build({
      workspaceName: workspaceName || undefined,
      mode: currentMode,
      promptInjection,
    });

    // ★ M4-5 审查 medium#2：<open_files> 不再进 system prompt(apiMessages[0])，改注入 messages【最末尾】。
    //   渲染受 injectContext 控制（与原 systemPrompt 内部 gating 等价）。空串表示无可注入项。
    //   实际拼接到最后一条 user 消息见下方 apiMessages 组装后（restore 之后）。
    const injectOpenFiles = promptInjection?.injectContext ?? true;
    const openFilesSection = injectOpenFiles ? renderOpenFilesSection(
      openFiles.length > 0 ? openFiles : undefined,
      activeFilePath,
    ) : '';

    // Apply context compression before sending
    const requestHistory: ChatMessage[] = opts?.skipUserMessage
      ? messages
      : [...messages, { role: 'user', content: userContentForApi }];

    // 用当前模型真实 contextWindow + API 真实 token 数驱动压缩（回退写死上限/字符估算）。
    // M4-1-S3：统一走 getModelContextWindow 选择器（capabilities.contextWindow ?? option.contextWindow ?? MAX_CONTEXT_TOKENS），
    // 与 StatusBar / AgentPanel 同一真相源，消除本地三元 fallback 不一致。
    const modelContextWindow = getModelContextWindow(rootState);
    // M2-R4（90% 触发 B方案）：压缩触发判定基于「本轮实际将发送的组装请求体」本地 tokenize，
    // 而非上一轮 API 滞后 token。组装 = systemPrompt + tools schema + 全部历史原文（文本 + 图片/附件体积近似）。
    // tools 计入条件对齐实际发送处（line ~422：mode!=='fast' && toolsEnabled && tools.length>0）。
    // 多模态修复（问题2）：历史里非文本 part（图片/附件）会随请求体发送，文本侧 countConversationTokens
    // 计不到，这里用 estimateNonTextPartsTokens 单独累加计入 assembledTokens，避免带图/附件对话组装量偏小、压缩偏晚。
    const requestHistoryText = requestHistory.map(m => ({ role: m.role, content: chatContentToText(m.content) }));
    // ★ M4-5 审查 medium#2：<open_files> 已从 systemPrompt 挪到 messages 末尾，systemTokens 不再涵盖它；
    //   但它仍随请求体发送、占用输入 token，故单独把 openFilesSection 的 token 计入估算口径，保持组装量准确。
    const systemTokens = estimateTokens(systemPrompt) + estimateTokens(openFilesSection);
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
    // M4-1-S4 护栏入参：除最后一条（本轮当前消息）外的历史文本 token，与 compressContext 内同口径
    // （countConversationTokens）。仅历史本身也接近阈值才标 overLimitWithoutCompression，避免误截当前消息。
    const historyOnlyTokens = countConversationTokens(requestHistoryText.slice(0, -1));
    const { compressed, wasCompressed, overLimitWithoutCompression } = compressContext(
      requestHistoryText,
      modelContextWindow,
      triggerTokens,
      historyOnlyTokens,
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

          // ★ M4-5-S2：压缩注入改用确定性稳定前缀（不随 contextWindow 动态升降级），杜绝 apiMessages[1] 前缀漂移。
          recordMd = existingRecord ? buildStableRecordPrefix(existingRecord) : null;

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
                // ★ M4-5-S2：同样走稳定前缀，与上方分支口径一致，保证注入前缀确定性。
                recordMd = buildStableRecordPrefix(updated);
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
        // ★ M4-5-S2：前缀文案常量化（RECORD_INJECTION_PREFIX），与确定性 recordMd 配合保证 apiMessages[1] 逐字稳定。
        ? [{ role: 'system', content: `${RECORD_INJECTION_PREFIX}${recordMd}` } as ChatMessage, ...requestHistory.slice(-keepCount)]
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
    const restoreResult = await restoreApiMessagesAttachments(apiMessages)
      .catch(() => ({ messages: apiMessages, skippedInvalidImages: 0 }));
    apiMessages = restoreResult.messages;

    // ★ M4-5 审查 medium#2：把 <open_files> 注入到整个 messages 数组【最末尾的最后一条 user 消息】内，
    //   而非 system prompt(apiMessages[0]) 末尾。这样 system prompt + record 摘要(apiMessages[1]) + 旧历史
    //   构成的稳定大前缀不受切 tab 影响，prompt cache 严格前缀匹配得以命中（与 S2 record 稳定化收益叠加）。
    //   注入在 attachment 还原之后：仅追加一个文本 part / 文本片段，不触碰已还原的 image_url / file part。
    //   ★ 绝不原地 mutate：apiMessages 元素可能是 store message 对象的浅拷贝引用，直接改 .content 会污染 store。
    //     故定位到目标消息后【替换为新对象】，新 content 仅活在本次发送的局部 apiMessages。
    if (openFilesSection) {
      for (let i = apiMessages.length - 1; i >= 0; i--) {
        const msg = apiMessages[i];
        if (msg.role !== 'user') continue;
        if (typeof msg.content === 'string') {
          apiMessages[i] = { ...msg, content: `${msg.content}\n\n${openFilesSection}` };
        } else if (Array.isArray(msg.content)) {
          apiMessages[i] = { ...msg, content: [...msg.content, { type: 'text', text: `\n\n${openFilesSection}` }] };
        }
        break; // 只注入最后一条 user 消息
      }
    }
    // ★ M2-S 任务1：发送前图片有效性预检剔除了无效图（损坏/非图片字节），提示用户——
    // 避免「历史里混进一张坏图 → 上游对整条请求整体 400 → 有效图与正常对话一起被拖垮」。
    if (restoreResult.skippedInvalidImages > 0) {
      store.dispatch(addNotification({
        type: 'warning',
        title: '已跳过无效图片',
        message: `${restoreResult.skippedInvalidImages} 张无效图片已跳过（损坏或非图片格式），不影响本次发送`,
        duration: 4000,
      }));
    }

    // ★ M4-5-S4 自动标题（截断占位 + 异步系统模型语义标题）：
    //   1. 首条消息立即设【截断占位】标题（即时可见，不依赖任何网络）。
    //   2. 截断占位后【fire-and-forget】调系统模型生成 ≤15 字语义标题，成功清洗后回写、失败 retry 1 次、
    //      最终降级保留截断占位。★铁律：绝不 await——标题异步绝不阻塞首轮流式回复。
    //   3. 竞态守卫：回写前比对发起时的 conversation.id 快照一致 + 标题仍是占位（未被用户手改），否则不覆盖。
    //   4. 首条纯图片/附件（无可概括文本）：降级保留占位，不调系统模型。
    if (!opts?.skipUserMessage && (store.getState() as RootState).conversation.messages.length <= 1) {
      const placeholderTitle = userMessage.slice(0, TITLE_PLACEHOLDER_CHARS)
        + (userMessage.length > TITLE_PLACEHOLDER_CHARS ? '...' : '');
      store.dispatch(setTitle(placeholderTitle));

      // 仅当首条有可概括文本时才异步生成（纯图片/附件无文本 → 保留占位降级）。
      const titleSource = userMessage.trim();
      if (titleSource) {
        // 发起时快照：用于回写竞态守卫（对话已切换/清空则不回写）。
        const conversationIdSnapshot = (store.getState() as RootState).conversation.id;
        // ★ fire-and-forget：包在自执行 async IIFE，void 丢弃 promise，绝不被主流式 await。
        void (async () => {
          const prompt = `请为下面这轮用户提问拟一个不超过 15 个汉字的中文标题，只输出标题：\n\n${titleSource.slice(0, 2000)}`;
          let generated: string | null = null;
          for (let attempt = 0; attempt <= TITLE_RETRY; attempt++) {
            generated = sanitizeTitle(await runSystemModelOnce(prompt, { system: TITLE_SYSTEM_PROMPT }));
            if (generated) break;
            if (attempt < TITLE_RETRY) await new Promise(r => setTimeout(r, TITLE_RETRY_INTERVAL_MS));
          }
          if (!generated) return; // 全失败 → 保留已设的截断占位（不再 dispatch）

          // 竞态守卫：回写前再读 live conversation——
          //   - id 必须与发起时快照一致（对话未切换/未清空）；
          //   - 当前标题必须仍是占位（未被用户在生成期间手动改过），否则尊重用户手改、不覆盖。
          const live = (store.getState() as RootState).conversation;
          if (live.id !== conversationIdSnapshot) return;
          if (live.title !== placeholderTitle) return;
          store.dispatch(setTitle(generated));
        })();
      }
    }

    // ★ M4-8-S4 端到端计时：记录本次 agent loop 的起点（用户发出此刻）。
    // 端到端总耗时 = loop 全程（含多轮工具调用）完成时的 now - loopStartedAt，
    // 只挂在【最终完成消息】那一条上（finalCompletedAssistantId），不在每条 run 上重复（Plan_5 风险四）。
    // 逐条 run 计时仍走各自 runStartedAt → durationMs，互不干扰。
    const loopStartedAt = Date.now();
    // 最终给出答复的 assistant 消息 id：每次「成功完成」分支更新；正常结束（无工具调用 break）时它就是最终答复。
    // 中止 / 错误 / 空响应分支不更新它（那几种结束态已有 Stopped / 错误态，不挂端到端徽标）。
    let finalCompletedAssistantId: string | null = null;
    // 标记 loop 是否「自然完成」（最终一轮无工具调用、正常给出答复）。仅此态才挂端到端徽标——
    // 避免「工具轮成功后用户中止」这种 finalCompletedAssistantId 指向非最终答复的轮次时误挂。
    let completedNaturally = false;

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
      // M4-8-S3：本轮重连进度展示位置 = 气泡内「reconnect i/N」（主推）+ StatusBar checking（已有）。
      // 按 Plan_5 决策4，去掉原 M2-S 那条持续 notification（避免气泡 + 状态栏 + 通知三处冗余）。
      // reconnectShown 标记本轮气泡是否正显示重连进度，用于收尾兜底 clear。
      let reconnectShown = false;
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

        // M4-8-S3：重试已恢复（收到任何实质数据）则清掉气泡「reconnect i/N」提示，避免残留。
        const clearRetryNotice = () => {
          if (reconnectShown) {
            reconnectShown = false;
            store.dispatch(setMessageReconnect({ id: assistantMessageId, reconnect: null }));
          }
        };

        for await (const chunk of stream) {
          if (!this.running) break;
          noteStreamMode(chunk.streamMode, chunk.fallbackReason);

          // M4-8-S3：重连进度可观测——aiClient 在每次退避重试【前】发该事件（流式 real 与非流式 off/pseudo 同源）。
          // 写气泡瞬态 reconnect 字段（MessageBubble 渲染「reconnect i/N」）+ StatusBar checking。
          // 按决策4去掉了持续 notification（不再三处冗余）。
          if (chunk.type === 'retry' && chunk.retry) {
            const { attempt, maxRetries } = chunk.retry;
            store.dispatch(setConnectionStatus('checking'));
            reconnectShown = true;
            store.dispatch(setMessageReconnect({
              id: assistantMessageId,
              reconnect: { attempt, max: maxRetries },
            }));
            // M4-8 审查修复（问题2/3）：真流式读流中途断线重试，重发会让模型从头重生成整段回复。
            // aiClient 在本轮已 yield 过实质内容时会带 resetContent，要求先丢弃本轮已上屏/已累积内容，
            // 让重试后的新流覆盖而非追加，杜绝「半截旧 + 完整新」拼接污染气泡与 conversation history。
            if (chunk.resetContent) {
              fullContent = '';
              store.dispatch(updateMessage({ id: assistantMessageId, content: '' }));
              store.dispatch(updateMessageMeta({ id: assistantMessageId, changes: { thinking: undefined } }));
            }
            continue;
          }

          if (chunk.type === 'content' && chunk.content) {
            clearRetryNotice();
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
            clearRetryNotice();
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
      // M4-8-S3：本轮收尾兜底清气泡「reconnect i/N」（成功/失败/中止/异常任一路径都清，不残留）。
      if (reconnectShown) {
        reconnectShown = false;
        store.dispatch(setMessageReconnect({ id: assistantMessageId, reconnect: null }));
      }

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
        // ★ M4-8-S4：记录本轮成功完成的 assistant 消息——若本轮无后续工具调用（下方 break），它就是最终答复，
        //   循环结束后给它挂端到端总计时徽标。有工具调用则 continue 进下一轮，本变量被下一轮覆盖。
        finalCompletedAssistantId = assistantMessageId;
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
        // M2-5 / M3：本轮工具执行的上下文 id。优先实例 contextId（M3 子代理各自固定），
        // 否则回退【执行此刻】的当前对话 id ?? AUTOSAVE_ID——worktree 活动态随对话身份走，
        // 与「切换对话清 worktree（不串台）」配套，且新对话（id=null）也有稳定键 AUTOSAVE_ID。
        const execContextId = this.contextId
          || ((store.getState() as RootState).conversation?.id as string | null)
          || AUTOSAVE_ID;
        for (const tc of pendingToolCalls) {
          if (!this.running) break;
          try {
            const args = JSON.parse(tc.function.arguments);
            const result = await this.toolExecutor(tc.function.name, args, execContextId);
            // ★ medium#3/#5：按 execContextId 消费自己桶的改动，杜绝与并行子代理/其它上下文串台。
            const fileChanges = consumeTrackedFileChanges(execContextId);
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
      completedNaturally = true;
      break;
    }

    // ★ M4-8-S4：loop 自然完成（最终一轮无工具调用）→ 给最终答复消息挂端到端总计时徽标。
    //   只挂这一条（finalCompletedAssistantId），含本轮所有工具调用全程的总耗时；逐条 run 计时不受影响。
    //   中止 / 错误 / 达轮次上限等非自然完成态不挂（completedNaturally=false）。
    if (completedNaturally && finalCompletedAssistantId) {
      store.dispatch(updateMessageMeta({
        id: finalCompletedAssistantId,
        changes: { endToEndMs: Date.now() - loopStartedAt },
      }));
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

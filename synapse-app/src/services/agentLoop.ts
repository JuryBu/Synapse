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
  addAssistantRun, addRunEvent, addMessageDiff, addMessageArtifact, recordFileSnapshot, updateToolCallStatus,
  type AttachmentRef, type MessageContentPart, type StreamModeUsed,
} from '../store/slices/conversation';
import { setConnectionStatus, type RecordLayeringConfig } from '../store/slices/agentSettings';
import { addNotification } from '../store/slices/notifications';
import { promptBuilder, renderOpenFilesSection, compressContext, COMPRESSION_THRESHOLD, estimateTokens, countConversationTokens } from './systemPrompt';
import { getRecord, appendBatch, getRecordSkeleton, extractSkeletonTitle, foldOldBatches, type RecordBatch, type SynapseRecord } from './recordStore';
import { identifyRounds, floorStepToRoundStart } from './roundBoundary';
import { generateBatch } from './recordGenerator';
import { runSystemModelOnce } from './systemModelClient';
import { AUTOSAVE_ID, saveAutosaveSnapshot, renameConversation } from './conversationPersistence';
import { updateConversation } from '../store/slices/conversationHistory';
import { generateId } from './ids';
import { consumeTrackedFileChanges } from './fileChangeTracker';
import { consumeTrackedArtifacts } from './artifactTracker';
import { restoreApiMessagesAttachments, chatContentToTextWithPlaceholder } from './attachmentRefs';
import { getModelContextWindow } from '../store/selectors/modelSelectors';
import { bpcScheduler } from './bpcScheduler';

/**
 * ★ M5-BPC-4：解析生效硬压缩阈值 = 本对话覆盖 ?? 全局 agentSettings.bpc.compactThreshold ?? COMPRESSION_THRESHOLD(0.9)。
 *   number override 一律 typeof + Number.isFinite 判定（绝不 x || fallback，防 0/NaN falsy 吞掉合法值），口径与
 *   bpcScheduler.effectiveBpcThreshold 一致。供 run() 下推 compressContext / overLimit truncate / BPC 边界判定。
 */
function resolveCompactThreshold(rootState: RootState): number {
  const override = (rootState as any).conversation?.compactThresholdOverride;
  if (typeof override === 'number' && Number.isFinite(override)) return override;
  const cfg = (rootState as any).agentSettings?.bpc?.compactThreshold;
  if (typeof cfg === 'number' && Number.isFinite(cfg)) return cfg;
  return COMPRESSION_THRESHOLD;
}

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

/**
 * ★ M7-F1：从一段文本生成语义标题（≤15 字）。抽自自动标题 IIFE，让【自动标题（首条消息）】与
 *   【手动重新生成标题（ConversationList 按钮）】共用同一生成内核，行为一致。
 *   失败（系统模型未返回 / 全部重试失败）返回 null，调用方据此降级/提示。不做任何 dispatch（纯生成）。
 */
export async function generateTitleFromText(source: string): Promise<string | null> {
  const titleSource = (source ?? '').trim();
  if (!titleSource) return null;
  const prompt = `请为下面这轮用户提问拟一个不超过 15 个汉字的中文标题，只输出标题：\n\n${titleSource.slice(0, 2000)}`;
  let generated: string | null = null;
  for (let attempt = 0; attempt <= TITLE_RETRY; attempt++) {
    generated = sanitizeTitle(await runSystemModelOnce(prompt, { system: TITLE_SYSTEM_PROMPT }));
    if (generated) break;
    if (attempt < TITLE_RETRY) await new Promise(r => setTimeout(r, TITLE_RETRY_INTERVAL_MS));
  }
  return generated;
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
// ★ M5-RL：record 分层默认值（与 agentSettings.recordLayering 初值一致）。buildStableRecordPrefix 的
//   layering 参缺失 / 旧持久化无此字段时按此兜底，保证渲染不崩，且未配置时行为与改造前一致（headFull=2）。
const DEFAULT_LAYERING: RecordLayeringConfig = {
  headFull: 2, tailFull: 1, titleThreshold: 20, maxRatio: 0.4, foldThreshold: 30, foldBatchK: 10,
};

/**
 * ★ M4-5-S2：压缩注入到 apiMessages[1] 的固定文案前缀（常量化，确保前缀字符串本身永不漂移）。
 * 与 buildStableRecordPrefix 的确定性渲染配合，让「record 批集合不变 → apiMessages[1].content 逐字不变」。
 */
const RECORD_INJECTION_PREFIX = '[对话历史摘要]\n\n';

/** 渲染一个被降级为骨架的批次：明确标注可用 record_read 展开全文。
 *  ★ R-L2：titleOnly=true 时进一步降级为【仅标题】骨架（extractSkeletonTitle 实时提 contentMd，约 1/3 量纲）。 */
function renderSkeletonBatch(batch: RecordBatch, titleOnly = false): string {
  const skeleton = titleOnly
    ? extractSkeletonTitle(batch.contentMd || '').trim()
    : (batch.skeleton || '').trim();
  const kind = titleOnly ? '标题' : '骨架';
  const header = `[批次${batch.index} ${kind}，可用 record_read(batchIndex=${batch.index}) 展开全文]`;
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
/**
 * ★ R-L4：从全量 batches 算出【注入视图批序列】——过滤 archived 原始批（已被 meta 元批代表，不进注入），
 *   保留 meta 元批，按【代表位置 stepStart 升序】重排（元批 index = 末批+1 排数组物理尾，但其 stepStart 最小、
 *   代表最老内容，必须排回头部才能走档1头全文而非被误当尾批渲全文）。getRecord/getBatch/record_read/UI 读全量。
 */
function injectionViewBatches(record: SynapseRecord): RecordBatch[] {
  return (record.batches ?? [])
    .filter(b => !b.archived)
    .sort((a, b) => (a.stepStart - b.stepStart) || (a.index - b.index));
}

/**
 * ★ R-L2/R-L4/R-L5 共用渲染核心：三级分层渲染注入前缀。
 *   forceTitleOnlyCount = R-L5 token 硬闸的【强制降级游标】：从中段最老批起，额外强制把这么多批降 titleOnly
 *   （叠加在档3 的自然 titleThreshold 降级之上，取 max）。默认 0 = 纯三级分层（buildStableRecordPrefix 行为）。
 *   ★ forceTitleOnlyCount=0 时输出与改造前逐字一致（prompt cache 稳定路径，绝不引入 token/窗口依赖）。
 */
function renderRecordPrefix(
  record: SynapseRecord,
  layering: Partial<RecordLayeringConfig> | undefined,
  forceTitleOnlyCount: number,
): string {
  const cfg = { ...DEFAULT_LAYERING, ...(layering ?? {}) };
  const H = Math.max(0, Math.floor(cfg.headFull));
  const T = Math.max(0, Math.floor(cfg.tailFull));

  const batches = injectionViewBatches(record);
  if (batches.length === 0) return record.contentMd ?? '';
  if (batches.length === 1) {
    // 单批：R-L5 极端兜底允许把唯一批也降 titleOnly（forceTitleOnlyCount>0 时），否则全文。
    return forceTitleOnlyCount > 0
      ? renderSkeletonBatch(batches[0], true)
      : batches[0].contentMd;
  }

  const N = batches.length;
  const force = Math.max(0, Math.floor(forceTitleOnlyCount));

  // 边界：头尾全文区间已覆盖全部（N <= H+T）→ 全批全文（无 force 时）；force>0 时把最老 force 批降 titleOnly。
  if (N <= H + T) {
    if (force <= 0) return batches.map(b => b.contentMd).filter(Boolean).join(BATCH_JOIN);
    return batches
      .map((b, i) => (i < force ? renderSkeletonBatch(b, true) : b.contentMd))
      .filter(Boolean)
      .join(BATCH_JOIN);
  }

  // ★ R-L2 三级分层（仅依赖批序位 i 与总批数 N，force=0 时绝不读 contextWindow/token → prompt cache 确定性）：
  //   档1 序位 i<H：头全文（最老背景/关键决策）。
  //   档2 序位 i>=N-T：尾全文（最近上下文，主人拍板 T=1）。
  //   档3 中间批骨架；中间批数 > titleThreshold 时，把最老一段 [H, titleOnlyEnd) 降 titleOnly（仅标题）。
  const midCount = N - H - T;
  const naturalTitleOnly = midCount > cfg.titleThreshold ? midCount - cfg.titleThreshold : 0;
  // ★ R-L5：强制降级游标叠加——从档3 最老起额外降 force 批，与自然降级取 max；clamp 到中段不越过尾全文区。
  const titleOnlyCount = Math.min(midCount, Math.max(naturalTitleOnly, force));
  const titleOnlyEnd = H + titleOnlyCount;
  // ★ R-L5 极端兜底：若中段全降仍不够（force 超过中段批数），允许把尾全文批也降 titleOnly（保正确性优先于 cache）。
  const tailForce = Math.max(0, force - midCount); // 还需多降几批尾批
  const tailTitleOnlyStart = N - T + 0; // 尾全文区起点
  // 头全文区也可被极端 force 吃掉：force 超过「中段+尾」后连头也降（最后防线，几乎不会触达）。
  const headExtraForce = Math.max(0, force - midCount - T);

  return batches
    .map((b, i) => {
      // 头全文区：极端 force 下从最老起降 headExtraForce 批
      if (i < H) return i < headExtraForce ? renderSkeletonBatch(b, true) : b.contentMd;
      // 尾全文区：极端 force 下从最老尾批起降 tailForce 批
      if (i >= N - T) return (i - tailTitleOnlyStart) < tailForce ? renderSkeletonBatch(b, true) : b.contentMd;
      // 中段：[H, titleOnlyEnd) 降 titleOnly，其余骨架
      return renderSkeletonBatch(b, i < titleOnlyEnd);
    })
    .filter(Boolean)
    .join(BATCH_JOIN);
}

function buildStableRecordPrefix(record: SynapseRecord, layering?: Partial<RecordLayeringConfig>): string {
  // ★ prompt cache 稳定路径：forceTitleOnlyCount=0，输出仅依赖批集合（与改造前逐字一致）。
  return renderRecordPrefix(record, layering, 0);
}

/**
 * ★ R-L5 token 硬闸（设计C）：组装 apiHistory 前的【危险态兜底】，防 record 注入前缀撑爆上下文窗口。
 *
 * ★★ 正常路径必须 no-op：estimateTokens(baseRecordMd) <= maxTokens 时【逐字返回 baseRecordMd】——
 *   不重渲、不引入任何 token/窗口依赖，保住 buildStableRecordPrefix 的 prompt cache 稳定性。
 *   只有超限（折叠没及时触发 / 单批超大等极端态）才触发降级，此时前缀会随窗口漂移、必然破 cache（可接受，仅危险态）。
 *
 * 降级策略：从中段骨架批最老侧起逐批强制降 titleOnly（forceTitleOnlyCount 游标递增），每降一批重估 token，
 *   直到 <= maxTokens；中段全 titleOnly 仍超则连尾/头也降（renderRecordPrefix 极端兜底）；全降满仍超则硬截断。
 *
 * ★ 纯函数：只读 record + 估算 token，不读 store/窗口（maxTokens 由调用方算好传入）。便于 fixture 直接驱动。
 */
function enforceRecordTokenCap(
  record: SynapseRecord,
  baseRecordMd: string,
  maxTokens: number,
  layering?: Partial<RecordLayeringConfig>,
): string {
  // ★ 正常路径 no-op（逐字返回，保 cache）。maxTokens 非正数视作「不限制」也 no-op。
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return baseRecordMd;
  if (estimateTokens(baseRecordMd) <= maxTokens) return baseRecordMd;

  // —— 危险态：逐批强制降 titleOnly ——
  const visibleCount = injectionViewBatches(record).length;
  if (visibleCount <= 1) {
    // 0/1 批：renderRecordPrefix 已对单批做 titleOnly 兜底；再不够只能硬截断。
    const once = renderRecordPrefix(record, layering, 1);
    if (estimateTokens(once) <= maxTokens) return once;
    return hardTruncateToTokens(once, maxTokens);
  }

  // force 上限 = 可见批总数（连头带尾全降光，renderRecordPrefix 极端兜底覆盖）。逐步递增找首个达标。
  let rendered = baseRecordMd;
  for (let force = 1; force <= visibleCount; force++) {
    rendered = renderRecordPrefix(record, layering, force);
    if (estimateTokens(rendered) <= maxTokens) return rendered;
  }
  // 全批 titleOnly 仍超 → 最后兜底硬截断（极端，几乎不触达）。
  return hardTruncateToTokens(rendered, maxTokens);
}

/**
 * ★ R-L5 最后兜底：按估算 token 硬截断文本（保留头部，尾部加省略标记）。仅在「全批 titleOnly 仍超窗」的极端态用。
 *   estimateTokens 是字符粗估（中文1.5/其他0.25），这里按 maxTokens 反推一个保守字符上限截断（留 5% 余量）。
 */
function hardTruncateToTokens(text: string, maxTokens: number): string {
  if (!text) return text;
  if (estimateTokens(text) <= maxTokens) return text;
  const marker = '\n\n…[record 注入前缀超窗，已硬截断]';
  // 保守反推：最坏全中文 1.5 token/char → 字符上限 ≈ maxTokens/1.5，再留 5% 余量给 marker。
  const charBudget = Math.max(0, Math.floor((maxTokens / 1.5) * 0.95));
  if (charBudget <= 0) return marker.trim();
  let cut = text.slice(0, charBudget);
  // 二分收敛：估算仍超则继续砍（估算非线性，单次反推可能不够）。
  while (cut.length > 0 && estimateTokens(cut + marker) > maxTokens) {
    cut = cut.slice(0, Math.floor(cut.length * 0.9));
  }
  return cut + marker;
}

export class AgentLoop {
  private client: AIClient;
  private tools: ToolDefinition[] = [];
  /**
   * ★ M4-7 审查修复（MCP 启停后 schema 快照滞后）：可选的「动态取数函数」。
   * 提供时，本 AgentLoop 在每次发请求前实时从它取最新工具 schema（而非用 registerTools 当时的静态快照）；
   * 这样 SettingsPanel 启停 MCP server（mcpBridge.refresh 改了 toolRegistry）后，无需重建 AgentLoop / 切模型，
   * 下一轮 send 即能反映工具增删——启动的 MCP 工具立刻进 schema 让 AI 主动调用；停止的工具同步移出快照，
   * AI 不再因旧快照尝试调用已注销工具而拿到 'Tool not found'。缺省（未提供）时回退用 this.tools 静态快照。
   */
  private toolsProvider: (() => ToolDefinition[]) | null = null;
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

  /**
   * 注册工具集与执行器。
   * @param tools     初始静态 schema 快照（兜底用；toolsProvider 提供时优先走动态取数）。
   * @param executor  工具执行器（toolRegistry.execute 透传）。
   * @param toolsProvider 可选动态取数函数（如 () => toolRegistry.getSchemas()）；提供时每次发请求实时取，
   *   使 MCP server 启停后工具增删立即对当前会话生效（无需重建 AgentLoop）。见字段注释。
   */
  registerTools(tools: ToolDefinition[], executor: ToolExecutor, toolsProvider?: () => ToolDefinition[]) {
    this.tools = tools;
    this.toolExecutor = executor;
    this.toolsProvider = toolsProvider ?? null;
  }

  /** 取当前生效的工具 schema：优先动态取数函数（实时反映 MCP 启停），否则回退静态快照。 */
  private getActiveTools(): ToolDefinition[] {
    if (this.toolsProvider) {
      try {
        const dyn = this.toolsProvider();
        if (Array.isArray(dyn)) return dyn;
      } catch {
        // 取数失败（极端情况）→ 回退静态快照，绝不让取 schema 异常打断主对话。
      }
    }
    return this.tools;
  }

  stop() {
    this.running = false;
    this.client.abort();
    // R5：中断【所有】正在进行的 record 压缩生成（若有），让 generateBatch 立即返回 null 走降级，
    // 而非傻等 60s timeout。遍历集合 abort 全部在途 controller 后整体 clear（已 abort 的不再复用）。
    for (const controller of this.compressControllers) controller.abort();
    this.compressControllers.clear();
  }

  async run(userMessage: string, opts?: {
    skipUserMessage?: boolean;
    contentParts?: MessageContentPart[];
    attachments?: AttachmentRef[];
    /**
     * ★ M6 收尾 D1：发送时 RichTextInput.extract() 产出的有序 atomic token，仅用于编辑历史消息时无损还原
     *   @ 高亮块，不进 LLM 上下文。挂在 userMsg.richTokens 上落库。
     */
    richTokens?: import('@/services/inputCommands/richInput/types').ExtractedToken[];
    /**
     * ★ M4-6-S4 @对话引用：本轮一次性注入的附加上下文（被引用历史对话的 record 摘要 / 最近 N 条原文，
     *   由 AgentPanel handleSend 组装）。经 promptBuilder.build 的 context.referencedContext 渲染成
     *   <referenced_conversation> 系统段——不进可见对话流、不重复落库。仅本轮生效（下轮无引用则自然消失）。
     */
    injectedContext?: string;
  }): Promise<void> {
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
        richTokens: opts?.richTokens, // ★ D1：随消息持久化，编辑回填时无损还原 atomic 块
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
      // ★ M4-6-S4 /goal：每轮读 conversation.goal 注入 <current_goal>，使设目标后 AI 每轮自动对齐。
      //   goal 为空/未设时 build 跳过该段（无副作用）。
      goal: (rootState as any).conversation?.goal || undefined,
      // ★ M4-6-S4 @对话引用：本轮一次性附加上下文 → <referenced_conversation> 段（不污染可见流）。
      //   含在 systemPrompt 内 → systemTokens 估算天然计入它（设计风险2：引用须计入 token 判定），
      //   引用过大时与压缩阈值正常联动，不会绕过判定。
      referencedContext: opts?.injectedContext || undefined,
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

    // ★ M4-7 审查修复：本轮取一次「当前生效工具集」（优先动态取数函数 → 实时反映 MCP server 启停后的工具增删），
    //   token 估算与下方 streamChat 发送统一用这一份，保证同口径且 MCP 启停立即对当前会话生效（无需重建 AgentLoop）。
    const activeTools = this.getActiveTools();

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
    const toolsTokens = (toolsEnabled && currentMode !== 'fast' && activeTools.length > 0)
      ? estimateTokens(JSON.stringify(activeTools))
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
    // ★ M5-BPC-4：硬压缩阈值可配（本对话覆盖 ?? 全局 bpc.compactThreshold ?? 0.9）。下推 compressContext 与
    //   下方 overLimit truncate 阈值，使「90% 硬阈值」成为用户可调项（BPC 设置面板 / 本对话覆盖）。
    const effectiveCompactThreshold = resolveCompactThreshold(rootState);
    const { compressed, wasCompressed, overLimitWithoutCompression } = compressContext(
      requestHistoryText,
      modelContextWindow,
      triggerTokens,
      historyOnlyTokens,
      effectiveCompactThreshold,
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
    // ★ R-L5 token 硬闸入参：record 注入前缀最大可占 token = 模型窗口 × recordLayering.maxRatio（默认 0.4）。
    //   仅危险态兜底用（enforceRecordTokenCap 正常路径 no-op，不破 cache）。layering 同 buildStableRecordPrefix 口径。
    const recordLayeringSnapshot = (store.getState() as RootState).agentSettings?.recordLayering;
    const recordTokenCap = modelContextWindow * (recordLayeringSnapshot?.maxRatio ?? DEFAULT_LAYERING.maxRatio);

    // ★ M5-BPC-4：后台预压缩（BPC）边界处理 + ready 状态机收尾——在 apiHistory 组装前裁决。
    //   设计要点：record 注入由下方 else 分支统一负责（M5-1：record.totalSteps>0 即注入），BPC 后台已把
    //   record 批落库 → 下一轮 run 走 else 分支天然读到并注入，「无缝替换」自然达成，无需在此另起 BPC 专属组装分支。
    //   本块只做两件【状态机 / 防双写】的事：
    //   ① 边界①②（撞硬阈值）：本轮要走同步硬压缩（wasCompressed / overLimit / ratio 已达硬阈值）时丢掉在途 BPC，
    //      防「BPC 后台 appendBatch」与「硬压缩 appendBatch」对同一 record 双写竞争。discardCurrent 只丢内存快照，
    //      BPC 已落库的批是持久的——下方 compactNow 增量切片会从该批 stepEnd 续记，BPC 成果不浪费。
    //   ② 否则若有 ready BPC：takeReadyPrefix 推进状态机 ready→idle（否则永卡 ready 阻止后续触发）并记
    //      lastReplaceStepCursor（熔断判据）。currentStepCursor 用 identifyRounds(requestHistory).totalSteps，
    //      与 snapshotStepCursor（过滤 tool 的 store.messages totalSteps）同口径（requestHistory 本就不含 tool）。
    {
      const bpcConvId = ((rootState as any).conversation?.id as string | null) || AUTOSAVE_ID;
      const bpcRatio = modelContextWindow > 0 ? triggerTokens / modelContextWindow : 0;
      const hitHardThreshold = wasCompressed || overLimitWithoutCompression || bpcRatio >= effectiveCompactThreshold;
      if (hitHardThreshold) {
        if (bpcScheduler.isBusy()) bpcScheduler.discardCurrent('撞硬压缩阈值，转同步压缩（防双写）');
      } else if (bpcScheduler.hasReadySnapshot()) {
        const curStep = identifyRounds(requestHistory).totalSteps;
        bpcScheduler.takeReadyPrefix(bpcConvId, curStep);
      }
    }

    let apiHistory: ChatMessage[];
    if (wasCompressed) {
      const keepCount = compressed.length - 1; // compressContext 保留的最近原文条数（含 tool 口径）
      // 问题1 修复：新对话 store.conversation.id 为 null，但 autosave 已把当前对话落到
      // AUTOSAVE_ID('autosave-current')（含 conversations 行，FK 满足），故 record 回退用它，
      // 让新对话的 record 多批次也能触发。（正式保存时 record 迁移到新 id 见 Task_4 小本本。）
      const conversationId = ((rootState as any).conversation?.id as string | null) || AUTOSAVE_ID;
      // 被压缩段 = 去掉「最近 keepCount 条原文」之前的全部历史（含 tool）。
      const keepStartIdx = Math.max(0, requestHistory.length - keepCount);
      const compressedSegment = requestHistory.slice(0, keepStartIdx);
      // ★ M4-7-S6：自动压缩路径下沉到可复用的 compactNow（生成批次 record + 落库 + 同步持久化）。
      //   行为与现状完全一致——compactNow 只是把原内联逻辑搬进方法，返回同一个 recordMd（落库后稳定前缀
      //   / 旧 record 前缀回退 / null 降级），自动与手动（M4-6 /compact）共用同一套压缩实现。
      const recordMdRaw = await this.compactNow(conversationId, {
        compressedSegment,
        workspaceName: workspaceName || undefined,
        currentModel,
        source: 'auto', // ★ M5-BPC-2：自动压缩（90% 硬阈值）标注来源 'auto'
      });
      // ★ R-L5 token 硬闸：对最终注入的 recordMd 过一道（正常路径 no-op、逐字返回 → 不破 cache；
      //   仅超 window×maxRatio 的危险态才逐批降 titleOnly）。需 compactNow 落库后的最新 record（已含本批 + 已折叠）。
      let recordMd = recordMdRaw;
      if (recordMdRaw) {
        const compactedRecord = await getRecord(conversationId);
        if (compactedRecord) {
          recordMd = enforceRecordTokenCap(compactedRecord, recordMdRaw, recordTokenCap, recordLayeringSnapshot);
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
      const threshold = modelContextWindow * effectiveCompactThreshold; // ★ M5-BPC-4：硬阈值可配（同 compressContext）
      apiHistory = truncateOverLongHistory(requestHistory, fixedTokens, threshold);
      store.dispatch(addNotification({
        type: 'warning',
        title: '上下文超长',
        message: '单条消息过长且无法压缩，已截断部分内容以避免超出上下文窗口',
        duration: 4000,
      }));
    } else {
      // ★ M5-1 遗留 blocker：统一 record 注入口径（规范 §0.3 / §2）。
      //   只要 record 已有内容（totalSteps>0，无论是自动压缩还是 /compact 手动生成的），就【按
      //   record prefix + 保留轮原文】组装请求体，不再只在 wasCompressed（触达 0.9 水位）分支注入。
      //   效果：/compact 生成 record 后【下一轮请求体立即用摘要】（不必等触达 token 水位才生效），
      //   且自动压缩行为保持一致（wasCompressed 分支照旧生成新批 + 注入，本分支只在「未触发新压缩
      //   但已有 record」时复用已有摘要前缀）。
      //   ★ 不生成新批、不改 store、不删消息——纯组装本轮发送视图（store 全量永远不动，规范 §0.2）。
      const conversationId = ((rootState as any).conversation?.id as string | null) || AUTOSAVE_ID;
      const existingRecord = await getRecord(conversationId);
      if (existingRecord && existingRecord.totalSteps > 0) {
        // 保留段 = record 已覆盖 step 之后的原文（含本轮当前 user）。requestHistory 不含 tool，
        // 其下标即 step 下标，与 record.totalSteps 同口径。
        // ★ 向轮边界取整（规范 §1「保留与批次边界一律按轮取整，不在轮中间切」）：
        //   M5-2 后 record 批 stepEnd 必落在轮边界，totalSteps 即轮边界、slice 天然干净；
        //   但为兼容 M5-2 之前生成、批边界非轮对齐的旧 record，用 floorStepToRoundStart 把保留起点
        //   向下对齐到 ≤ totalSteps 的最近轮起点（宁可多保留半轮原文，绝不从轮中间切）。
        const roundsOfRequest = identifyRounds(requestHistory);
        let keepFromIdx = floorStepToRoundStart(roundsOfRequest, existingRecord.totalSteps);
        // 安全下限：保留段至少含最后一条（当前最新 user），绝不把当前轮也压没/越界成空。
        keepFromIdx = Math.max(0, Math.min(keepFromIdx, requestHistory.length - 1));
        const recordMdBase = buildStableRecordPrefix(existingRecord, recordLayeringSnapshot);
        // ★ R-L5 token 硬闸：正常路径 no-op（逐字返回 recordMdBase，保 cache），仅超 window×maxRatio 危险态降级。
        const recordMd = enforceRecordTokenCap(existingRecord, recordMdBase, recordTokenCap, recordLayeringSnapshot);
        apiHistory = recordMd
          ? [{ role: 'system', content: `${RECORD_INJECTION_PREFIX}${recordMd}` } as ChatMessage, ...requestHistory.slice(keepFromIdx)]
          : requestHistory;
      } else {
        apiHistory = requestHistory;
      }
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
      // ★ M6 验收 bug9：标题不仅改 conversation slice（顶部 header），还要同步对话列表数据源
      //   （conversationHistory），否则左侧列表 / @ 对话候选一直显示创建时的 fallback（首条消息内容）。
      //   占位先 best-effort 同步列表（列表项若尚未创建则 no-op，autosave 首存会带正确 title）。
      {
        const idForTitle = (store.getState() as RootState).conversation.id;
        if (idForTitle) store.dispatch(updateConversation({ id: idForTitle, title: placeholderTitle }));
      }

      // 仅当首条有可概括文本时才异步生成（纯图片/附件无文本 → 保留占位降级）。
      const titleSource = userMessage.trim();
      if (titleSource) {
        // 发起时快照：用于回写竞态守卫（对话已切换/清空则不回写）。
        const conversationIdSnapshot = (store.getState() as RootState).conversation.id;
        // ★ fire-and-forget：包在自执行 async IIFE，void 丢弃 promise，绝不被主流式 await。
        void (async () => {
          // ★ M7-F1：复用抽出的 generateTitleFromText（与手动「重新生成标题」同内核）。
          const generated = await generateTitleFromText(titleSource);
          if (!generated) return; // 全失败 → 保留已设的截断占位（不再 dispatch）

          // 竞态守卫：回写前再读 live conversation——
          //   - id 必须与发起时快照一致（对话未切换/未清空）；
          //   - 当前标题必须仍是占位（未被用户在生成期间手动改过），否则尊重用户手改、不覆盖。
          const live = (store.getState() as RootState).conversation;
          if (live.id !== conversationIdSnapshot) return;
          if (live.title !== placeholderTitle) return;
          store.dispatch(setTitle(generated));
          // ★ M6 验收 bug9：生成标题同步对话列表 slice（即时刷新左侧列表 / @ 对话候选）+ 落库
          //   （systemTouch=true：只写标题列不刷 updated_at，避免自动标题把对话顶到列表最前）。
          if (conversationIdSnapshot) {
            store.dispatch(updateConversation({ id: conversationIdSnapshot, title: generated }));
            void renameConversation(conversationIdSnapshot, generated, { systemTouch: true });
          }
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

    // ★ 审查 LOW（lens2）：run 入口快照执行上下文 id，整轮 run 期间复用——不再 while 内每轮重读 store.conversation.id。
    //   原每轮重读：流式中途用户切对话会让在途工具的 execContextId 漂移成新对话身份，去取新对话的 worktree 隔离根
    //   执行旧对话的在途工具（窄串台窗口）。run 入口快照后整轮身份不可变，与子代理路径（构造期固定 contextId）口径统一。
    const execContextId = this.contextId
      || ((store.getState() as RootState).conversation?.id as string | null)
      || AUTOSAVE_ID;

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

      // ★ M6 验收 C2c：流式 dispatch rAF 批处理。原本每个 SSE token 三连 dispatch
      //   （appendMessageContent + setMessageStreamState + addRunEvent）把主线程打满——生成时整个界面卡死、
      //   滚动条/选模型/思考卡片全锁死。改为累积 buffer + requestAnimationFrame 合并 flush，dispatch 频率从
      //   「每 token」降到「每帧(~16ms)」。
      //   ★ 关键安全点：finalize 用 updateMessageMeta 不覆盖 content（content 全靠流式 appendMessageContent 累积），
      //     故所有收尾分支前必须 flushStreamBuffer() 把残余 buffer 上屏，否则丢末尾文本（见下方 try/catch 后）。
      let contentBuffer = '';
      let deltaBuffer = '';
      let streamFlushScheduled = false;
      const flushStreamBuffer = () => {
        streamFlushScheduled = false;
        if (!contentBuffer) return;
        const pendingContent = contentBuffer;
        const pendingDelta = deltaBuffer;
        contentBuffer = '';
        deltaBuffer = '';
        store.dispatch(appendMessageContent({ id: assistantMessageId, content: pendingContent }));
        store.dispatch(setMessageStreamState({ id: assistantMessageId, streamState: 'streaming', streamMode: streamModeUsed, fallbackReason }));
        store.dispatch(addRunEvent({
          id: generateId('evt'),
          runId,
          messageId: assistantMessageId,
          type: 'content_delta',
          timestamp: Date.now(),
          content: pendingDelta,
        }));
      };
      // ★ M6 验收 C2c 调整：flush 用【时间节流】而非 rAF（每帧 ~60 次/秒）。主人反馈「卡=渲染频率过高」，
      //   要的是降频渲染而非不渲染——节流到 ~200ms 一次（≈5 次/秒），让流式期照常渲染 markdown 但解析频率降 ~12 倍。
      //   STREAM_FLUSH_MS 可调：太顿→调小(120)、长回复仍卡→调大(300)。
      const STREAM_FLUSH_MS = 200;
      const scheduleStreamFlush = () => {
        if (streamFlushScheduled) return;
        streamFlushScheduled = true;
        setTimeout(flushStreamBuffer, STREAM_FLUSH_MS);
      };

      try {
        const stream = this.client.streamChat(
          apiMessages,
          // Fast mode: don't pass tools (no agentic behavior)
          currentMode === 'fast' || !toolsEnabled ? undefined : (activeTools.length > 0 ? activeTools : undefined),
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
              contentBuffer = ''; // ★ C2c：重连重置时清掉未 flush 的残余 buffer，避免旧内容污染重生成的新流
              deltaBuffer = '';
              store.dispatch(updateMessage({ id: assistantMessageId, content: '' }));
              store.dispatch(updateMessageMeta({ id: assistantMessageId, changes: { thinking: undefined } }));
            }
            continue;
          }

          if (chunk.type === 'content' && chunk.content) {
            clearRetryNotice();
            fullContent += chunk.content;
            // ★ C2c：不再每 token 三连 dispatch，累积进 buffer 由 rAF 合并 flush（见 flushStreamBuffer）。
            contentBuffer += chunk.content;
            deltaBuffer += chunk.content;
            scheduleStreamFlush();
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

      // ★ C2c 关键：收尾前强制 flush 残余 buffer——正常完成 / abort(break) / 异常(catch) 三条路径都经过这里，
      //   finalize 不会用 fullContent 覆盖 content，所以这里不 flush 会丢「最后一帧没来得及 rAF 上屏」的末尾文本。
      flushStreamBuffer();
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
        // execContextId 已在 run 入口快照（见 while 前），整轮 run 复用，不再每轮重读 store（防流式中切对话身份漂移）。
        for (const tc of pendingToolCalls) {
          if (!this.running) {
            // ★ 命令转圈修复：用户中断 → 把本轮【剩余未执行】的 pending/running 工具调用收尾为 cancelled，
            //   避免它们永久卡 spinner（已执行的上面已回写 success/error）。恢复路径另由 normalizeMessage 兜底。
            if (assistantMessageId) {
              const abortMsg = (store.getState() as RootState).conversation.messages.find((m: any) => m.id === assistantMessageId);
              abortMsg?.toolCalls?.forEach((t: any) => {
                if (t.status === 'pending' || t.status === 'running') {
                  store.dispatch(updateToolCallStatus({ messageId: assistantMessageId, toolCallId: t.id, status: 'cancelled', result: '已取消（生成中断）' }));
                }
              });
            }
            break;
          }
          const toolStartedAt = Date.now();
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
            // ★ show_artifact：与文件改动同口径——按 execContextId 消费自己桶的产物卡片，挂到当前 assistant 消息上。
            //   artifact 只是「打开已存在文件」的入口（无 diff/snapshot/审阅），故只 addMessageArtifact，不发 file_change 事件。
            const artifacts = consumeTrackedArtifacts(execContextId);
            for (const artifact of artifacts) {
              if (assistantMessageId) {
                store.dispatch(addMessageArtifact({ messageId: assistantMessageId, artifact }));
              }
            }

            store.dispatch(addMessage({
              id: generateId(),
              role: 'tool',
              content: result,
              timestamp: Date.now(),
            }));
            // ★ FIX-13：工具执行成功 → 回写该 toolCall status=success + result + 耗时（停掉 spinner、显示 ✓ 和耗时）。
            if (assistantMessageId) {
              store.dispatch(updateToolCallStatus({
                messageId: assistantMessageId,
                toolCallId: tc.id,
                status: 'success',
                result,
                executionTime: Date.now() - toolStartedAt,
              }));
            }
            apiMessages.push({
              role: 'tool',
              content: result,
              tool_call_id: tc.id,
            });
          } catch (err: any) {
            const errorResult = `Error: ${err.message}`;
            // ★ FIX-13：工具执行失败 → 回写该 toolCall status=error + 错误信息 + 耗时（停掉 spinner、显示 ✗）。
            if (assistantMessageId) {
              store.dispatch(updateToolCallStatus({
                messageId: assistantMessageId,
                toolCallId: tc.id,
                status: 'error',
                result: errorResult,
                executionTime: Date.now() - toolStartedAt,
              }));
            }
            apiMessages.push({
              role: 'tool',
              content: errorResult,
              tool_call_id: tc.id,
            });
          }
        }
        // ★ M5-BPC-4：工具轮末 step 收尾钩子——fire-and-forget 评估水位触发后台预压缩（绝不 await，不阻塞循环）。
        this.evaluateBpcWater(modelContextWindow, systemTokens, toolsTokens);
        // Continue loop for next round
        continue;
      }

      // ★ M5-BPC-4：自然完成轮末 step 收尾钩子——同工具轮末，fire-and-forget 评估水位。
      this.evaluateBpcWater(modelContextWindow, systemTokens, toolsTokens);
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

  /**
   * ★ 可复用的「压缩落库」核心——生成 record 批次 + 落库 + 同步持久化 store.messages 一次，返回刷新后的注入前缀 recordMd。
   *
   * ★ M5-1 压缩归一：压缩有且仅有一套，手动 /compact ＝ 自动压缩，完全同一套逻辑，仅触发方式不同：
   *   - 自动压缩（run 内 ~90% 水位 compressContext 判定 wasCompressed 后）：传入它算好的 compressedSegment
   *     （= 本轮 requestHistory 去掉最近 keepCount 条原文之前的全部），行为与抽取前【逐字节一致】。
   *   - 手动压缩（/compact 命令）：不传 compressedSegment，由本方法从 store 当前对话历史自算被压缩段
   *     （与自动同口径：过滤 tool 后保留最近 KEEP_RECENT 条原文之前的全部）。归一后 store 永不被截断，
   *     故手动自算段与自动传入段【同源】，batchSlice 单一口径。
   *
   * 返回：
   *   - 落库成功 → buildStableRecordPrefix(updated)（含本批的确定性稳定前缀）。
   *   - 无新批 / 生成失败 / 中止 → 旧 record 的稳定前缀（existingRecord 存在时）或 null（无 record 时）。
   *   - 调用方据此组装注入前缀；null 时自动路径回退到 compressContext 字符截断（手动路径据此提示无可压缩内容）。
   *
   * ★★ 职责边界（核心原则：压缩绝不删 store.messages）：
   *   本方法【只负责】「生成 record 批次 + 落库 + 同步持久化 store.messages 一次」并返回注入前缀 recordMd。
   *   它【绝不】截断 / 收敛 store.conversation.messages —— UI 与本地完整对话文件永远全量保留，压缩只产出
   *   record 批次。压缩点在 UI 上由 AgentPanel.batchDividerByIdx 分隔线呈现（读 record 各批 stepEnd → 消息下标，
   *   store 全量时天然画对位置），自动 / 手动两条路径走完全相同的注入组装（run() 外层用 compressedSegment 算
   *   注入前缀，不删 store），无需调用方再补任何「截断 / 刷新前缀」步骤。
   *
   * ★ R5 健壮性契约沿用（务必维持）：
   *   - 为本次压缩生成新建独立 AbortController 登记到 this.compressControllers，stop() 可遍历 abort；
   *     finally 只 delete 自己这个 controller（归属隔离，不误清并发 run 的 controller）。
   *   - generateBatch 失败/中止 → 不 appendBatch → record 维持压缩前状态，绝不丢 store.messages。
   *   - appendBatch 落库原子 + 幂等（见 record 链路注释），崩溃恢复一致。
   *
   * @param conversationId 目标对话 id（新对话回退 AUTOSAVE_ID 由调用方传入）。
   * @param opts.compressedSegment 被压缩段（含 tool）。自动路径必传；手动路径缺省时从 store 计算。
   * @param opts.workspaceName   工作区名（写入 record 元数据，可空）。
   * @param opts.currentModel    当前模型（仅用于压缩后同步 autosave 的 model 字段；缺省读 store）。
   */
  async compactNow(
    conversationId: string,
    opts?: {
      compressedSegment?: ChatMessage[];
      workspaceName?: string;
      currentModel?: string;
      // ★ M5-BPC-2：本次压缩来源标注（透传给 generateAndAppend → appendBatch → record 批 source）。
      //   /compact 传 'manual'，run() 自动兜底传 'auto'（缺省 'auto'）。BPC 后台走 bpcGenerate（'bpc'），不经本壳。
      source?: 'auto' | 'manual' | 'bpc';
    },
  ): Promise<string | null> {
    if (!conversationId) return null;

    // ★ M5-1 压缩归一：手动 /compact 与自动压缩【完全同源】，被压缩段语义统一。
    //   - 自动路径：run 在组装时传入 compressedSegment（= 从 store 头部累计的【全量】被压段，自动压缩不截断 store）。
    //   - 手动 /compact：不传 compressedSegment，本方法从 store 当前对话历史自算。归一后 store 永不被截断，
    //     故手动自算出的也是「从 store 头部累计的【全量】被压段」——与自动路径【同源同口径】。
    //   下方 batchSlice 因此统一为 coveredEligible.slice(priorSteps) 单一口径，不再有手动/自动分支差异。
    let compressedSegment = opts?.compressedSegment;
    if (!compressedSegment) {
      // 手动入口（/compact）：保留最近原文、其余作被压段交给增量切片。
      // step 口径：排除 tool（由 agentLoop 内部管理，不计入 step）。归一后 store 已无 system 压缩摘要消息，
      //   全程只按 user/assistant 算 step，与 record 首次建立 / 自动路径 / clampToBatch 一致。
      const liveMessages = (store.getState() as RootState).conversation.messages
        .filter((m: any) => m.role !== 'tool')
        .map(toChatMessage);
      // ★ M5-2 轮次地基：保留最近 KEEP_RECENT_ROUNDS 个【整轮】（向轮边界取整，绝不轮中间切，规范 §1）。
      //   原实现保留固定 4 条原文，会在轮中间切（连发 user / 一轮多 model step 时把半轮留半轮压）；
      //   现按真轮识别，从末轮往前数 KEEP_RECENT_ROUNDS 整轮作为保留段，其余整轮作被压段——
      //   使手动 /compact 的被压段尾部一定落在轮边界，与自动路径（compressContext 按轮保留）口径统一。
      const KEEP_RECENT_ROUNDS = 2;
      const liveRounds = identifyRounds(liveMessages);
      const keepFromRoundIdx = Math.max(0, liveRounds.rounds.length - KEEP_RECENT_ROUNDS);
      const keepStartIdx = liveRounds.rounds[keepFromRoundIdx]?.stepStart ?? 0;
      compressedSegment = liveMessages.slice(0, keepStartIdx);
    }

    // R5：为本次压缩生成新建独立中止器，登记到实例集合让 stop() 能遍历 abort 到它（归属隔离，finally 只删自己）。
    //   ★ M5-BPC-2：controller 的建/登记/finally-delete 责任留在本壳层（compactNow 是【主对话】压缩入口，
    //     stop() 管的是 compressControllers）；generateAndAppend 只认 opts.signal，不自己建 controller。
    //     BPC 后台路径走 bpcGenerate（用 scheduler 自己的 controller 集合），绝不混进 compressControllers。
    const compressController = new AbortController();
    this.compressControllers.add(compressController);
    try {
      // ★ M5-BPC-2：纯生成+落库下沉到 generateAndAppend，本壳【行为逐字节等价】于拆分前——
      //   只是把 controller 建在壳层、signal 传入；返回前缀 recordMd 不变。
      const result = await this.generateAndAppend(conversationId, {
        compressedSegment,
        workspaceName: opts?.workspaceName,
        currentModel: opts?.currentModel,
        source: opts?.source ?? 'auto',
        signal: compressController.signal,
      });
      return result.recordMd;
    } finally {
      // R5：本次压缩生成结束（成功/降级/中止/异常）即从集合移除【自己这个】 controller，
      // 只 delete 局部变量，绝不整体置空——避免误清别的在途 run 登记的 controller（归属隔离）。
      this.compressControllers.delete(compressController);
    }
  }

  /**
   * ★ M5-BPC-2：record 压缩的【纯生成 + 落库】核心（从 compactNow 抽出，无 controller 归属语义）。
   *
   *   职责 = 「getRecord → batchSlice 切片 → generateBatch → appendBatch（带 source）→ R-L4 折叠 →
   *           压缩后同步 autosave → buildStableRecordPrefix」一体。与拆分前 compactNow 主体【行为逐字节等价】，
   *   仅两点变化：(a) AbortController 由【调用方传入 opts.signal】（本方法不建 controller）；
   *              (b) appendBatch 入参带 source（透传），返回结构含 appended + 落库后 totalSteps/totalRounds。
   *
   *   三条压缩路径共用本方法（决策③）：
   *     - compactNow 薄壳（主对话自动 'auto' / 手动 'manual'）：壳建 controller 登记 compressControllers，传 signal。
   *     - bpcGenerate（后台预压 'bpc'）：scheduler 用自己的 controller 集合，传其 signal（与 compressControllers 隔离）。
   *
   *   ★ 健壮性契约（沿用 compactNow R5，务必维持）：generateBatch 失败/中止 → 不 appendBatch → record 维持
   *     压缩前状态，绝不丢 store.messages；appendBatch 落库原子 + 幂等；压缩后同步 autosave 失败吞异常不阻塞。
   *
   * @returns recordMd  注入前缀（buildStableRecordPrefix；无 record / 异常时 null，调用方据此降级字符截断）。
   * @returns appended  本次是否真落了一个新批（batchSlice 非空 + generateBatch 成功 + appendBatch 成功）。
   * @returns totalSteps/totalRounds  落库后 record 派生水位（appended=false 时取 existingRecord 水位，无 record 为 0）。
   */
  private async generateAndAppend(
    conversationId: string,
    opts: {
      compressedSegment: ChatMessage[];
      workspaceName?: string;
      currentModel?: string;
      source?: 'auto' | 'manual' | 'bpc';
      signal?: AbortSignal;
    },
  ): Promise<{ recordMd: string | null; appended: boolean; totalSteps: number; totalRounds: number; outcome: 'appended' | 'no-new-segment' | 'failed' }> {
    if (!conversationId) return { recordMd: null, appended: false, totalSteps: 0, totalRounds: 0, outcome: 'failed' };

    const workspaceName = opts.workspaceName
      || ((store.getState() as RootState) as any).workspace?.name
      || undefined;
    const currentModel = opts.currentModel
      || ((store.getState() as RootState) as any).agentSettings?.currentModel
      || '';
    const source: 'auto' | 'manual' | 'bpc' = opts.source ?? 'auto';

    let recordMd: string | null = null;
    let appended = false;
    let totalSteps = 0;
    let totalRounds = 0;
    // ★ M5-BPC 审查 M1/H1：区分「无新增段（no-new-segment，正常无需 BPC，回 idle）」与「真失败（failed，δ retry）」，
    //   不再让旧前缀 recordMd 兜底掩盖真实失败（旧逻辑 appended||recordMd 会把「generateBatch 失败但有旧 record」
    //   误判成功 → 误熔断）。默认 no-new-segment（batchSlice 空时保持）；落批成功→appended；生成/落库失败或 catch→failed。
    let outcome: 'appended' | 'no-new-segment' | 'failed' = 'no-new-segment';
    try {
      const existingRecord = await getRecord(conversationId);

      // ★ M5-1 压缩归一：batchSlice 单一口径（手动 /compact 与自动压缩同源，不再分支）。
      //   step 口径对齐 record（全程不含 tool）。record 增量水位 priorSteps（末批 stepEnd）以「对话 step0 累计」为绝对基准。
      //   归一后两条路径的 compressedSegment 都是「从 store 头部累计的【全量】被压段」（压缩绝不截断 store），
      //   故 batchSlice = coveredEligible.slice(priorSteps) 恒切出「上次已覆盖之后的新增段」——单一口径全覆盖。
      const coveredEligible = opts.compressedSegment.filter(m => m.role !== 'tool');
      const priorSteps = existingRecord?.totalSteps ?? 0;       // = 末批 stepEnd（不含 tool）
      const priorRounds = existingRecord?.totalRounds ?? 0;     // = 末批 roundEnd
      const batchSlice = coveredEligible.slice(priorSteps);     // 从全量段切掉已覆盖前缀得本批增量
      // 默认水位（appended=false 兜底）= 现有 record 水位（无 record 为 0）。
      totalSteps = priorSteps;
      totalRounds = priorRounds;

      // ★ M4-5-S2：压缩注入改用确定性稳定前缀（不随 contextWindow 动态升降级），杜绝 apiMessages[1] 前缀漂移。
      recordMd = existingRecord ? buildStableRecordPrefix(existingRecord, (store.getState() as RootState).agentSettings?.recordLayering) : null;

      if (batchSlice.length > 0) {
        // ★ M5-2 轮次地基：本批覆盖的轮号由【真轮识别】推导，替换原「user 条数 = 轮数」近似。
        //   在整个全量被压段（coveredEligible，不含 tool）上识别轮边界，本批 = coveredEligible.slice(priorSteps)，
        //   故本批末 step 的真轮号 = 被压段最后一个 step 的轮号 = identifyRounds(coveredEligible).totalRounds。
        //   - roundStart = priorRounds + 1（接续上一批末轮 +1）。
        //   - roundEnd   = 被压段最后一个 step 的真轮号（连发 user / 一轮多 model step 时正确收敛，不再虚高）。
        //   退化等价：常规交替序列上 totalRounds === user 累计条数，roundEnd 与旧口径一致；仅合并场景才收敛。
        //   ★ stepEnd 仍是半开 step 计数（= coveredEligible.length），与 appendBatch 幂等水位门口径不变；
        //     因被压段由上游（compressContext 保留整轮后的剩余 / 手动入口下方按轮取整）保证尾部落在轮边界，
        //     故 stepEnd 天然 == 末轮 stepEnd，批边界 step/round 双口径同步落在轮边界（绝不轮中间切）。
        const coveredRounds = identifyRounds(coveredEligible);
        const roundStart = priorRounds + 1;
        // ★ Codex review High#2 防护：roundEnd 取真轮数，但【钳到 >= roundStart】，防 totalRounds 倒退。
        //   正常态（priorSteps 落轮边界、record 轮口径一致）下 coveredRounds.totalRounds >= roundStart 恒成立。
        //   但若 existingRecord 是 M5-2 前生成的旧批（priorRounds 按 user 条数算、可能虚高于真轮数），
        //   连发 user 场景下真轮数 coveredRounds.totalRounds 可能 < priorRounds+1 → roundStart>roundEnd、
        //   append 后 record.totalRounds 倒退污染水位。Math.max 兜住：宁可本批 round 跨度记为 0（roundStart==roundEnd），
        //   也绝不让派生 totalRounds 倒退（round 仅用于 UI 分隔线/裁剪 sanity，不影响请求体正确性）。
        const roundEnd = Math.max(roundStart, coveredRounds.totalRounds);
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
        }, opts.signal); // ★ M5-BPC-2：透传【调用方】signal，用户 stop / scheduler abort 时立即降级返回 null
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
            source, // ★ M5-BPC-1/2：本批来源标注随 batch 落库（'auto'|'manual'|'bpc'）
          });
          // ★ 审查 HIGH（verify 二轮）：appendBatch 拒写（脏写 recordStore:482 / 并发水位门 :519）返回的是【旧 record】
          //   (existing 非空) 而非 null——BPC 稳态(已有 record)下不能只判 updated 真值，否则并发拒写会被误判 appended →
          //   假 ready → 误熔断（M1 失败模式从 recordMd 层下移到 updated 层）。必须确认水位真推进(totalSteps>stepStart)才算真落本批。
          if (updated && updated.totalSteps > stepStart) {
            appended = true;
            outcome = 'appended';
            // ★ R-L4 折叠触发：appendBatch 成功落库后，若可见（非 archived、非 meta）批数 > foldThreshold，
            //   折叠最老 foldBatchK 批为 1 元批（原文 archived 留库），再用折叠后的 record 重算注入前缀。
            //   foldOldBatches 内部对未达阈值 no-op、且全程吞异常（record 是加速层，绝不阻塞主对话）。
            const layeringForFold = (store.getState() as RootState).agentSettings?.recordLayering;
            const foldThreshold = layeringForFold?.foldThreshold ?? DEFAULT_LAYERING.foldThreshold;
            const visibleRealCount = updated.batches.filter(b => !b.archived && !b.meta).length;
            let folded: SynapseRecord | null = updated;
            if (visibleRealCount > foldThreshold) {
              folded = await foldOldBatches(conversationId, {
                foldThreshold,
                foldBatchK: layeringForFold?.foldBatchK ?? DEFAULT_LAYERING.foldBatchK,
              }) || updated; // 折叠失败（返回 null）退回未折叠 updated，不破坏注入
            }
            // ★ M4-5-S2：同样走稳定前缀，与上方分支口径一致，保证注入前缀确定性（用折叠后 record）。
            recordMd = buildStableRecordPrefix(folded, layeringForFold);
            // ★ M5-BPC-2：落库后真实派生水位（供 BPC 算 targetReplaceStep；折叠不改水位，用 updated 口径即可）。
            totalSteps = updated.totalSteps;
            totalRounds = updated.totalRounds;
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
          } else {
            // updated 为 null（首批被拒）或 totalSteps 未推进（拒写返回旧 record、水位没动）→ 本次未真落批，视作失败
            //   （交给 scheduler δ retry / discard，绝不假 ready）。
            outcome = 'failed';
          }
        } else {
          // generateBatch 返回 null（LLM 失败 / 超时 / 被 signal 中止）→ 失败。
          outcome = 'failed';
        }
      }
    } catch (err) {
      outcome = 'failed';
      console.warn('[agentLoop] record 压缩失败，回退字符截断:', err);
    }
    return { recordMd, appended, totalSteps, totalRounds, outcome };
  }

  /**
   * ★ M5-BPC-3：后台预压缩专用【public 包装】——供 bpcScheduler 调 generateAndAppend（决策④：用 public 包装
   *   而非把 generateAndAppend 改 public，封装更干净）。scheduler 持有本 AgentLoop 实例引用（attachLoop 注入），
   *   用【自己的 controller 集合】管 signal（与本类 compressControllers 隔离，stop() 不误伤 BPC、scheduler.abort 不误伤主对话）。
   *
   *   行为 = 直接转发 generateAndAppend，source 固定 'bpc'。返回结构原样透传（含 appended + 落库后水位，
   *   scheduler 据 totalSteps/totalRounds 算 targetReplaceStep / 熔断游标）。
   *
   * @param compressedSegment 被压段（含 tool，scheduler 在 triggerSnapshot 瞬间从 store 现算 + structuredClone 深拷贝冻结）。
   * @param signal scheduler 自己 controller 的 signal（discardCurrent/abort 时触发，generateBatch 立即降级返回 null）。
   */
  async bpcGenerate(
    conversationId: string,
    compressedSegment: ChatMessage[],
    signal?: AbortSignal,
    opts?: { workspaceName?: string; currentModel?: string },
  ): Promise<{ recordMd: string | null; appended: boolean; totalSteps: number; totalRounds: number; outcome: 'appended' | 'no-new-segment' | 'failed' }> {
    return this.generateAndAppend(conversationId, {
      compressedSegment,
      workspaceName: opts?.workspaceName,
      currentModel: opts?.currentModel,
      source: 'bpc',
      signal,
    });
  }

  /**
   * ★ M5-BPC-3：从当前 store 现算 BPC 拍快照原料（被压段 + step/round 游标），口径与手动 /compact 入口完全一致。
   *   bpcScheduler.triggerSnapshot 调本方法拿原料后 structuredClone 深拷贝冻结 compressedSegment（store 后续照常发展不影响）。
   *
   *   - compressedSegment：全历史（去 tool）保留最近 KEEP_RECENT_ROUNDS=2 个【整轮】后的被压段（向轮边界取整，
   *     与 compactNow 手动入口同款，绝不轮中间切）。压缩绝不截断 store，故这是「从 store 头部累计的全量被压段」。
   *   - snapshotStepCursor / snapshotRoundCursor：identifyRounds(过滤 tool 的全量 store.messages) 的 totalSteps/totalRounds，
   *     在拍快照【瞬间】锁定（值拷贝），与 run()/compactNow 的现算口径一致（当前无持久 step 游标，见 BPC-0）。
   *
   *   ★ 复用内部 toChatMessage/getMessageText/identifyRounds 一处口径，scheduler 不碰 store message 内部结构、不重复实现转换。
   */
  computeBpcSnapshotInput(conversationId: string): {
    compressedSegment: ChatMessage[];
    snapshotStepCursor: number;
    snapshotRoundCursor: number;
  } {
    void conversationId; // 现算只依赖当前 store.conversation；conversationId 由 scheduler 在外层校验身份一致
    const liveMessages = (store.getState() as RootState).conversation.messages
      .filter((m: any) => m.role !== 'tool')
      .map(toChatMessage);
    const liveRounds = identifyRounds(liveMessages);
    // 与 compactNow 手动入口同款：保留最近 2 整轮原文，其余作被压段（尾部落轮边界）。
    const KEEP_RECENT_ROUNDS = 2;
    const keepFromRoundIdx = Math.max(0, liveRounds.rounds.length - KEEP_RECENT_ROUNDS);
    const keepStartIdx = liveRounds.rounds[keepFromRoundIdx]?.stepStart ?? 0;
    const compressedSegment = liveMessages.slice(0, keepStartIdx);
    return {
      compressedSegment,
      // ★ 锁定瞬间游标 = 全量 store（去 tool）的 totalSteps/totalRounds（不是被压段的，是整对话当前水位）。
      snapshotStepCursor: liveRounds.totalSteps,
      snapshotRoundCursor: liveRounds.totalRounds,
    };
  }

  /**
   * ★ M5-BPC-4：run() while 循环每轮末的 BPC 水位评估钩子（fire-and-forget，绝不阻塞主循环）。
   *   口径 = run 进入 assembledTokens 的本地估算部分：systemTokens + toolsTokens（本轮不变，闭包传入）+ 当前
   *   store 全量历史文本 token（store.messages 永远全量，压缩只改发送视图不动 store）+ 非文本 part 估算。
   *   ★ 审查 L2：刻意【不】取 run 进入那样的 max(apiRealTokens)——apiRealTokens 是上一轮 API 实测、对循环末已过时，
   *     而 liveAssembled 是当前实时全量估算更准；方向偏保守（BPC 略晚触发），因 BPC 阈值本就低于硬阈值，无害。
   *   currentStepCursor 用 identifyRounds(过滤 tool 的 store.messages).totalSteps，与 snapshotStepCursor 同口径。
   *   scheduler.evaluateWater 内部自判 idle/冷却/熔断/阈值，本方法只负责按同口径算好水位上下文传入。
   */
  private evaluateBpcWater(modelContextWindow: number, systemTokens: number, toolsTokens: number): void {
    try {
      const state = store.getState() as RootState;
      const conversationId = ((state as any).conversation?.id as string | null) || AUTOSAVE_ID;
      const liveMessages = state.conversation.messages
        .filter((m: any) => m.role !== 'tool')
        .map(toChatMessage);
      const liveText = liveMessages.map(m => ({ role: m.role, content: chatContentToText(m.content) }));
      const liveAssembled = systemTokens + toolsTokens + countConversationTokens(liveText)
        + liveMessages.reduce((sum, m) => sum + estimateNonTextPartsTokens(m.content), 0);
      const liveSteps = identifyRounds(liveMessages).totalSteps;
      bpcScheduler.evaluateWater({
        triggerTokens: liveAssembled,
        modelContextWindow,
        conversationId,
        currentStepCursor: liveSteps,
      });
    } catch (err) {
      // BPC 评估失败绝不影响主对话循环。
      console.warn('[AgentLoop] evaluateBpcWater 跳过：', err);
    }
  }

}

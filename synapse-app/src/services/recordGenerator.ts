/**
 * Record Generator
 * M1 上下文 harness：把「即将被压缩」的一批消息调一次 LLM 浓缩成结构化 markdown 过程日志。
 *
 * 产出固定模板：用户意图 / 关键决策 / 工具调用与结果摘要 / 产出文件清单。
 *
 * ★ 契约（务必遵守，与 Plan_4_M1「Step 1 record 层：输入被压缩的 messages」一致）：
 *   `input.messages` 永远只是【本批被压缩的切片】，绝不是从第 1 轮起的全量历史。
 *   增量更新时，调用方通过 `priorRounds` / `priorSteps` / `priorTimeSpan` 把
 *   「已被先前 record 覆盖的累计水位线」传进来，本函数只负责：
 *     - 序列化本批切片喂给模型；
 *     - 让模型把 `existingRecordMd` 与本批新增内容合并成全文（命中下一轮 cache 的稳定前缀）；
 *     - 把本批轮次/步骤【累加】到 prior 水位线上返回；
 *     - 把本批时间窗与 `priorTimeSpan` 合并成整段跨度返回。
 *   这样既不会把旧消息重复喂给生成模型（省 token），也不会让水位线倒退。
 *
 * 关键约束（Plan_4 M1 风险 3）：
 *   生成是「加速 / 增强」能力，绝不能阻塞主对话。
 *   任何失败（无 Key、网络错误、模型报错、解析异常、输出不合格）一律降级返回 null，
 *   由调用方回退到字符截断压缩。
 */

import { AIClient, type ChatMessage } from './aiClient';
import { store } from '@/store';

/** 参与生成的单条消息（取自 store 的 Message 子集，避免耦合完整类型） */
export interface RecordSourceMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp?: number;
  /** 工具调用（assistant 发起） */
  toolCalls?: Array<{ name?: string; arguments?: string; result?: string; status?: string }>;
}

export interface GenerateRecordInput {
  conversationId: string;
  /**
   * ★ 本批要浓缩的消息切片（含 tool 轮次）——只传「本次新增/被压缩段」，不要传全量历史。
   * 增量场景下与上一批不重叠；轮次/步骤的累计由 prior* 入参承接。
   */
  messages: RecordSourceMessage[];
  /** 已有 record 正文（增量更新时传入），无则全量生成 */
  existingRecordMd?: string | null;
  /** 已被先前 record 覆盖的累计用户轮次（增量水位线起点，缺省 0） */
  priorRounds?: number;
  /** 已被先前 record 覆盖的累计消息条数（增量水位线起点，缺省 0） */
  priorSteps?: number;
  /** 已有 record 的时间跨度字符串（"start ~ end"），用于合并出整段跨度起点，可空 */
  priorTimeSpan?: string | null;
  /** 工作区名（写入元数据，可空） */
  workspaceName?: string;
}

export interface GenerateRecordResult {
  /** 生成的完整 record markdown */
  contentMd: string;
  /** 覆盖到的总轮次（prior + 本批用户消息数） */
  totalRounds: number;
  /** 覆盖到的总步骤（prior + 本批参与消息条数） */
  totalSteps: number;
  /**
   * 模板小节数概览信号（弱语义）：统计模板 4 个固定小节之外的额外 `##` 标题，
   * 反映模型是否自行扩展了结构；正常应为 0，不要据此做关键决策。
   */
  phases: number;
  /** 整段时间跨度 "YYYY-MM-DD HH:mm ~ YYYY-MM-DD HH:mm"（已与 priorTimeSpan 合并） */
  timeSpan: string;
}

/** record 生成模型一次性能力上限（按 OpenAI 兼容端常见上下文留余量，估字符） */
const MAX_SOURCE_CHARS = 120_000;
/** 单条消息正文截断上限，防止超长工具输出/代码块撑爆 prompt */
const PER_MESSAGE_CHARS = 4_000;
/** 生成调用的整体超时（毫秒），超时即降级 */
const GENERATE_TIMEOUT_MS = 60_000;
/** 生成结果正文字符上限：模板要求 1200 字以内，留约 4 倍冗余兜底，超出视为跑飞 */
const MAX_OUTPUT_CHARS = 6_000;
/** record 正文必须包含的标题锚点，缺失视为模型未遵守模板 */
const REQUIRED_HEADING = '# 对话过程日志';

function roleLabel(role: RecordSourceMessage['role']): string {
  switch (role) {
    case 'user': return '用户';
    case 'assistant': return 'AI';
    case 'tool': return '工具结果';
    case 'system': return '系统';
    default: return role;
  }
}

function truncate(text: string, max: number): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…(已截断)` : text;
}

function formatTimestamp(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 计算本批消息的时间窗 [最早, 最晚]，无有效时间戳返回 [null, null] */
function computeTimeBounds(messages: RecordSourceMessage[]): [number | null, number | null] {
  const times = messages.map(m => m.timestamp).filter((t): t is number => typeof t === 'number' && t > 0);
  if (times.length === 0) return [null, null];
  return [Math.min(...times), Math.max(...times)];
}

/** 解析 "start ~ end" 跨度字符串两端的展示文本（已格式化，不再是时间戳） */
function parseTimeSpan(span?: string | null): [string, string] {
  if (!span) return ['', ''];
  const idx = span.indexOf('~');
  if (idx < 0) return [span.trim(), span.trim()];
  return [span.slice(0, idx).trim(), span.slice(idx + 1).trim()];
}

/**
 * 把本批时间窗与已有跨度合并：起点取「更早」、终点取「更晚」。
 * 已有跨度两端已是格式化字符串（无原始时间戳），用字典序近似比较——
 * "YYYY-MM-DD HH:mm" 格式下字典序与时间序一致，足够概览用途。
 */
function mergeTimeSpan(prior: string | null | undefined, batch: RecordSourceMessage[]): string {
  const [batchMin, batchMax] = computeTimeBounds(batch);
  const batchStart = formatTimestamp(batchMin ?? undefined);
  const batchEnd = formatTimestamp(batchMax ?? undefined);
  const [priorStart, priorEnd] = parseTimeSpan(prior);

  const starts = [priorStart, batchStart].filter(Boolean);
  const ends = [priorEnd, batchEnd].filter(Boolean);
  const start = starts.length ? starts.reduce((a, b) => (a <= b ? a : b)) : '';
  const end = ends.length ? ends.reduce((a, b) => (a >= b ? a : b)) : '';
  if (!start && !end) return '';
  return start && end ? `${start} ~ ${end}` : start || end;
}

/** 把消息序列化成喂给生成模型的对话正文（含工具调用摘要、按字符预算截断） */
function serializeMessages(messages: RecordSourceMessage[]): string {
  const parts: string[] = [];
  let budget = MAX_SOURCE_CHARS;
  for (const msg of messages) {
    if (budget <= 0) {
      parts.push('…(更早内容因长度限制省略)');
      break;
    }
    const segments: string[] = [];
    const text = truncate(msg.content ?? '', PER_MESSAGE_CHARS);
    if (text) segments.push(text);
    if (Array.isArray(msg.toolCalls)) {
      for (const tc of msg.toolCalls) {
        const name = tc.name || '未知工具';
        const args = truncate(tc.arguments ?? '', 600);
        const result = truncate(tc.result ?? '', 800);
        segments.push(
          `〔工具调用〕${name}` +
          (args ? `\n  参数: ${args}` : '') +
          (result ? `\n  结果: ${result}` : '') +
          (tc.status ? `\n  状态: ${tc.status}` : ''),
        );
      }
    }
    if (segments.length === 0) continue;
    const block = `[${roleLabel(msg.role)}] ${segments.join('\n')}`;
    parts.push(block);
    budget -= block.length;
  }
  return parts.join('\n\n');
}

const TEMPLATE_RULES = `## 输出模板（严格遵守）

按下列固定结构输出纯 markdown 过程日志，不要用代码块包裹整个输出：

# 对话过程日志

## 用户意图
- 用要点概括用户在这段对话里想达成的目标（按出现顺序）

## 关键决策
- 列出 AI 做出的重要判断、方案选择、取舍及理由

## 工具调用与结果摘要
- 按时间顺序概括关键工具调用：做了什么、关键参数、得到什么结果（失败也记）
- 同类重复调用可合并；无工具调用则写「无」

## 产出文件清单
- 列出新建/修改/删除的文件路径及一句话说明；无则写「无」

要求：
1. 客观、信息密度高，省略寒暄与无关细节
2. 保留关键事实（文件路径、命令、报错、数字、决策理由）
3. 不要臆造未在对话中出现的内容
4. 全文控制在 1200 字以内`;

function buildCreatePrompt(input: GenerateRecordInput, body: string, totalRounds: number, totalSteps: number): string {
  return `你是一个技术过程记录助手。请把下面这段对话浓缩成结构化的「对话过程日志」，供后续轮次的 AI 快速回顾已发生的工作。

${TEMPLATE_RULES}

## 元数据（写入日志开头，逐字使用）
- 工作区: ${input.workspaceName || '（未指定）'}
- 覆盖轮次: ${totalRounds}
- 覆盖步骤: ${totalSteps}

## 对话内容

${body}`;
}

function buildUpdatePrompt(
  input: GenerateRecordInput,
  body: string,
  totalRounds: number,
  totalSteps: number,
  existing: string,
): string {
  return `你是一个技术过程记录助手。下面是某对话「已有的过程日志」和「新增对话内容」。请把新增内容合并进已有日志，输出更新后的完整日志（全文，不是增量）。

${TEMPLATE_RULES}

合并规则：
1. 保留已有日志中的关键信息，按新增内容扩展对应小节
2. 用户标记为「[手动补充]」的内容必须原样保留
3. 输出完整日志，覆盖到第 ${totalRounds} 轮

## 元数据（写入日志开头，逐字使用）
- 工作区: ${input.workspaceName || '（未指定）'}
- 覆盖轮次: ${totalRounds}
- 覆盖步骤: ${totalSteps}

## 已有过程日志

${existing}

## 新增对话内容

${body}`;
}

/** 从 store 的 settings slice 解析出可用的 AIClient 配置；缺 Key 返回 null */
function resolveClient(): AIClient | null {
  const state = store.getState() as any;
  const settings = state?.settings;
  const agentSettings = state?.agentSettings;
  const apiKey = settings?.apiKeys?.openai || '';
  const baseUrl = settings?.apiEndpoints?.openai || 'https://api.openai.com/v1';
  const model = agentSettings?.currentModel || '';
  if (!apiKey || !model) return null;
  // 低 temperature + 关闭流式，稳定一次性产出
  return new AIClient({
    apiKey,
    baseUrl,
    model,
    temperature: 0.2,
    maxTokens: 2048,
    stream: false,
    outputStrategy: 'off',
  });
}

/** 非流式收集一次完整回复；遇到 error chunk 抛出，超时抛出 */
async function callOnce(client: AIClient, messages: ChatMessage[]): Promise<string> {
  let content = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      client.abort();
      reject(new Error('record generation timeout'));
    }, GENERATE_TIMEOUT_MS);
  });

  const collect = (async () => {
    for await (const chunk of client.streamChat(messages)) {
      if (chunk.type === 'content' && chunk.content) content += chunk.content;
      if (chunk.type === 'error') throw new Error(chunk.error || 'record generation error');
    }
    return content;
  })();

  try {
    return await Promise.race([collect, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 轻量净化 + 校验模型输出。
 * - 若整体被 ``` 代码块包裹则剥离外层围栏；
 * - 必须包含 `# 对话过程日志` 标题，否则视为未遵守模板；
 * - 超长（明显跑飞）视为不合格。
 * 不合格返回 null，由调用方降级。
 */
function sanitizeOutput(raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;

  // 剥离把整段内容包进 ``` / ```markdown 的外层围栏（仅当首尾都是围栏时）
  if (text.startsWith('```')) {
    const firstNewline = text.indexOf('\n');
    if (firstNewline > 0 && text.endsWith('```')) {
      text = text.slice(firstNewline + 1, text.length - 3).trim();
    }
  }
  if (!text) return null;

  if (!text.includes(REQUIRED_HEADING)) return null;
  if (text.length > MAX_OUTPUT_CHARS) return null;
  return text;
}

/**
 * 统计模板 4 个固定小节之外的额外 `##` 二级标题数（弱语义概览信号）。
 * 模板本身固定含 4 个 `##`，故这里减去命中的固定小节，正常返回 0。
 */
function countSections(md: string): number {
  const headings = md.match(/^##\s+(.+)$/gm) ?? [];
  const fixed = new Set(['用户意图', '关键决策', '工具调用与结果摘要', '产出文件清单', '输出模板（严格遵守）']);
  let extra = 0;
  for (const h of headings) {
    const title = h.replace(/^##\s+/, '').trim();
    if (!fixed.has(title)) extra += 1;
  }
  return extra;
}

/**
 * 生成 / 增量更新对话过程日志。
 *
 * @returns 成功返回 GenerateRecordResult；任何失败/输出不合格返回 null（调用方据此降级）。
 */
export async function generateRecord(input: GenerateRecordInput): Promise<GenerateRecordResult | null> {
  try {
    // ★ messages 是本批切片；增量场景下不重叠、不含旧轮次。
    const messages = Array.isArray(input.messages) ? input.messages : [];
    if (messages.length === 0) return null;

    const client = resolveClient();
    if (!client) {
      console.warn('[recordGenerator] 缺少可用 API Key / 模型，跳过 record 生成');
      return null;
    }

    const hasExisting = !!(input.existingRecordMd && input.existingRecordMd.trim());
    const priorRounds = Math.max(0, input.priorRounds ?? 0);
    const priorSteps = Math.max(0, input.priorSteps ?? 0);

    // 本批切片本身即为新增，无需再按水位线跳过轮次（契约已保证不重叠）。
    const body = serializeMessages(messages);
    if (!body.trim()) return null;

    // 累计水位线 = 已覆盖 prior + 本批；时间跨度与已有跨度合并出整段起止。
    const totalRounds = priorRounds + messages.filter(m => m.role === 'user').length;
    const totalSteps = priorSteps + messages.length;
    const timeSpan = mergeTimeSpan(input.priorTimeSpan, messages);

    const prompt = hasExisting
      ? buildUpdatePrompt(input, body, totalRounds, totalSteps, input.existingRecordMd!.trim())
      : buildCreatePrompt(input, body, totalRounds, totalSteps);

    const contentMd = sanitizeOutput(await callOnce(client, [{ role: 'user', content: prompt }]));
    if (!contentMd) {
      console.warn('[recordGenerator] 输出不合格（缺模板头/超长/为空），降级');
      return null;
    }

    return {
      contentMd,
      totalRounds,
      totalSteps,
      phases: countSections(contentMd),
      timeSpan,
    };
  } catch (err) {
    // 关键降级点：绝不向上抛，让主对话回退字符截断压缩
    console.warn('[recordGenerator] generateRecord failed, falling back:', err);
    return null;
  }
}

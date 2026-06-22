/**
 * Synapse AI Client
 * OpenAI 兼容 API + SSE 流式解析
 * 支持 OpenAI / DeepSeek / OpenRouter / Ollama
 */

import { normalizeModelOption } from './modelCapabilities';
import type { AIModelOption } from '@/types/aiModel';
import type { OutputStrategy, PseudoStreamSpeed } from '@/store/slices/agentSettings';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[];
  tool_calls?: ToolCallRequest[];
  tool_call_id?: string;
}

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
  | { type: 'file'; file: { filename: string; file_data?: string; file_id?: string } };

export interface ToolCallRequest {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface AIClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stream?: boolean;
  outputStrategy?: OutputStrategy;
  pseudoStreamSpeed?: PseudoStreamSpeed;
  showStreamCursor?: boolean;
  showGeneratingPlaceholder?: boolean;
  streamThinking?: boolean;
  reasoningEffort?: string;
  speedTier?: string;
}

export interface StreamChunk {
  type: 'content' | 'thinking' | 'tool_call' | 'done' | 'error' | 'retry';
  content?: string;
  thinking?: string;
  toolCall?: ToolCallRequest;
  error?: string;
  streamMode?: 'real' | 'pseudo' | 'off';
  fallbackReason?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  // M2-S 任务2：重试进度可观测。每次退避重试【前】发一个该事件，让 UI 显示「正在重试 N/M」
  // 而非干等。仅在重试真实发生时发出，不改变现有【是否重试】判定与退避时长。
  retry?: { attempt: number; maxRetries: number; reason: string };
  // M4-8 审查修复：真流式读流【中途】断线重试，会让模型从头重生成整段回复。若本轮已 yield 过
  // 实质 content/thinking（已上屏 + 已累积进 fullContent），直接 continue 重发会造成「半截旧内容 +
  // 完整新内容」首尾拼接污染气泡与 conversation history。故在这类 retry chunk 上带 resetContent，
  // 让 agentLoop 收到时先丢弃本轮已上屏/已累积内容，再接收重试后的新流（覆盖而非追加）。
  resetContent?: boolean;
}

const DEFAULT_ENDPOINTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  ollama: 'http://localhost:11434/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

/**
 * M4-8-S5：最大重试次数共享常量（写死，不做设置项）。
 * streamChat（real）/ completeChat（off/pseudo）/ UI 文案的 N 统一引用此常量——
 * brief 文案「reconnect 1/5」暗示 5，最坏退避总等待约 2+4+8+10+10 ≈ 34s 才放弃，
 * 配合气泡 reconnect 进度让等待可见（见 Plan_5 第七节决议2）。
 */
export const MAX_RETRIES = 5;

/** 退避时长（指数，封顶 10s）：第 attempt 次重试前等待 min(1000 * 2^attempt, 10000) ms。 */
function backoffDelay(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 10000);
}

/**
 * M4-8-S1：错误分类——把「可重试性」判定集中到单一可测函数，杜绝散落各处的 status code 判定。
 *
 * 真根因修复（Plan_5 第三节【2】）：旧实现只看 HTTP status，把【被网关包装成 400/422 的上游故障】
 * （body 带 upstream_error / bad gateway / timeout / connection 等文案）误判为「不可重试的参数错」
 * 直接失败、不重连。这里对 400/422 额外看 body 文案：命中保守上游特征词 → 归为可重试 gateway_upstream。
 *
 * 判定优先级（自上而下，命中即返回）：
 *   ① abort（errName==='AbortError' 或 signalAborted）→ 不可重试 aborted（绝不能当网络错重试，
 *      否则 stop 触发重试死循环，见 Plan_5 风险三）。
 *   ② 429 → 可重试 rate_limit。
 *   ③ status >= 500 → 可重试 server_error。
 *   ④ fetch / 流读取异常（有 errName 但非 status，且非 abort）→ 可重试 network。
 *   ⑤ 400/422 且 body 命中上游特征词 → 可重试 gateway_upstream（命中时 console.warn 输出 body 摘要便于真机调参）。
 *   ⑥ 400/422 且 body 无上游特征 → 不可重试 client_error（真参数错）。
 *   ⑦ 401/403 → 不可重试 auth；404 → 不可重试 not_found；其它 → 不可重试 client_error。
 */
export type ErrorCategory =
  | 'rate_limit' | 'server_error' | 'network' | 'gateway_upstream'
  | 'client_error' | 'auth' | 'not_found' | 'aborted';

export interface ErrorClassification {
  retryable: boolean;
  category: ErrorCategory;
  /** 重试耗尽 / 不可重试时给用户的明确文案。 */
  userMessage: string;
}

/** 网关把上游 5xx / 超时 / 连接失败包装成 400/422 时 body 里常见的保守特征词（仅对 400/422 生效）。 */
const UPSTREAM_HINT_WORDS = [
  'upstream_error', 'upstream', 'bad gateway', 'gateway',
  'timeout', 'timed out', 'connection', 'econnreset', 'econnrefused',
  'socket hang up', 'temporarily unavailable', 'service unavailable',
];

export function classifyError(
  status?: number,
  body?: string,
  errName?: string,
  signalAborted?: boolean,
): ErrorClassification {
  // ① abort 优先级最高——绝不可重试，否则 stop 会触发重试死循环。
  if (errName === 'AbortError' || signalAborted) {
    return { retryable: false, category: 'aborted', userMessage: 'aborted' };
  }

  // 无 status：fetch / 流读取等抛异常（非 abort）→ 网络错，可重试。
  if (status === undefined) {
    return {
      retryable: true,
      category: 'network',
      userMessage: '🌐 网络连接异常，请检查网络后重试',
    };
  }

  // ② 限流
  if (status === 429) {
    return { retryable: true, category: 'rate_limit', userMessage: '⏳ 请求过于频繁，请稍后再试（429）' };
  }
  // ③ 服务器错误
  if (status >= 500) {
    return { retryable: true, category: 'server_error', userMessage: `🔥 服务器错误（${status}），请稍后重试` };
  }
  // ④/⑤ 400 / 422：看 body 文案区分「网关包装的上游故障」vs「真参数错」。
  if (status === 400 || status === 422) {
    const normalized = (body ?? '').toLowerCase();
    const hit = UPSTREAM_HINT_WORDS.some(word => normalized.includes(word));
    if (hit) {
      // 命中上游特征 → 当可重试上游故障；打 warn 摘要便于真机收紧词表。
      console.warn(`[AIClient] HTTP ${status} 命中上游故障特征，按可重试处理。body 摘要:`, (body ?? '').slice(0, 200));
      return {
        retryable: true,
        category: 'gateway_upstream',
        userMessage: `🔁 上游服务暂时不可用（被网关包装为 ${status}），已自动重试`,
      };
    }
    return { retryable: false, category: 'client_error', userMessage: `❌ 请求参数错误（${status}）：${(body ?? '').slice(0, 200)}` };
  }
  // ⑥ 鉴权 / 不存在
  if (status === 401 || status === 403) {
    return { retryable: false, category: 'auth', userMessage: '🔑 API Key 无效或已过期，请检查设置（401/403）' };
  }
  if (status === 404) {
    return { retryable: false, category: 'not_found', userMessage: '❌ 接口或模型不存在，请检查模型名称（404）' };
  }
  // ⑦ 其它 4xx 等 → 不可重试。
  return { retryable: false, category: 'client_error', userMessage: `HTTP ${status}: ${(body ?? '').slice(0, 200)}` };
}

const PSEUDO_STREAM_CHUNK_SIZE: Record<PseudoStreamSpeed, number> = {
  slow: 2,
  medium: 5,
  fast: 10,
};

const PSEUDO_STREAM_DELAY_MS: Record<PseudoStreamSpeed, number> = {
  slow: 55,
  medium: 22,
  fast: 8,
};

function isStreamUnsupported(status: number, text: string): boolean {
  const normalized = text.toLowerCase();
  return [400, 404, 405, 406, 415, 422, 501].includes(status)
    && (
      normalized.includes('stream')
      || normalized.includes('sse')
      || normalized.includes('event-stream')
      || normalized.includes('stream_options')
    );
}

function splitPseudoChunks(text: string, speed: PseudoStreamSpeed): string[] {
  const size = PSEUDO_STREAM_CHUNK_SIZE[speed] ?? PSEUDO_STREAM_CHUNK_SIZE.medium;
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

export class AIClient {
  private config: AIClientConfig;
  private abortController: AbortController | null = null;
  private _isStreaming = false;
  // ★ P0-2 根因B 加固：用户主动 stop 的显式标志。abort() 会把 abortController 置 null，
  //   此后 `this.abortController?.signal.aborted` 经 ?. 短路成 undefined，classifyError 拿不到「已中止」，
  //   极端时机下可能把用户主动停误判成网络错而重试。该标志独立于 abortController 生命周期，永真兜底。
  private _userAborted = false;

  constructor(config: AIClientConfig) {
    this.config = config;
  }

  get isStreaming(): boolean {
    return this._isStreaming;
  }

  updateConfig(config: Partial<AIClientConfig>) {
    if (this._isStreaming) {
      console.warn('[AIClient] 生成中禁止切换模型/配置');
      return;
    }
    Object.assign(this.config, config);
  }

  abort() {
    this._userAborted = true; // ★ P0-2：先置位，确保后续 classifyError 即使读不到 signal 也判 aborted。
    this.abortController?.abort();
    this.abortController = null;
    this._isStreaming = false;
  }

  /** P0-2：classifyError 用的「是否已被用户中止」统一口径——signal 与 _userAborted 取或，任一为真即中止。 */
  private get aborted(): boolean {
    return (this.abortController?.signal.aborted ?? false) || this._userAborted;
  }

  private buildBody(messages: ChatMessage[], tools: any[] | undefined, useStream: boolean): any {
    const body: any = {
      model: this.config.model,
      messages,
      stream: useStream,
    };
    // ★ 模型参数门控（诊断#3）：仅当上游显式提供时才写入请求体——不支持该参数的模型由 AgentPanel 传 undefined → 不发。
    //   去掉旧的 `?? 0.7`/`?? 4096` 无条件兜底，兑现面板「不支持的参数不会写入请求」承诺，避免严格端点 400。
    if (this.config.temperature !== undefined) body.temperature = this.config.temperature;
    if (this.config.maxTokens !== undefined) body.max_tokens = this.config.maxTokens;
    if (useStream) body.stream_options = { include_usage: true };
    if (this.config.topP !== undefined) body.top_p = this.config.topP;
    if (this.config.reasoningEffort && this.config.reasoningEffort !== 'auto') {
      body.reasoning_effort = this.config.reasoningEffort;
    }
    if (this.config.speedTier && this.config.speedTier !== 'auto') {
      body.speed_tier = this.config.speedTier;
    }
    if (tools?.length) body.tools = tools;
    return body;
  }

  private async requestChat(messages: ChatMessage[], tools: any[] | undefined, useStream: boolean): Promise<Response> {
    return fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(this.buildBody(messages, tools, useStream)),
      signal: this.abortController?.signal,
    });
  }

  private async waitPseudoDelay(speed: PseudoStreamSpeed): Promise<void> {
    const delay = PSEUDO_STREAM_DELAY_MS[speed] ?? PSEUDO_STREAM_DELAY_MS.medium;
    if (this.abortController?.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    await new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(resolve, delay);
      const signal = this.abortController?.signal;
      const onAbort = () => {
        globalThis.clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * M4-8-S1：可中断退避 sleep——退避等待期间用户 stop()（abort signal）能立即中断，
   * 不必干等满 delay（最高 10s）。复用 waitPseudoDelay 的「可中断 sleep」范本：
   * 进入即检查 signal.aborted；等待中监听 abort 立即 reject(AbortError)（由外层 catch 识别为 aborted，
   * 经 classifyError 归为不可重试，杜绝 stop 触发重试死循环，见 Plan_5 风险三）。
   * signal 缺省时取 this.abortController?.signal。
   */
  private async retryableSleep(delay: number, signal?: AbortSignal | null): Promise<void> {
    const sig = signal ?? this.abortController?.signal ?? null;
    if (sig?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    await new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(resolve, delay);
      const onAbort = () => {
        globalThis.clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      sig?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async *yieldResponseError(response: Response, errText: string): AsyncGenerator<StreamChunk> {
    const status = response.status;
    if (status === 429) {
      yield { type: 'error', error: '⏳ 请求过于频繁，请稍后再试（429）' };
      return;
    }
    if (status === 401 || status === 403) {
      yield { type: 'error', error: '🔑 API Key 无效或已过期，请检查设置（401/403）' };
      return;
    }
    if (status === 404) {
      const modelHint = errText.includes('model') ? `模型 "${this.config.model}" 不存在` : '接口不存在';
      yield { type: 'error', error: `❌ ${modelHint}，请检查模型名称（404）` };
      return;
    }
    if (status >= 500) {
      yield { type: 'error', error: `🔥 服务器错误（${status}），请稍后重试` };
      return;
    }
    yield { type: 'error', error: `HTTP ${status}: ${errText.slice(0, 200)}` };
  }

  private async *completeChat(
    messages: ChatMessage[],
    tools: any[] | undefined,
    mode: 'pseudo' | 'off',
    fallbackReason?: string,
  ): AsyncGenerator<StreamChunk> {
    // M4-8-S2：非流式路径（off/pseudo）补 retry 覆盖——原先 !ok 直接 yieldResponseError 返回、完全无重试，
    // 与全局「请求要有 retry/重连」决策冲突。这里复用 streamChat 同一套 classifyError + retryableSleep：
    //   - HTTP !ok：classifyError 判定可重试（429/5xx/网关 400-422 upstream）→ yield retry chunk（带 streamMode=mode，
    //     让 agentLoop 知道是非流式重试）→ 可中断退避重试；达上限或不可重试 → yieldResponseError 明确文案。
    //   - fetch / 解析异常：同样进 classifyError。AbortError throw 出去，由 streamChat off/pseudo 外层 catch 统一转 'aborted'
    //     （与现有行为一致），不在此当网络错重试，杜绝 stop 触发重试死循环。
    //   与现有 auto→pseudo 降级互不冲突：那是 streamChat 决定走哪条路，completeChat 只负责本条路内的重试。
    let response: Response;
    let retries = 0;
    while (true) {
      let httpResponse: Response | null = null;
      let fetchErr: any = null;
      try {
        httpResponse = await this.requestChat(messages, tools, false);
      } catch (err: any) {
        fetchErr = err;
      }

      if (httpResponse && httpResponse.ok) {
        response = httpResponse;
        break;
      }

      // 统一分类：有 response 用 status+body，否则用 fetch 异常名。
      const status = httpResponse?.status;
      const errText = httpResponse ? await httpResponse.text().catch(() => '') : '';
      const cls = classifyError(
        status,
        errText,
        fetchErr?.name,
        this.abortController?.signal.aborted,
      );

      if (cls.category === 'aborted') {
        // 让 streamChat off/pseudo 外层 catch 统一转 'aborted'，与现有中止收尾一致。
        throw new DOMException('Aborted', 'AbortError');
      }

      if (cls.retryable && retries < MAX_RETRIES) {
        retries++;
        const delay = backoffDelay(retries);
        yield { type: 'retry', retry: { attempt: retries, maxRetries: MAX_RETRIES, reason: cls.userMessage }, streamMode: mode, fallbackReason };
        await this.retryableSleep(delay, this.abortController?.signal);
        continue;
      }

      // 达上限或不可重试：给明确文案（HTTP 有 response 走 yieldResponseError 复用既有细分文案；
      // 纯 fetch 异常无 response，直接发 classifyError 文案）。
      if (httpResponse) {
        yield* this.yieldResponseError(httpResponse, errText);
      } else {
        yield { type: 'error', error: fetchErr?.message || cls.userMessage, streamMode: mode };
      }
      return;
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message ?? {};
    const speed = this.config.pseudoStreamSpeed ?? 'medium';
    const thinking = message.reasoning_content ?? message.reasoning ?? message.thinking;
    if (thinking) {
      const thinkingText = String(thinking);
      if (mode === 'pseudo' && this.config.streamThinking) {
        for (const part of splitPseudoChunks(thinkingText, speed)) {
          await this.waitPseudoDelay(speed);
          yield { type: 'thinking', thinking: part, streamMode: mode, fallbackReason };
        }
      } else {
        yield { type: 'thinking', thinking: thinkingText, streamMode: mode, fallbackReason };
      }
    }

    if (message.content) {
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      if (mode === 'pseudo') {
        for (const part of splitPseudoChunks(content, speed)) {
          await this.waitPseudoDelay(speed);
          yield { type: 'content', content: part, streamMode: mode, fallbackReason };
        }
      } else {
        yield { type: 'content', content, streamMode: mode };
      }
    }
    if (Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
        yield {
          type: 'tool_call',
          streamMode: mode,
          fallbackReason,
          toolCall: {
            id: tc.id ?? `call_${Math.random().toString(36).slice(2, 8)}`,
            type: 'function',
            function: {
              name: tc.function?.name ?? '',
              arguments: tc.function?.arguments ?? '',
            },
          },
        };
      }
    }
    if (data.usage) {
      yield {
        type: 'done',
        streamMode: mode,
        fallbackReason,
        usage: {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        },
      };
    } else {
      yield { type: 'done', streamMode: mode, fallbackReason };
    }
  }

  async *streamChat(
    messages: ChatMessage[],
    tools?: any[],
  ): AsyncGenerator<StreamChunk> {
    this._isStreaming = true;
    this._userAborted = false; // ★ P0-2：每次新流开始清零，避免上一轮 stop 标志污染本轮重试判定。
    this.abortController = new AbortController();
    const strategy = this.config.outputStrategy ?? (this.config.stream === false ? 'off' : 'auto');
    const modelCanStream = this.config.stream !== false;

    if (strategy === 'off') {
      try {
        yield* this.completeChat(messages, tools, 'off');
      } catch (err: any) {
        yield { type: 'error', error: err?.name === 'AbortError' ? 'aborted' : (err?.message || '网络错误'), streamMode: 'off' };
      } finally {
        this._isStreaming = false;
      }
      return;
    }

    if (strategy === 'pseudo' || (strategy === 'auto' && !modelCanStream)) {
      try {
        yield* this.completeChat(
          messages,
          tools,
          'pseudo',
          strategy === 'auto' && !modelCanStream ? '当前模型未声明支持真流式，已使用伪流式' : undefined,
        );
      } catch (err: any) {
        yield { type: 'error', error: err?.name === 'AbortError' ? 'aborted' : (err?.message || '网络错误'), streamMode: 'pseudo' };
      } finally {
        this._isStreaming = false;
      }
      return;
    }

    if (strategy === 'real' && !modelCanStream) {
      yield { type: 'error', error: '当前模型未声明支持真流式输出，请切换为自动或伪流式。', streamMode: 'off' };
      this._isStreaming = false;
      return;
    }

    let retries = 0;
    const maxRetries = MAX_RETRIES;
    // M4-8 审查修复：是否已向消费者 yield 过实质 content/thinking/tool_call。
    // 一旦为真，说明已有部分输出上屏 + 累积进 agentLoop 的 fullContent；此后真流式读流中途断线
    // 触发的重试会让模型从头重生成整段回复，必须让 agentLoop 先丢弃已发内容（resetContent）再覆盖，
    // 否则「半截旧 + 完整新」拼接污染气泡与 conversation history。仅真流式 read 中途断这一路径需要。
    let streamedAny = false;

    while (retries <= maxRetries) {
      try {
        const response = await this.requestChat(messages, tools, true);

        if (!response.ok) {
          const status = response.status;
          const errText = await response.text().catch(() => '');

          // 优先级① 真流式不支持 → auto 降级伪流式（最高优先，先于重试判定）。
          if (strategy === 'auto' && isStreamUnsupported(status, errText)) {
            yield* this.completeChat(messages, tools, 'pseudo', `真流式请求失败，已降级伪流式：HTTP ${status}`);
            this._isStreaming = false;
            return;
          }

          // M4-8-S1：优先级② 用统一 classifyError 判定可重试性（替换散落的 429/5xx/404 分支）。
          // 把「被网关包装成 400/422 的上游故障」（body 命中特征词）纳入可重试 gateway_upstream，修真根因。
          const cls = classifyError(status, errText, undefined, this.aborted);
          if (cls.retryable) {
            retries++;
            if (retries <= maxRetries) {
              const delay = backoffDelay(retries);
              // 重试前发进度事件（让 UI 显示「reconnect N/M」而非干等）。
              yield { type: 'retry', retry: { attempt: retries, maxRetries, reason: cls.userMessage }, streamMode: 'real' };
              // 可中断退避：用户 stop 时立即抛 AbortError，由外层 catch 识别为 aborted。
              await this.retryableSleep(delay, this.abortController?.signal);
              continue;
            }
            // 重试耗尽：可重试错也要给明确文案；auto 流式可再降级伪流式兜底。
            if (strategy === 'auto') {
              yield* this.completeChat(messages, tools, 'pseudo', `真流式重试耗尽，已降级伪流式：${cls.userMessage}`);
              this._isStreaming = false;
              return;
            }
            yield { type: 'error', error: cls.userMessage, streamMode: 'real' };
            this._isStreaming = false;
            return;
          }
          // 优先级③ 不可重试 → yieldResponseError（复用既有细分文案，如 404 带模型名、401/403 Key 提示）。
          yield* this.yieldResponseError(response, errText);
          this._isStreaming = false;
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          if (strategy === 'auto') {
            yield* this.completeChat(messages, tools, 'pseudo', '端点未返回可读流，已降级伪流式');
            this._isStreaming = false;
            return;
          }
          yield { type: 'error', error: '无法读取响应流' };
          return;
        }

        const decoder = new TextDecoder();
        let buffer = '';
        const toolCalls: Map<number, ToolCallRequest> = new Map();
        // ★ P0-2 根因A：是否收到过服务器明确的结束信号（finish_reason 非空 或 [DONE]）。
        //   用于在 reader 自然 done 时区分「正常完成」与「上游中途静默掐断」。
        let sawFinish = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === 'data: [DONE]') {
              if (trimmed === 'data: [DONE]') {
                // Emit accumulated tool calls
                for (const tc of toolCalls.values()) {
                  streamedAny = true;
                  yield { type: 'tool_call', toolCall: tc, streamMode: 'real' };
                }
                yield { type: 'done', streamMode: 'real' };
                this._isStreaming = false;
                return;
              }
              continue;
            }
            if (!trimmed.startsWith('data: ')) continue;

            try {
              const data = JSON.parse(trimmed.slice(6));
              // Usage chunks may arrive without delta when stream_options.include_usage is enabled.
              if (data.usage) {
                yield {
                  type: 'done',
                  streamMode: 'real',
                  usage: {
                    promptTokens: data.usage.prompt_tokens,
                    completionTokens: data.usage.completion_tokens,
                    totalTokens: data.usage.total_tokens,
                  },
                };
              }
              // ★ P0-2 根因A：先捕获 finish_reason（OpenAI 标准在最后一个 chunk 给出，此时 delta 常为空对象 {}），
              //   必须放在 `if (!delta) continue` 之前，否则空 delta 的结束 chunk 会被跳过、漏标 sawFinish。
              const choice = data.choices?.[0];
              if (choice?.finish_reason) sawFinish = true;
              const delta = choice?.delta;
              if (!delta) continue;

              if (delta.content) {
                streamedAny = true;
                yield { type: 'content', content: delta.content, streamMode: 'real' };
              }

              const thinking = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
              if (thinking) {
                streamedAny = true;
                yield { type: 'thinking', thinking: String(thinking), streamMode: 'real' };
              }

              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!toolCalls.has(idx)) {
                    toolCalls.set(idx, {
                      id: tc.id ?? `call_${idx}`,
                      type: 'function',
                      function: { name: '', arguments: '' },
                    });
                  }
                  const existing = toolCalls.get(idx)!;
                  if (tc.id) existing.id = tc.id;
                  if (tc.function?.name) existing.function.name += tc.function.name;
                  if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
                }
              }

            } catch {
              // Skip malformed JSON lines
            }
          }
        }

        // ★ P0-2 根因A（治本「回答说一半突然停」）：reader 自然返回 done=true 而非抛错。
        //   若全程从未收到 finish_reason、也无 [DONE]，但已 yield 过实质内容（streamedAny）——
        //   说明上游/网关在生成完成前【静默掐断】了连接（TCP 正常关闭，read 返回 done 不抛异常），
        //   内容被截断。抛进下面 catch 当可重试网络错（重连重发 + resetContent），
        //   而不是把半截内容当正常 done 收尾。
        //   注：标准 OpenAI 兼容端点必发 [DONE] 或 finish_reason 之一；仅 streamedAny 时判定，空响应不误伤。
        if (!sawFinish && streamedAny) {
          throw new Error('STREAM_TRUNCATED: 上游在生成完成前中断连接（无 finish_reason/[DONE]）');
        }
        // 正常结束（端点不发 [DONE] 但给了 finish_reason，或合法空响应）。
        for (const tc of toolCalls.values()) {
          yield { type: 'tool_call', toolCall: tc, streamMode: 'real' };
        }
        yield { type: 'done', streamMode: 'real' };
        this._isStreaming = false;
        return;

      } catch (err: any) {
        // M4-8-S1：fetch / 流读取异常统一进 classifyError。AbortError（含可中断退避抛出的）
        // 归为不可重试 aborted——绝不当网络错重试，杜绝 stop 触发重试死循环（Plan_5 风险三）。
        const cls = classifyError(undefined, undefined, err?.name, this.aborted);
        if (!cls.retryable) {
          // aborted：发 'aborted' 让 agentLoop 走中止收尾分支；其它不可重试（理论上 catch 这里只会是 abort）给文案。
          yield { type: 'error', error: cls.category === 'aborted' ? 'aborted' : (err?.message || cls.userMessage) };
          this._isStreaming = false;
          return;
        }
        retries++;
        if (retries > maxRetries) {
          if (strategy === 'auto') {
            // M4-8 审查修复：读流中途断线已上屏部分内容时，降级伪流式会一次性吐全量，
            // 同样会拼接到半截旧内容后。先发 resetContent 让 agentLoop 清空已发内容再覆盖。
            if (streamedAny) {
              yield { type: 'retry', retry: { attempt: retries, maxRetries, reason: '连接中断，重置后改用伪流式重发' }, streamMode: 'pseudo', resetContent: true };
            }
            yield* this.completeChat(messages, tools, 'pseudo', `真流式连接失败，已降级伪流式：${err.message || '网络错误'}`);
            this._isStreaming = false;
            return;
          }
          yield { type: 'error', error: err.message || cls.userMessage };
          this._isStreaming = false;
          return;
        }
        const delay = backoffDelay(retries);
        // 网络异常重试前发进度事件。
        // M4-8 审查修复（问题2/3）：真流式读流【中途】断线（已 yield 过实质内容 streamedAny）重试时，
        // 重发会让模型从头重生成整段回复。带 resetContent 让 agentLoop 先清空本轮已上屏/已累积内容，
        // 重试后的新流覆盖而非追加，杜绝「半截旧 + 完整新」拼接污染气泡与 conversation history。
        yield {
          type: 'retry',
          retry: { attempt: retries, maxRetries, reason: err?.message ? `连接异常（${String(err.message).slice(0, 60)}）` : cls.userMessage },
          streamMode: 'real',
          resetContent: streamedAny,
        };
        // 已发过内容则重发等价于「从头重来」，重置标志，重试连接再次 yield 才重新置位。
        streamedAny = false;
        // 可中断退避：用户 stop 时立即抛 AbortError。
        // M4-8 审查修复（问题1）：catch 块尾退避不像 HTTP !ok 退避（line 512）那样有外层 try 兜底——
        // 此处单独包 try/catch，abort 时与 HTTP !ok 退避路径对齐：干净 yield aborted 收尾后 return，
        // 不让 AbortError 逃逸出 while 与整个 generator（否则一路落到 agentLoop 顶层 catch，
        // 会先塞一条假 error 事件污染 run 历史，再靠 this.running===false 这个外部不变量兜回 aborted）。
        try {
          await this.retryableSleep(delay, this.abortController?.signal);
        } catch (sleepErr: any) {
          const sleepCls = classifyError(undefined, undefined, sleepErr?.name, this.aborted);
          if (sleepCls.category === 'aborted') {
            yield { type: 'error', error: 'aborted', streamMode: 'real' };
            this._isStreaming = false;
            return;
          }
          // 理论上 retryableSleep 只会抛 AbortError；其它异常保守按不可重试失败处理，不再 continue。
          yield { type: 'error', error: sleepErr?.message || sleepCls.userMessage, streamMode: 'real' };
          this._isStreaming = false;
          return;
        }
      }
    }
  }

  static getEndpoint(provider: string): string {
    return DEFAULT_ENDPOINTS[provider] ?? DEFAULT_ENDPOINTS.openai;
  }

  /**
   * 从 API 动态获取可用模型列表
   * 自动清洗某些 API（如聚光）在模型 ID 中嵌入的价格前缀 [xxx]
   */
  static async fetchModels(apiKey: string, baseUrl: string): Promise<AIModelOption[]> {
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (!response.ok) {
        console.error(`[AIClient] fetchModels failed: HTTP ${response.status}`);
        return [];
      }
      const data = await response.json();
      const models = data.data ?? data;
      if (!Array.isArray(models)) return [];

      return models.map((m: any) => normalizeModelOption(m)).filter(Boolean) as AIModelOption[];
    } catch (err: any) {
      console.error('[AIClient] fetchModels error:', err.message);
      return [];
    }
  }
}

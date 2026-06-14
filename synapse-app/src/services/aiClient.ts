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
  type: 'content' | 'thinking' | 'tool_call' | 'done' | 'error';
  content?: string;
  thinking?: string;
  toolCall?: ToolCallRequest;
  error?: string;
  streamMode?: 'real' | 'pseudo' | 'off';
  fallbackReason?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

const DEFAULT_ENDPOINTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  ollama: 'http://localhost:11434/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

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
    this.abortController?.abort();
    this.abortController = null;
    this._isStreaming = false;
  }

  private buildBody(messages: ChatMessage[], tools: any[] | undefined, useStream: boolean): any {
    const body: any = {
      model: this.config.model,
      messages,
      temperature: this.config.temperature ?? 0.7,
      max_tokens: this.config.maxTokens ?? 4096,
      stream: useStream,
    };
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
    const response = await this.requestChat(messages, tools, false);
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      yield* this.yieldResponseError(response, errText);
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
    const maxRetries = 3;

    while (retries <= maxRetries) {
      try {
        const response = await this.requestChat(messages, tools, true);

        if (!response.ok) {
          const status = response.status;
          const errText = await response.text().catch(() => '');

          if (strategy === 'auto' && isStreamUnsupported(status, errText)) {
            yield* this.completeChat(messages, tools, 'pseudo', `真流式请求失败，已降级伪流式：HTTP ${status}`);
            this._isStreaming = false;
            return;
          }

          // Stage 5: 错误类型细分
          if (status === 429) {
            retries++;
            if (retries <= maxRetries) {
              const delay = Math.min(1000 * Math.pow(2, retries), 10000);
              await new Promise(r => setTimeout(r, delay));
              continue;
            }
            yield { type: 'error', error: '⏳ 请求过于频繁，请稍后再试（429）' };
            this._isStreaming = false;
            return;
          }
          if (status === 401 || status === 403) {
            yield { type: 'error', error: '🔑 API Key 无效或已过期，请检查设置（401/403）' };
            this._isStreaming = false;
            return;
          }
          if (status === 404) {
            const modelHint = errText.includes('model') ? `模型 "${this.config.model}" 不存在` : '接口不存在';
            yield { type: 'error', error: `❌ ${modelHint}，请检查模型名称（404）` };
            this._isStreaming = false;
            return;
          }
          if (status >= 500) {
            retries++;
            if (retries <= maxRetries) {
              const delay = Math.min(1000 * Math.pow(2, retries), 10000);
              await new Promise(r => setTimeout(r, delay));
              continue;
            }
            yield { type: 'error', error: `🔥 服务器错误（${status}），请稍后重试` };
            this._isStreaming = false;
            return;
          }
          yield { type: 'error', error: `HTTP ${status}: ${errText.slice(0, 200)}` };
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
              const delta = data.choices?.[0]?.delta;
              if (!delta) continue;

              if (delta.content) {
                yield { type: 'content', content: delta.content, streamMode: 'real' };
              }

              const thinking = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
              if (thinking) {
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

        // If we reach here without [DONE], emit done
        for (const tc of toolCalls.values()) {
          yield { type: 'tool_call', toolCall: tc, streamMode: 'real' };
        }
        yield { type: 'done', streamMode: 'real' };
        this._isStreaming = false;
        return;

      } catch (err: any) {
        if (err.name === 'AbortError') {
          yield { type: 'error', error: 'aborted' };
          this._isStreaming = false;
          return;
        }
        retries++;
        if (retries > maxRetries) {
          if (strategy === 'auto') {
            yield* this.completeChat(messages, tools, 'pseudo', `真流式连接失败，已降级伪流式：${err.message || '网络错误'}`);
            this._isStreaming = false;
            return;
          }
          yield { type: 'error', error: err.message || '网络错误' };
          this._isStreaming = false;
          return;
        }
        const delay = Math.min(1000 * Math.pow(2, retries), 10000);
        await new Promise(r => setTimeout(r, delay));
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

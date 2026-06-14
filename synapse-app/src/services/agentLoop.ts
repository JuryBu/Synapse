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
import { promptBuilder, compressContext, MAX_CONTEXT_TOKENS } from './systemPrompt';
import { getRecord, upsertRecord } from './recordStore';
import { generateRecord } from './recordGenerator';
import { consumeTrackedFileChanges } from './fileChangeTracker';

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

export class AgentLoop {
  private client: AIClient;
  private tools: ToolDefinition[] = [];
  private toolExecutor: ToolExecutor | null = null;
  private running = false;

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
  }

  async run(userMessage: string, opts?: { skipUserMessage?: boolean; contentParts?: MessageContentPart[]; attachments?: AttachmentRef[] }): Promise<void> {
    this.running = true;
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
    const realTokenCount = (rootState as any).conversation?.tokenUsage?.totalTokens;
    const { compressed, wasCompressed } = compressContext(
      requestHistory.map(m => ({ role: m.role, content: chatContentToText(m.content) })),
      modelContextWindow,
      realTokenCount,
    );

    // M1 Step2: 压缩时优先用 record（结构化摘要）作稳定前缀以命中 prompt cache；
    // 无对话 id / record 生成失败时回退到 compressContext 的字符截断。
    let apiHistory: ChatMessage[];
    if (wasCompressed) {
      const keepCount = compressed.length - 1; // compressContext 保留的最近原文条数
      const conversationId = (rootState as any).conversation?.id as string | null;
      let recordMd: string | null = null;
      if (conversationId) {
        try {
          const existingRecord = await getRecord(conversationId);
          recordMd = existingRecord?.contentMd ?? null;
          const batchEnd = Math.max(0, requestHistory.length - keepCount);
          const batchStart = Math.min(existingRecord?.totalSteps ?? 0, batchEnd);
          const batchSlice = requestHistory.slice(batchStart, batchEnd);
          if (batchSlice.length > 0) {
            const recordResult = await generateRecord({
              conversationId,
              messages: batchSlice.map(m => ({
                role: m.role as 'user' | 'assistant' | 'system' | 'tool',
                content: chatContentToText(m.content),
              })),
              existingRecordMd: existingRecord?.contentMd ?? null,
              priorRounds: existingRecord?.totalRounds ?? 0,
              priorSteps: existingRecord?.totalSteps ?? 0,
              priorTimeSpan: existingRecord?.timeSpan ?? null,
              workspaceName: workspaceName || undefined,
            });
            if (recordResult) {
              await upsertRecord({
                conversationId,
                contentMd: recordResult.contentMd,
                totalRounds: recordResult.totalRounds,
                totalSteps: recordResult.totalSteps,
                phases: recordResult.phases,
                lastUpdatedRound: recordResult.totalRounds,
                timeSpan: recordResult.timeSpan,
              });
              recordMd = recordResult.contentMd;
            }
          }
        } catch (err) {
          console.warn('[agentLoop] record 压缩失败，回退字符截断:', err);
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
    } else {
      apiHistory = requestHistory;
    }

    // Prepend system prompt to compressed messages
    const apiMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...apiHistory,
    ];

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

    store.dispatch(clearStreamingContent());
    this.running = false;
  }

}

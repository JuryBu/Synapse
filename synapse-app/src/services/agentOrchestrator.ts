/**
 * Synapse Agent Orchestrator
 * Multi-AI 协作编排引擎
 *
 * 职责：
 * 1. 管理主 Agent 和 Subagent 的生命周期
 * 2. spawn_subagent 工具的后端实现
 * 3. Subagent 独立上下文管理
 * 4. 结果汇总与报告生成
 *
 * ★ M3-1a 真子代理（方案 A）：spawnSubagent 从【旧单次 LLM 问答】升级成【CC 式真子代理工具循环】——
 *   在 spawnSubagent 内部独立实现工具循环、复用 toolRegistry，绝不碰主 agentLoop.run、不污染主对话
 *   conversation slice（子代理对话作为独立 conversation 落库，parent_id=主对话 id + is_subagent 标记）。
 *   - 工具循环：参考 agentLoop.run 的 tool_calls 解析/执行模式（streamChat → 解析 tool_calls →
 *     toolRegistry.execute → tool 消息加回 → 多轮），但独立实现、不 dispatch 主 conversation slice。
 *   - maxDepth：派发深度递归层数控制。子代理工具集 maxDepth>1 含 spawn_subagent（孙代理 maxDepth-1）、
 *     <=1 剔除（不能再派）。逐层递减防无限派发。
 *   - contextId 隔离：子代理 toolRegistry.execute 全程传 contextId=subagentId（复用 M2-5 byContext），
 *     使并行子代理各自 worktree/状态不串台。
 */

import { store } from '@/store';
import { AIClient, type ChatMessage, type ToolCallRequest } from './aiClient';
import {
  addRunningSubagent,
  updateSubagentStatus,
  type SubagentConfig,
  type MultiAIMode,
} from '@/store/slices/multiAI';
import { addNotification } from '@/store/slices/notifications';
import { toolRegistry } from './toolRegistry';
import { saveConversationSnapshot, createConversationId } from './conversationPersistence';
import { consumeTrackedFileChanges } from './fileChangeTracker';
import type { Message } from '@/store/slices/conversation';

export interface SubagentTask {
  taskDescription: string;
  contextFiles?: string[];
  parentMessages?: ChatMessage[];
  config: SubagentConfig;
  /** 主对话 id（子代理对话落库时作 parent_id；卡片归属）。可选——无主对话时落 null。 */
  parentConversationId?: string;
}

export interface SubagentResult {
  subagentId: string;
  role: string;
  status: 'complete' | 'error';
  report: string;
  toolCallsUsed: number;
  tokensUsed: number;
  duration: number;
  /** 子代理对话落库的独立 conversation id（供 M3-3 卡片点进查看完整对话流）。落库失败为 undefined。 */
  conversationId?: string;
}

/** 子代理工具循环最大轮数——防失控（参考 agentLoop MAX_TOOL_ROUNDS=25，子代理收敛任务取更紧的 15）。 */
const SUBAGENT_MAX_ROUNDS = 15;

/** maxDepth 缺省值：不填 → 不允许子代理再派发（深度 1）。 */
const DEFAULT_MAX_DEPTH = 1;

/**
 * ★ medium#1 墙钟超时（wall-clock timeout）。SUBAGENT_MAX_ROUNDS 只限【轮数】不限【时长】：
 *   单轮 client.streamChat 若服务端 hang 住不返回数据也不报错，子代理会永久卡在 round 内的 for-await
 *   （chunk 间的 signal 检查也轮不到）。这里给每轮加一个【静默看门狗】：自上次收到任何 chunk 起，
 *   超过 SUBAGENT_STALL_TIMEOUT_MS 仍无新数据 → 触发 abort（联动 client.abort() 让在途 fetch/reader 抛出），
 *   本轮按 error 路径收尾，不再无限挂起。收到任意 chunk 即重置看门狗，故正常长流式不会被误杀。
 *   另设整轮总时长上限 SUBAGENT_ROUND_HARD_TIMEOUT_MS 兜底（防数据细水长流但永不结束的极端情况）。
 */
const SUBAGENT_STALL_TIMEOUT_MS = 90_000;
const SUBAGENT_ROUND_HARD_TIMEOUT_MS = 600_000;

export class AgentOrchestrator {
  private activeSubagents: Map<string, AbortController> = new Map();
  /**
   * ★ M3-1a 派发深度链：记录每个【活动子代理 contextId(=subagentId)】当前持有的 maxDepth。
   * spawn_subagent 工具执行时，由 ctx.contextId 查这里拿父代理的 maxDepth，给孙代理传 maxDepth-1。
   * 主 AI（主对话 contextId 不在此 map）派子代理时不查这里、直接用工具入参/配置的 maxDepth。
   * 子代理执行期内有效，spawnSubagent finally 清理（避免泄漏到下一次复用同 id 的场景，实际 id 含时间戳唯一）。
   */
  private depthByContext: Map<string, number> = new Map();

  /**
   * 查询某 contextId（子代理）当前持有的 maxDepth。spawn_subagent 工具用：
   * 父代理是子代理时 → 返回其 maxDepth（孙代理用 maxDepth-1）；contextId 非活动子代理（如主对话）→ 返回 undefined。
   */
  getContextMaxDepth(contextId?: string): number | undefined {
    if (!contextId) return undefined;
    return this.depthByContext.get(contextId);
  }

  /**
   * 获取当前激活的 Multi-AI 模式
   */
  getActiveMode(): MultiAIMode | null {
    const state = store.getState() as any;
    const multiAI = state.multiAI;
    if (!multiAI?.enabled || !multiAI?.activeMode) return null;
    return multiAI.modes.find((m: MultiAIMode) => m.id === multiAI.activeMode) || null;
  }

  /**
   * 检查是否应该自动 spawn subagent
   */
  shouldAutoSpawn(trigger: 'stageComplete' | 'reviewPhase' | 'userRequest' | 'error'): SubagentConfig[] {
    const mode = this.getActiveMode();
    if (!mode) return [];
    if (!mode.triggerConditions.includes(trigger)) return [];
    return mode.subagents;
  }

  /**
   * 解析本子代理可用的工具集（schemas）：
   *   - maxDepth > 1 → 【含】spawn_subagent（允许其派孙代理，孙代理 maxDepth-1）；
   *   - maxDepth <= 1 → 【剔除】spawn_subagent（不能再派）。
   * 其它工具一律不限（Plan_4_M3 四：子代理除「是否能继续派」外工具不受限）。
   */
  private buildSubagentTools(maxDepth: number): any[] {
    const all = toolRegistry.getSchemas() as any[];
    if (maxDepth > 1) return all;
    return all.filter(t => t?.function?.name !== 'spawn_subagent');
  }

  /**
   * Spawn 一个独立的 Subagent（M3-1a：真子代理工具循环）。
   */
  async spawnSubagent(task: SubagentTask): Promise<SubagentResult> {
    const state = store.getState() as any;
    const settings = state.settings;
    const multiAI = state.multiAI;
    const startTime = Date.now();

    // 确定使用的模型（默认复用主对话模型，可单独配；Plan_4_M3 四）。
    const model = task.config.model || multiAI.subagentDefaultModel || state.agentSettings?.currentModel || '';
    const apiKey = settings.apiKeys?.openai || '';
    const baseUrl = settings.apiEndpoints?.openai || 'https://api.openai.com/v1';

    if (!apiKey) {
      throw new Error('未配置 API Key，无法创建 Subagent');
    }

    // 本子代理的 maxDepth（正整数；不填默认 1=不许再派）。孙代理由 spawn_subagent 工具传 maxDepth-1，
    // 落到 task.config.maxDepth，逐层递减。clamp 到 [1, ∞) 防异常入参。
    const maxDepth = Math.max(1, Math.floor(task.config.maxDepth ?? DEFAULT_MAX_DEPTH));

    // 创建独立 AI Client
    const client = new AIClient({
      apiKey,
      baseUrl,
      model,
      temperature: 0.3, // Subagent 低 temperature
      maxTokens: task.config.maxTokens,
    });

    const subagentId = `sub-${task.config.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const abortController = new AbortController();
    this.activeSubagents.set(subagentId, abortController);
    // ★ 外部 abortAll() 调 controller.abort() 时，联动 abort 在途的 client.streamChat——
    //   否则只能等下一个 chunk 才靠 signal 检查跳出循环（streamChat 整体挂起时会卡）。client.abort() 让其立即抛 aborted。
    abortController.signal.addEventListener('abort', () => client.abort(), { once: true });
    // 登记本子代理的 maxDepth：其内部若调 spawn_subagent，工具据 contextId=subagentId 查到本值，孙代理用 -1。
    this.depthByContext.set(subagentId, maxDepth);

    const parentConversationId = task.parentConversationId
      || ((state?.conversation?.id as string | null) ?? '')
      || '';

    // 注册到 Redux（卡片可视化打底：四色 + 模型 + 角色 + 起止 + 深度）
    store.dispatch(addRunningSubagent({
      id: subagentId,
      parentConversationId,
      status: 'running',
      model,
      role: task.config.role,
      startTime,
      depth: maxDepth,
    }));

    store.dispatch(addNotification({
      type: 'info',
      title: 'Subagent 已启动',
      message: `${task.config.name} 正在执行: ${task.taskDescription.slice(0, 50)}...`,
    }));

    let toolCallsUsed = 0;
    // 子代理完整消息序列（system + user + 每轮 assistant/tool）——既驱动工具循环，跑完作为独立对话落库。
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: [
          '# Synapse Subagent 协作指南',
          '',
          '你是一个专注任务的子代理：',
          '1. 你有独立的上下文窗口，不受主对话影响',
          '2. 你可以使用工具（读写文件、搜索、执行命令等）来完成任务，多步推进直到任务完成',
          '3. 完成任务后返回结构化报告给主 Agent（报告是你最后一轮不带工具调用的纯文本回复）',
          '4. 保持报告简洁，突出关键发现',
          '5. 你不直接与用户交互',
          maxDepth > 1
            ? '6. 你可以调用 spawn_subagent 进一步派发子代理协助（注意派发深度有限）'
            : '6. 你不能再派发子代理，请自己完成任务',
          '',
          `## 你的角色: ${task.config.name}`,
          '',
          task.config.systemPrompt,
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `## 任务`,
          task.taskDescription,
          ...(task.contextFiles?.length
            ? ['', '## 相关文件', ...task.contextFiles.map(f => `- ${f}`)]
            : []),
        ].join('\n'),
      },
    ];

    try {
      const tools = this.buildSubagentTools(maxDepth);
      const useTools = tools.length > 0;
      let report = '';

      // ★ 工具循环（独立实现，参考 agentLoop.run 但不 dispatch 主 conversation slice）：
      //   每轮 streamChat 收集 content + tool_calls；有 tool_calls → 逐个 toolRegistry.execute(contextId=subagentId)、
      //   结果以 tool 消息加回 messages、继续下一轮；无 tool_calls → 结束，report = 本轮 content。最多 SUBAGENT_MAX_ROUNDS 轮。
      let round = 0;
      while (round < SUBAGENT_MAX_ROUNDS) {
        round++;
        if (abortController.signal.aborted) throw new Error('Subagent 已被终止');

        let roundContent = '';
        const pendingToolCalls: ToolCallRequest[] = [];
        let sawRetry = false;
        let lastError = '';

        // ★ medium#1 墙钟看门狗：超时触发 abort（联动 client.abort()），timedOut 区分「超时」与「用户终止」。
        let timedOut = false;
        let stallTimer: ReturnType<typeof setTimeout> | undefined;
        const armStallTimer = () => {
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = setTimeout(() => {
            timedOut = true;
            abortController.abort(); // 联动 client.abort()（line 150 addEventListener）让在途 fetch/reader 立即抛出
          }, SUBAGENT_STALL_TIMEOUT_MS);
        };
        // 整轮硬上限：数据细水长流但永不结束时兜底。
        const hardTimer = setTimeout(() => {
          timedOut = true;
          abortController.abort();
        }, SUBAGENT_ROUND_HARD_TIMEOUT_MS);
        armStallTimer();

        try {
          const stream = client.streamChat(messages, useTools ? tools : undefined);
          for await (const chunk of stream) {
            armStallTimer(); // 收到任意 chunk → 重置静默看门狗（正常长流式不被误杀）
            if (abortController.signal.aborted) break;
            if (chunk.type === 'content' && chunk.content) {
              roundContent += chunk.content;
            } else if (chunk.type === 'tool_call' && chunk.toolCall) {
              pendingToolCalls.push(chunk.toolCall);
            } else if (chunk.type === 'retry') {
              // 黄色：retry/重连阻塞（卡片四色之一）。收到任何实质数据前置 retrying，本轮结束自动转回 running/complete。
              if (!sawRetry) {
                sawRetry = true;
                store.dispatch(updateSubagentStatus({ id: subagentId, status: 'retrying' }));
              }
            } else if (chunk.type === 'error') {
              // 超时触发的 abort 也会让 streamChat yield aborted；timedOut 已置位时按超时收尾（下方统一抛）。
              if (chunk.error === 'aborted' && !timedOut) throw new Error('Subagent 已被终止');
              if (chunk.error !== 'aborted') lastError = String(chunk.error || 'Subagent 执行失败');
            }
          }
        } finally {
          if (stallTimer) clearTimeout(stallTimer);
          clearTimeout(hardTimer);
        }
        // 本轮收到数据后从 retrying 回到 running（若曾置黄）。
        if (sawRetry && !abortController.signal.aborted) {
          store.dispatch(updateSubagentStatus({ id: subagentId, status: 'running' }));
        }
        // 超时优先于「用户终止」判定：明确告知是墙钟超时而非手动 abort（走 catch 的 error 收尾路径）。
        if (timedOut) {
          throw new Error(`Subagent 单轮无响应超时（${Math.round(SUBAGENT_STALL_TIMEOUT_MS / 1000)}s 内未收到数据或整轮超 ${Math.round(SUBAGENT_ROUND_HARD_TIMEOUT_MS / 1000)}s），已自动终止`);
        }
        if (abortController.signal.aborted) throw new Error('Subagent 已被终止');
        // ★ medium#2 收紧：本轮 stream 报错（非 aborted）且无待执行工具调用时，无论是否已产出部分 content
        //   都应抛错——区分「有内容的正常收尾（无 error）」与「有内容但 stream 中途报错截断」。
        //   旧逻辑三者(lastError && !roundContent && 无工具)同时成立才抛，会把 HTTP 500/网络错误中断后的
        //   残缺 roundContent 当 status:'complete' 的最终报告返回（假成功）。把 lastError 拼进消息便于卡片溯源。
        //   pendingToolCalls 非空时不抛：工具调用结构已完整可执行，让本轮照常执行工具进入下一轮（容错）。
        if (lastError && pendingToolCalls.length === 0) {
          throw new Error(
            roundContent
              ? `${lastError}（流式在产出部分内容后中断，报告不完整）`
              : lastError,
          );
        }

        // 记录本轮 assistant 消息（含 tool_calls，供下一轮 API 上下文连续 + 落库还原对话流）。
        messages.push({
          role: 'assistant',
          content: roundContent || '',
          tool_calls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
        });

        // 无工具调用 → 对话完成，本轮 content 即报告。
        if (pendingToolCalls.length === 0) {
          report = roundContent;
          break;
        }

        // 有工具调用 → 逐个执行（contextId=subagentId 隔离），结果以 tool 消息加回，进入下一轮。
        for (const tc of pendingToolCalls) {
          if (abortController.signal.aborted) throw new Error('Subagent 已被终止');
          toolCallsUsed++;
          let toolResult: string;
          try {
            const args = JSON.parse(tc.function.arguments || '{}');
            // ★ medium#4：传 meta 标识子代理来源，审批框显示「子代理「角色」请求…」，与主代理区分。
            toolResult = await toolRegistry.execute(tc.function.name, args, subagentId, {
              isSubagent: true,
              subagentRole: task.config.name,
            });
          } catch (err: any) {
            toolResult = `Error: ${err?.message ?? err}`;
          }
          // ★ Codex P2-1 修复（防泄漏给主代理）：write_to_file 等工具把改动记进 fileChangeTracker；
          //   medium#3/#5 根治后账本按 contextId 分桶——子代理工具用 contextId=subagentId 入桶，这里 consume
          //   自己桶丢弃即可（子代理对话只读回看、不渲染 diff 卡片）。即便后续 spawnMultiple 并发，各子代理
          //   与主 agentLoop 各操作独立桶，不再相互 splice 串台。consume 后清空本桶（也防 Map 增长）。
          consumeTrackedFileChanges(subagentId);
          messages.push({
            role: 'tool',
            content: toolResult,
            tool_call_id: tc.id,
          });
        }
        // 达到上限仍有未决工具调用 → 用已有内容兜底为报告（防失控），下一轮 while 条件 false 自然退出。
        if (round >= SUBAGENT_MAX_ROUNDS) {
          report = roundContent || `（子代理已达最大工具轮数 ${SUBAGENT_MAX_ROUNDS}，提前收尾）`;
        }
      }

      // 粗估 token：所有消息文本字符 / 4（与旧口径一致，仅作卡片展示）。
      const tokensUsed = Math.round(
        messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0) / 4,
      );

      // ★ 子代理对话落库为独立 conversation（parent_id=主对话 id + is_subagent 标记），供 M3-3 卡片点进查看。
      //   不进 Redux 当前对话 slice（不污染主对话 UI）。落库失败不影响 report 回插主对话（加速层）。
      const conversationId = await this.persistSubagentConversation(
        subagentId,
        task,
        messages,
        model,
        parentConversationId,
      );

      const result: SubagentResult = {
        subagentId,
        role: task.config.name,
        status: 'complete',
        report,
        toolCallsUsed,
        tokensUsed,
        duration: Date.now() - startTime,
        conversationId,
      };

      store.dispatch(updateSubagentStatus({
        id: subagentId,
        status: 'complete',
        result: report,
        endTime: Date.now(),
        toolCallsUsed,
        tokensUsed,
        conversationId,
      }));

      store.dispatch(addNotification({
        type: 'success',
        title: 'Subagent 完成',
        message: `${task.config.name} 已完成 (${((Date.now() - startTime) / 1000).toFixed(1)}s, ${toolCallsUsed} 次工具调用)`,
      }));

      return result;
    } catch (err: any) {
      const message = err?.message ?? String(err);
      // 即便失败也尝试落库已产生的部分对话（便于卡片回看子代理跑到哪一步）。失败吞掉。
      const conversationId = await this.persistSubagentConversation(
        subagentId,
        task,
        messages,
        model,
        parentConversationId,
      ).catch(() => undefined);

      store.dispatch(updateSubagentStatus({
        id: subagentId,
        status: 'error',
        result: message,
        endTime: Date.now(),
        toolCallsUsed,
        conversationId,
      }));

      store.dispatch(addNotification({
        type: 'error',
        title: 'Subagent 失败',
        message: `${task.config.name}: ${message}`,
      }));

      return {
        subagentId,
        role: task.config.name,
        status: 'error',
        report: `❌ 错误: ${message}`,
        toolCallsUsed,
        tokensUsed: 0,
        duration: Date.now() - startTime,
        conversationId,
      };
    } finally {
      this.activeSubagents.delete(subagentId);
      this.depthByContext.delete(subagentId);
    }
  }

  /**
   * 把子代理的消息序列作为一个独立 conversation 落库（复用 conversations 表）。
   * - parentId = 主对话 id（卡片归属 + 树形溯源，复用 M2-3 parent_id）。
   * - isSubAgent = true（conversations.is_subagent 列；卡片据此识别/筛选子对话）。
   * - 不进 Redux 当前对话 slice（不污染主对话 UI）。
   * - Web 无 better-sqlite3 时由 conversationPersistence/platform 自动降级到 localStorage（双模式对等）。
   * 把子代理内部 ChatMessage 序列转成持久化用的 Message[]（剥掉 tool_calls/tool_call_id 等 API 专用字段，
   * 落「可读对话流」——role/content/timestamp/model）。失败返回 undefined（加速层，不阻塞主流程）。
   */
  private async persistSubagentConversation(
    subagentId: string,
    task: SubagentTask,
    messages: ChatMessage[],
    model: string,
    parentConversationId: string,
  ): Promise<string | undefined> {
    try {
      const now = Date.now();
      const persistMessages: Message[] = messages.map((m, idx) => ({
        id: `${subagentId}-msg-${idx}`,
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content
          // 多模态 part 落库取文本（子代理一般纯文本；非文本 part 占位避免落 base64）。
          : (m.content as any[])
            .map(p => (p?.type === 'text' ? p.text : `[${p?.type ?? 'part'}]`))
            .join(''),
        timestamp: now + idx,
        model: m.role === 'assistant' ? model : undefined,
      }));

      const conversationId = createConversationId();
      const summary = await saveConversationSnapshot({
        id: conversationId,
        title: `[子代理] ${task.config.name}: ${task.taskDescription.slice(0, 24)}`,
        model,
        messages: persistMessages,
        parentId: parentConversationId || null,
        isSubAgent: true,
        timestamp: now,
      });
      return summary ? conversationId : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 并行 spawn 多个 Subagent
   */
  async spawnMultiple(tasks: SubagentTask[]): Promise<SubagentResult[]> {
    const state = store.getState() as any;
    const maxConcurrent = state.multiAI?.maxConcurrentSubagents || 3;

    const results: SubagentResult[] = [];
    // 按 maxConcurrent 分批执行
    for (let i = 0; i < tasks.length; i += maxConcurrent) {
      const batch = tasks.slice(i, i + maxConcurrent);
      const batchResults = await Promise.all(
        batch.map(task => this.spawnSubagent(task))
      );
      results.push(...batchResults);
    }
    return results;
  }

  /**
   * 终止所有活跃的 Subagent
   */
  abortAll() {
    for (const [id, controller] of this.activeSubagents) {
      controller.abort();
      store.dispatch(updateSubagentStatus({
        id,
        status: 'error',
        result: '用户手动终止',
        endTime: Date.now(),
      }));
    }
    this.activeSubagents.clear();
    this.depthByContext.clear();
  }
}

// 全局单例
export const agentOrchestrator = new AgentOrchestrator();

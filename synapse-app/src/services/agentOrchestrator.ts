/**
 * Synapse Agent Orchestrator
 * Multi-AI 协作编排引擎
 * 
 * 职责：
 * 1. 管理主 Agent 和 Subagent 的生命周期
 * 2. spawn_subagent 工具的后端实现
 * 3. Subagent 独立上下文管理
 * 4. 结果汇总与报告生成
 */

import { store } from '@/store';
import { AIClient, type ChatMessage } from './aiClient';
import {
  addRunningSubagent,
  updateSubagentStatus,
  type SubagentConfig,
  type MultiAIMode,
} from '@/store/slices/multiAI';
import { addNotification } from '@/store/slices/notifications';

export interface SubagentTask {
  taskDescription: string;
  contextFiles?: string[];
  parentMessages?: ChatMessage[];
  config: SubagentConfig;
}

export interface SubagentResult {
  subagentId: string;
  role: string;
  status: 'complete' | 'error';
  report: string;
  toolCallsUsed: number;
  tokensUsed: number;
  duration: number;
}

export class AgentOrchestrator {
  private activeSubagents: Map<string, AbortController> = new Map();
  
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
   * Spawn 一个独立的 Subagent
   */
  async spawnSubagent(task: SubagentTask): Promise<SubagentResult> {
    const state = store.getState() as any;
    const settings = state.settings;
    const multiAI = state.multiAI;
    const startTime = Date.now();

    // 确定使用的模型
    const model = task.config.model || multiAI.subagentDefaultModel || state.agentSettings?.currentModel || '';
    const apiKey = settings.apiKeys?.openai || '';
    const baseUrl = settings.apiEndpoints?.openai || 'https://api.openai.com/v1';

    if (!apiKey) {
      throw new Error('未配置 API Key，无法创建 Subagent');
    }

    // 创建独立 AI Client
    const client = new AIClient({
      apiKey,
      baseUrl,
      model,
      temperature: 0.3, // Subagent 低 temperature
      maxTokens: task.config.maxTokens,
    });

    const subagentId = `sub-${task.config.id}-${Date.now()}`;
    const abortController = new AbortController();
    this.activeSubagents.set(subagentId, abortController);

    // 注册到 Redux
    store.dispatch(addRunningSubagent({
      id: subagentId,
      parentConversationId: '', // 可以绑定对话 ID
      status: 'running',
      model,
      role: task.config.role,
      startTime,
    }));

    store.dispatch(addNotification({
      type: 'info',
      title: 'Subagent 已启动',
      message: `${task.config.name} 正在执行: ${task.taskDescription.slice(0, 50)}...`,
    }));

    try {
      // 构建 Subagent 消息
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: [
            '# Synapse Subagent 协作指南',
            '',
            '你是一个专注任务的子代理：',
            '1. 你有独立的上下文窗口，不受主对话影响',
            '2. 完成任务后返回结构化报告给主 Agent',
            '3. 保持报告简洁，突出关键发现',
            '4. 你不直接与用户交互',
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

      // 非流式调用 (Subagent 一次性返回)
      let report = '';
      const stream = client.streamChat(messages);
      for await (const chunk of stream) {
        if (abortController.signal.aborted) break;
        if (chunk.type === 'content' && chunk.content) {
          report += chunk.content;
        }
        if (chunk.type === 'error') {
          throw new Error(chunk.error || 'Subagent 执行失败');
        }
      }

      const result: SubagentResult = {
        subagentId,
        role: task.config.name,
        status: 'complete',
        report,
        toolCallsUsed: 0,
        tokensUsed: report.length / 4, // 粗估
        duration: Date.now() - startTime,
      };

      store.dispatch(updateSubagentStatus({
        id: subagentId,
        status: 'complete',
        result: report,
      }));

      store.dispatch(addNotification({
        type: 'success',
        title: 'Subagent 完成',
        message: `${task.config.name} 已完成 (${((Date.now() - startTime) / 1000).toFixed(1)}s)`,
      }));

      return result;
    } catch (err: any) {
      store.dispatch(updateSubagentStatus({
        id: subagentId,
        status: 'error',
        result: err.message,
      }));

      store.dispatch(addNotification({
        type: 'error',
        title: 'Subagent 失败',
        message: `${task.config.name}: ${err.message}`,
      }));

      return {
        subagentId,
        role: task.config.name,
        status: 'error',
        report: `❌ 错误: ${err.message}`,
        toolCallsUsed: 0,
        tokensUsed: 0,
        duration: Date.now() - startTime,
      };
    } finally {
      this.activeSubagents.delete(subagentId);
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
      }));
    }
    this.activeSubagents.clear();
  }

  /**
   * 获取 spawn_subagent 工具定义 (注入到 AI 的 tools 列表)
   */
  static getToolDefinition() {
    return {
      type: 'function' as const,
      function: {
        name: 'spawn_subagent',
        description: '创建一个独立的子代理来执行特定任务。子代理有独立的上下文窗口，完成后返回结构化报告。适用于：代码审查、文献分析、数据验证、深度研究等可并行的任务。',
        parameters: {
          type: 'object',
          properties: {
            task: {
              type: 'string',
              description: '子代理需要执行的任务描述',
            },
            role: {
              type: 'string',
              description: '子代理的角色(如: 审查者、文献分析、数据验证)',
              enum: ['reviewer', 'literature', 'validator', 'researcher', 'custom'],
            },
            context_files: {
              type: 'array',
              items: { type: 'string' },
              description: '需要读取的文件路径列表(可选)',
            },
          },
          required: ['task', 'role'],
        },
      },
    };
  }
}

// 全局单例
export const agentOrchestrator = new AgentOrchestrator();

/**
 * System Prompt Builder
 * 组装 XML 结构的系统提示词，集成 SKILL/WORKFLOW/RULES
 */

import { extensionManager } from './extensionManager';

interface PromptContext {
  workspaceName?: string;
  files?: string[];
  userRules?: string;
  learningMode?: string;
  synopsis?: string;
  mode?: 'fast' | 'planning';
  promptInjection?: {
    injectIdentity?: boolean;
    injectSkills?: boolean;
    injectRules?: boolean;
    injectWorkflows?: boolean;
    injectContext?: boolean;
    injectTools?: boolean;
  };
}

const FAST_IDENTITY = `<identity>
你是 Synapse AI 快速助手。
- 回答尽量简洁，控制在 300 字以内
- 直接给出答案，不做冗余展开
- 不主动调用工具，除非用户明确要求
- 优先用最简短的方式解释概念
</identity>`;

const PLAN_IDENTITY = `<identity>
你是 Synapse AI 深度学习伙伴，一个专为学生设计的智能学习教师。
你能够阅读课件、解答问题、制定学习计划、总结知识要点。
请用中文回复，语气友好且专业。
- 对复杂任务先给出简短计划，再按计划逐步执行
- 在需要使用工具前说明目标，执行后结合结果继续回答
- 主动使用工具查阅课件获取精确信息
- 回答问题时引用具体课件内容和页码
- 解释概念时使用类比和示例、图表、代码
- 对于数学/算法题目，展示详细推导过程
- 生成学习计划和知识图谱
- 使用 Markdown 格式化（标题、列表、代码块、LaTeX 公式、Mermaid 图）
</identity>`;

export const MAX_CONTEXT_TOKENS = 128000;
export const COMPRESSION_THRESHOLD = 0.9; // 90% of model context window triggers compression

export class SystemPromptBuilder {
  build(context: PromptContext = {}): string {
    const sections: string[] = [];

    const injection = context.promptInjection ?? {};

    // Mode-specific identity
    if (injection.injectIdentity ?? true) {
      const identity = context.mode === 'fast' ? FAST_IDENTITY : PLAN_IDENTITY;
      sections.push(identity);
    }

    if ((injection.injectContext ?? true) && context.workspaceName) {
      sections.push(`<workspace>
当前工作区: ${context.workspaceName}
${context.files?.length ? `已索引文件:\n${context.files.map(f => `- ${f}`).join('\n')}` : '暂无文件'}
</workspace>`);
    }

    if ((injection.injectContext ?? true) && context.synopsis) {
      sections.push(`<knowledge_synopsis>
${context.synopsis}
</knowledge_synopsis>`);
    }

    // Inject SKILL / WORKFLOW / RULES from extension system
    const extensionPrompt = extensionManager.buildExtensionPrompt({
      injectSkills: injection.injectSkills ?? true,
      injectWorkflows: injection.injectWorkflows ?? true,
      injectRules: injection.injectRules ?? true,
    });
    if (extensionPrompt) {
      sections.push(extensionPrompt);
    }

    if ((injection.injectRules ?? true) && context.userRules) {
      sections.push(`<user_rules>
${context.userRules}
</user_rules>`);
    }

    if (context.mode === 'planning') {
      sections.push(`<guidelines>
1. 先用 2-5 行列出计划，再进入执行或回答
2. 回答问题时引用具体课件内容和页码
3. 解释概念时使用类比和示例
4. 对于数学/算法题目，展示详细推导过程
5. 主动使用工具来查阅课件获取精确信息
6. 如需代码示例，提供可运行的完整代码
7. 使用 Markdown 格式化回复（标题、列表、代码块、LaTeX 公式）
8. 长期记忆：开始新任务或需要回忆既往背景/方案/用户偏好时，先调用 memory_query 检索；遇到有长期价值的技术方案、踩坑经验、用户偏好时主动 memory_write 沉淀。这是 Synapse 内置记忆，与外置 MCP 工具无关。
</guidelines>`);
    }

    return sections.join('\n\n');
  }
}

export const promptBuilder = new SystemPromptBuilder();

/**
 * 估算 token 数量（简易版，按字符数粗略估计）
 * 中文约 1.5 tokens/字，英文约 0.25 tokens/character
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars * 1.5 + otherChars * 0.25);
}

/**
 * 计算对话的总 token 数
 */
export function countConversationTokens(messages: Array<{ role: string; content: string }>): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content);
    total += 4;
  }
  total += 2;
  return total;
}

/**
 * CHECKPOINT 上下文压缩
 * 当 token 超过阈值时，将旧消息压缩为摘要
 */
export function compressContext(
  messages: Array<{ role: string; content: string }>,
  maxTokens: number = MAX_CONTEXT_TOKENS,
  realTokenCount?: number,
): { compressed: Array<{ role: string; content: string }>; wasCompressed: boolean } {
  // 优先使用 API 返回的真实 token 数；没有时回退到字符估算
  const currentTokens = realTokenCount && realTokenCount > 0 ? realTokenCount : countConversationTokens(messages);
  const threshold = maxTokens * COMPRESSION_THRESHOLD;

  if (currentTokens <= threshold || messages.length < 6) {
    return { compressed: messages, wasCompressed: false };
  }

  // Keep last 4 messages (recent context), compress earlier ones
  const keepCount = 4;
  const toCompress = messages.slice(0, messages.length - keepCount);
  const toKeep = messages.slice(messages.length - keepCount);

  // Generate summary of old messages
  const summaryParts: string[] = [];
  // P1-5: 区分角色保留不同长度
  for (const msg of toCompress) {
    const role = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? 'AI' : msg.role;
    // 用户消息保留完整（通常较短）；AI 消息保留前500字
    const maxLen = msg.role === 'user' ? Infinity : 500;
    const preview = msg.content.length > maxLen ? msg.content.slice(0, maxLen) + '...' : msg.content;
    summaryParts.push(`[${role}] ${preview}`);
  }

  const checkpointMessage = {
    role: 'system' as const,
    content: `[CHECKPOINT] 之前的对话已被压缩。摘要如下：\n\n${summaryParts.join('\n\n')}\n\n---\n以上是对话历史的压缩摘要。后续内容为最近对话：`,
  };

  return {
    compressed: [checkpointMessage, ...toKeep],
    wasCompressed: true,
  };
}

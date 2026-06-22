/**
 * M4-1-S2：模型上下文窗口统一选择器（修问题2a）
 *
 * 此前三处各自读 contextWindow（StatusBar 硬编码模型名映射、AgentPanel 本地 ?? fallback、
 * agentLoop 本地三元 fallback），口径分散且 StatusBar 与真实 capabilities 脱节。
 * 这里收敛为单一真相源：当前模型的 capabilities.contextWindow，统一 fallback 链。
 *
 * ★ 不给 contextWindow 加下限保护——实测网关无 context 字段时 findContextWindow 名字推断已正确
 *   （gpt-5 → 128000），上限本身没问题；加下限会掩盖真实模型窗口差异。
 */
import { createSelector } from '@reduxjs/toolkit';
import type { RootState } from '../index';
import type { AIModelOption } from '@/types/aiModel';
import { MAX_CONTEXT_TOKENS } from '@/services/systemPrompt';

/** 纯函数版：由已持有的 AIModelOption 解出上下文窗口，供已拿到 option 的组件复用。 */
export function getModelContextWindowForOption(option?: AIModelOption | null, override?: number): number {
  // ★ 用户手动覆盖优先（模型能力面板可改上下文窗口，推断不准时用这个）；其次 capabilities → option → 默认。
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) return override;
  return option?.capabilities?.contextWindow ?? option?.contextWindow ?? MAX_CONTEXT_TOKENS;
}

/**
 * 当前模型 option（agentSettings.availableModels 里 id === currentModel 的那个）。
 * 与 agentLoop / AgentPanel 同逻辑，集中一处；createSelector 缓存避免每次 render 重算 find。
 */
export const getCurrentModelOption = createSelector(
  [
    (state: RootState) => state.agentSettings.availableModels,
    (state: RootState) => state.agentSettings.currentModel,
  ],
  (availableModels, currentModel): AIModelOption | undefined =>
    availableModels.find((m) => m.id === currentModel),
);

/**
 * 当前模型的真实上下文窗口（token）。
 * fallback 链：capabilities.contextWindow ?? option.contextWindow ?? MAX_CONTEXT_TOKENS，与 agentLoop 现状一致。
 */
export const getModelContextWindow = createSelector(
  [
    getCurrentModelOption,
    (state: RootState) => state.agentSettings.contextWindowOverrides,
    (state: RootState) => state.agentSettings.currentModel,
  ],
  (option, overrides, currentModel): number =>
    getModelContextWindowForOption(option, overrides?.[currentModel]),
);

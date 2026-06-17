import { configureStore, type Middleware } from '@reduxjs/toolkit';
import { layoutSlice } from './slices/layout';
import { sidebarSlice } from './slices/sidebar';
import { conversationSlice } from './slices/conversation';
import { conversationHistorySlice } from './slices/conversationHistory';
import { agentSettingsSlice, normalizeWallpaperImages } from './slices/agentSettings';
import { settingsSlice } from './slices/settings';
import { themeSlice } from './slices/theme';
import { notificationsSlice } from './slices/notifications';
import { workspaceSlice } from './slices/workspace';
import { worktreeSessionSlice } from './slices/worktreeSession';
import { editorTabsSlice } from './slices/editorTabs';
import multiAIReducer, { BUILT_IN_MODES } from './slices/multiAI';
import { normalizeModelOption } from '@/services/modelCapabilities';

// ---- P0-3: Settings 持久化 ----
const SETTINGS_KEY = 'synapse_settings';
const THEME_KEY = 'synapse_theme';
const AGENT_SETTINGS_KEY = 'synapse_agent_settings';
const MULTI_AI_KEY = 'synapse_multi_ai';
const LAYOUT_KEY = 'synapse_layout';
const BACKGROUND_SETTINGS_KEY = 'synapse:background';
const SYNOPSIS_SETTINGS_KEY = 'synapse:synopsis';
const MULTI_AI_SETTINGS_KEY = 'synapse:multi-ai';

const DEFAULT_BACKGROUND_SETTINGS = {
  enabled: false,
  images: [],
  selectedIndex: 0,
  displayMode: 'static',
  carouselInterval: 300,
  transitionEffect: 'fade',
  blur: 0,
  opacity: 0.7,
  panelOpacity: 0.75,
};

const DEFAULT_SYNOPSIS_SETTINGS = {
  textModeEnabled: false,
  chunkMaxTokens: 2000,
  mapConcurrency: 3,
  autoIndexEnabled: true,
  autoIndexMethod: 'contentHash',
};

function sanitizePersistedAgentSettings(agentSettings: any) {
  if (!agentSettings) return agentSettings;
  const availableModels = Array.isArray(agentSettings.availableModels)
    ? agentSettings.availableModels
      .map((model: any) => model?.capabilities ? model : normalizeModelOption(model))
      .filter(Boolean)
    : [];
  const normalized = {
    ...agentSettings,
    availableModels,
    enableStreaming: agentSettings.enableStreaming ?? true,
    outputStrategy: agentSettings.outputStrategy ?? ((agentSettings.enableStreaming ?? true) ? 'auto' : 'off'),
    pseudoStreamSpeed: agentSettings.pseudoStreamSpeed ?? 'medium',
    showStreamCursor: agentSettings.showStreamCursor ?? true,
    showGeneratingPlaceholder: agentSettings.showGeneratingPlaceholder ?? true,
    streamThinking: agentSettings.streamThinking ?? true,
    showThinking: agentSettings.showThinking ?? true,
    temperature: Number.isFinite(Number(agentSettings.temperature)) ? Number(agentSettings.temperature) : 0.7,
    topP: Number.isFinite(Number(agentSettings.topP)) ? Number(agentSettings.topP) : 1,
    maxTokens: Number.isFinite(Number(agentSettings.maxTokens)) ? Number(agentSettings.maxTokens) : 4096,
    reasoningEffort: agentSettings.reasoningEffort ?? 'auto',
    speedTier: agentSettings.speedTier ?? 'auto',
    backgroundSettings: {
      ...DEFAULT_BACKGROUND_SETTINGS,
      ...(agentSettings.backgroundSettings ?? {}),
      images: normalizeWallpaperImages(agentSettings.backgroundSettings?.images),
    },
    synopsisSettings: {
      ...DEFAULT_SYNOPSIS_SETTINGS,
      ...(agentSettings.synopsisSettings ?? {}),
    },
    // ★ M5-RL：record 分层默认兜底——旧持久化无此字段时补全完整字段（默认值与 agentSettings.recordLayering
    //   initialState / agentLoop.DEFAULT_LAYERING 同步；改默认值需三处一起改）。buildStableRecordPrefix 另有
    //   运行时字段级兜底，此处保证 store.recordLayering 永远完整，供 SettingsPanel UI 与 setRecordLayering 用。
    recordLayering: {
      headFull: 2, tailFull: 1, titleThreshold: 20, maxRatio: 0.4, foldThreshold: 30, foldBatchK: 10,
      ...(agentSettings.recordLayering ?? {}),
    },
  };
  // ★ M4-5-S1：系统模型（systemModel）加载期失效回退，与 currentModel 同款——
  // 持久化里若存了已从端点下线的模型，启动即回退空（跟随 currentModel），防后台任务静默报错。
  // systemModel 校验独立于 currentModel（即便 currentModel 为空也要校验 systemModel）。
  if (normalized.systemModel && !availableModels.some((model: any) => model?.id === normalized.systemModel)) {
    normalized.systemModel = '';
  }
  if (!normalized.currentModel) return normalized;
  const hasCurrentModel = availableModels.some((model: any) => model?.id === agentSettings.currentModel);
  if (!hasCurrentModel) {
    return {
      ...normalized,
      currentModel: '',
    };
  }
  return normalized;
}

function sanitizePersistedMultiAI(multiAI: any) {
  if (!multiAI) return multiAI;
  const persistedModes = Array.isArray(multiAI.modes) ? multiAI.modes : [];
  const customModes = persistedModes.filter((mode: any) => {
    const isBuiltIn = mode?.isBuiltIn || mode?.isBuiltin || BUILT_IN_MODES.some(builtIn => builtIn.id === mode?.id);
    return mode?.id && !isBuiltIn;
  });
  const subagentModel = multiAI.defaultSubagentModel ?? multiAI.subagentDefaultModel ?? '';
  const activeMode = multiAI.activeMode === 'adversarial-coding'
    ? 'adversarial-vibe-coding'
    : (multiAI.activeMode || 'solo');
  return {
    ...multiAI,
    activeMode,
    modes: [...BUILT_IN_MODES, ...customModes],
    runningSubagents: Array.isArray(multiAI.runningSubagents) ? multiAI.runningSubagents : [],
    // ★ M3-3a：工作流运行实例是【运行态】，重启/刷新一律重置为空（不复用上次未完成的卡片状态）。
    workflowRuns: [],
    maxConcurrentSubagents: Number.isFinite(Number(multiAI.maxConcurrentSubagents)) ? Number(multiAI.maxConcurrentSubagents) : 3,
    defaultSubagentModel: subagentModel,
    subagentDefaultModel: subagentModel,
    defaultSubagentMaxTokens: Number.isFinite(Number(multiAI.defaultSubagentMaxTokens)) ? Number(multiAI.defaultSubagentMaxTokens) : 32000,
  };
}

function loadPersistedState() {
  try {
    const settingsRaw = localStorage.getItem(SETTINGS_KEY);
    const themeRaw = localStorage.getItem(THEME_KEY);
    const agentSettingsRaw = localStorage.getItem(AGENT_SETTINGS_KEY);
    const backgroundRaw = localStorage.getItem(BACKGROUND_SETTINGS_KEY);
    const synopsisRaw = localStorage.getItem(SYNOPSIS_SETTINGS_KEY);
    const multiAIRaw = localStorage.getItem(MULTI_AI_SETTINGS_KEY) ?? localStorage.getItem(MULTI_AI_KEY);
    const parsedAgentSettings = agentSettingsRaw ? JSON.parse(agentSettingsRaw) : undefined;
    const backgroundSettings = backgroundRaw ? JSON.parse(backgroundRaw) : undefined;
    const synopsisSettings = synopsisRaw ? JSON.parse(synopsisRaw) : undefined;
    const agentSettingsSeed = parsedAgentSettings || backgroundSettings || synopsisSettings ? {
      ...(parsedAgentSettings ?? {}),
      ...(backgroundSettings ? { backgroundSettings } : {}),
      ...(synopsisSettings ? { synopsisSettings } : {}),
    } : undefined;
    return {
      settings: settingsRaw ? JSON.parse(settingsRaw) : undefined,
      theme: themeRaw ? JSON.parse(themeRaw) : undefined,
      agentSettings: sanitizePersistedAgentSettings(agentSettingsSeed),
      multiAI: sanitizePersistedMultiAI(multiAIRaw ? JSON.parse(multiAIRaw) : undefined),
    };
  } catch {
    return {};
  }
}

const persistMiddleware: Middleware = (storeApi) => (next) => (action) => {
  const result = next(action);
  const state = storeApi.getState() as RootState;
  // 仅在 settings 或 theme 相关 action 时持久化
  if (typeof action === 'object' && action !== null && 'type' in action) {
    const type = (action as { type: string }).type;
    if (type.startsWith('settings/')) {
      try {
        // API Key base64 编码后存储
        const settingsToSave = { ...state.settings };
        if (settingsToSave.apiKeys) {
          const encoded: Record<string, string> = {};
          for (const [k, v] of Object.entries(settingsToSave.apiKeys)) {
            encoded[k] = btoa(v);
          }
          settingsToSave.apiKeys = encoded;
        }
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsToSave));
      } catch { /* localStorage 不可用 */ }
    }
    if (type.startsWith('theme/')) {
      try {
        localStorage.setItem(THEME_KEY, JSON.stringify(state.theme));
      } catch { /* localStorage 不可用 */ }
    }
    if (type.startsWith('agentSettings/')) {
      try {
        localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify(state.agentSettings));
        localStorage.setItem(BACKGROUND_SETTINGS_KEY, JSON.stringify(state.agentSettings.backgroundSettings));
        localStorage.setItem(SYNOPSIS_SETTINGS_KEY, JSON.stringify(state.agentSettings.synopsisSettings));
      } catch { /* localStorage 不可用 */ }
    }
    if (type.startsWith('multiAI/')) {
      try {
        // ★ medium#1（M3-3a 审查）治本：剔除【运行态】字段再落盘。workflowRuns / runningSubagents 是运行实例
        //   （loadPersistedState 时本就重置为空，不复用上次未完成状态），不该进 localStorage——否则单次工作流的
        //   ~(1+N+状态翻转) 次 multiAI/* dispatch 每次都把全会话累积的运行态整体序列化写盘（性能/quota 风险）。
        //   与 worktreeSession 前缀不入 persistMiddleware 同思路：只持久化配置类字段，运行态留在内存。
        const { workflowRuns: _wfRuns, runningSubagents: _running, ...persistable } = state.multiAI;
        const serialized = JSON.stringify(persistable);
        localStorage.setItem(MULTI_AI_KEY, serialized);
        localStorage.setItem(MULTI_AI_SETTINGS_KEY, serialized);
      } catch { /* localStorage 不可用 */ }
    }
    if (type.startsWith('layout/')) {
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(state.layout));
      } catch { /* localStorage 不可用 */ }
    }
  }
  return result;
};

// 加载持久化状态
const persisted = loadPersistedState();

// 解码 API Key
if (persisted.settings?.apiKeys) {
  try {
    const decoded: Record<string, string> = {};
    for (const [k, v] of Object.entries(persisted.settings.apiKeys)) {
      decoded[k] = atob(v as string);
    }
    persisted.settings.apiKeys = decoded;
  } catch { /* 解码失败用空对象 */ }
}

export const store = configureStore({
  reducer: {
    layout: layoutSlice.reducer,
    sidebar: sidebarSlice.reducer,
    conversation: conversationSlice.reducer,
    conversationHistory: conversationHistorySlice.reducer,
    agentSettings: agentSettingsSlice.reducer,
    settings: settingsSlice.reducer,
    theme: themeSlice.reducer,
    notifications: notificationsSlice.reducer,
    workspace: workspaceSlice.reducer,
    // M2-5：会话级活动 worktree 运行态（不持久化；前缀 worktreeSession/ 不入 persistMiddleware）。
    worktreeSession: worktreeSessionSlice.reducer,
    editorTabs: editorTabsSlice.reducer,
    multiAI: multiAIReducer,
  },
  preloadedState: {
    ...(persisted.settings ? { settings: persisted.settings } : {}),
    ...(persisted.theme ? { theme: persisted.theme } : {}),
    ...(persisted.agentSettings ? { agentSettings: persisted.agentSettings } : {}),
    ...(persisted.multiAI ? { multiAI: persisted.multiAI } : {}),
  },
  middleware: (getDefault) => getDefault().concat(persistMiddleware),
  devTools: import.meta.env.DEV,
});

declare global {
  interface Window {
    __SYNAPSE_STORE__?: typeof store;
  }
}

if (import.meta.env.DEV) {
  window.__SYNAPSE_STORE__ = store;
}

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

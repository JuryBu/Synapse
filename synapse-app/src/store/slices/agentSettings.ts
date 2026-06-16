import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { AIModelOption } from '@/types/aiModel';

type AgentMode = 'planning' | 'fast';
type ConnectionStatus = 'unknown' | 'missing' | 'checking' | 'configured' | 'failed';
export type OutputStrategy = 'auto' | 'real' | 'pseudo' | 'off';
export type PseudoStreamSpeed = 'slow' | 'medium' | 'fast';
export type WallpaperKind = 'dataUrl' | 'managed';

export interface WallpaperImage {
  id: string;
  name: string;
  kind: WallpaperKind;
  url: string;
  relativePath?: string;
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
  addedAt: number;
  legacy?: boolean;
}

export interface BackgroundSettings {
  enabled: boolean;
  images: WallpaperImage[];
  selectedIndex: number;
  displayMode: 'static' | 'carousel' | 'random';
  carouselInterval: number;
  transitionEffect: 'fade' | 'slide';
  blur: number;
  opacity: number;
  panelOpacity: number;
}

export interface SynopsisSettings {
  textModeEnabled: boolean;
  chunkMaxTokens: number;
  mapConcurrency: number;
  autoIndexEnabled: boolean;
  autoIndexMethod: 'contentHash' | 'timestamp';
}

interface AgentSettingsState {
  mode: AgentMode;
  currentModel: string;
  /**
   * ★ M4-5-S1：系统模型（后台任务专用），空字符串 = 跟随 currentModel。
   * 历史压缩摘要（recordGenerator）、自动标题等【后台 LLM 任务】走这条独立通路，
   * 与主对话模型（currentModel）解耦。统一通过 resolveSystemModel（services/modelResolution.ts）解析，
   * 口径恒为 systemModel || currentModel。靠 agentSettings 整 slice 自动持久化，无需改持久化代码。
   */
  systemModel: string;
  availableModels: AIModelOption[];
  connectionStatus: ConnectionStatus;
  maxToolRounds: number;
  enableStreaming: boolean;
  outputStrategy: OutputStrategy;
  pseudoStreamSpeed: PseudoStreamSpeed;
  showStreamCursor: boolean;
  showGeneratingPlaceholder: boolean;
  streamThinking: boolean;
  showThinking: boolean;
  temperature: number;
  topP: number;
  maxTokens: number;
  reasoningEffort: string;
  speedTier: string;
  backgroundSettings: BackgroundSettings;
  synopsisSettings: SynopsisSettings;
}

const initialState: AgentSettingsState = {
  mode: 'planning',
  currentModel: '',
  systemModel: '', // M4-5-S1：空 = 跟随 currentModel
  availableModels: [],
  connectionStatus: 'unknown',
  maxToolRounds: 25,
  enableStreaming: true,
  outputStrategy: 'auto',
  pseudoStreamSpeed: 'medium',
  showStreamCursor: true,
  showGeneratingPlaceholder: true,
  streamThinking: true,
  showThinking: true,
  temperature: 0.7,
  topP: 1,
  maxTokens: 4096,
  reasoningEffort: 'auto',
  speedTier: 'auto',
  backgroundSettings: {
    enabled: false,
    images: [],
    selectedIndex: 0,
    displayMode: 'static',
    carouselInterval: 300,
    transitionEffect: 'fade',
    blur: 0,
    opacity: 0.7,
    panelOpacity: 0.75,
  },
  synopsisSettings: {
    textModeEnabled: false,
    chunkMaxTokens: 2000,
    mapConcurrency: 3,
    autoIndexEnabled: true,
    autoIndexMethod: 'contentHash',
  },
};

export function normalizeWallpaperImage(input: unknown, index = 0): WallpaperImage | null {
  if (typeof input === 'string') {
    if (!input) return null;
    const looksManaged = input.startsWith('synapse-wallpaper://');
    return {
      id: `legacy-${index}-${simpleHash(input)}`,
      name: `壁纸 ${index + 1}`,
      kind: looksManaged ? 'managed' : 'dataUrl',
      url: input,
      addedAt: Date.now(),
      legacy: true,
    };
  }
  if (!input || typeof input !== 'object') return null;
  const item = input as Partial<WallpaperImage>;
  const url = typeof item.url === 'string' ? item.url : '';
  if (!url) return null;
  const id = typeof item.id === 'string' && item.id.trim()
    ? item.id.trim()
    : `wallpaper-${index}-${simpleHash(url)}`;
  const kind: WallpaperKind = item.kind === 'managed' ? 'managed' : 'dataUrl';
  return {
    id,
    name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : `壁纸 ${index + 1}`,
    kind,
    url,
    relativePath: typeof item.relativePath === 'string' ? item.relativePath : undefined,
    mime: typeof item.mime === 'string' ? item.mime : undefined,
    size: Number.isFinite(Number(item.size)) ? Number(item.size) : undefined,
    width: Number.isFinite(Number(item.width)) ? Number(item.width) : undefined,
    height: Number.isFinite(Number(item.height)) ? Number(item.height) : undefined,
    addedAt: Number.isFinite(Number(item.addedAt)) ? Number(item.addedAt) : Date.now(),
    legacy: Boolean(item.legacy),
  };
}

export function normalizeWallpaperImages(inputs: unknown): WallpaperImage[] {
  if (!Array.isArray(inputs)) return [];
  return inputs
    .map((item, index) => normalizeWallpaperImage(item, index))
    .filter((item): item is WallpaperImage => Boolean(item));
}

export function getWallpaperUrl(input: WallpaperImage | string | undefined): string {
  if (!input) return '';
  return typeof input === 'string' ? input : input.url;
}

export function getWallpaperName(input: WallpaperImage | string | undefined, index: number): string {
  if (!input) return `壁纸 ${index + 1}`;
  return typeof input === 'string' ? `壁纸 ${index + 1}` : input.name || `壁纸 ${index + 1}`;
}

function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export const agentSettingsSlice = createSlice({
  name: 'agentSettings',
  initialState,
  reducers: {
    setMode(state, action: PayloadAction<AgentMode>) {
      state.mode = action.payload;
    },
    setCurrentModel(state, action: PayloadAction<string>) {
      state.currentModel = action.payload;
    },
    /**
     * ★ M4-5-S1：设置系统模型（后台任务专用）。空字符串 = 跟随 currentModel。
     * 失效回退（模型从端点下线）由 SettingsPanel.fetchModels 成功后并列校验、store 加载期校验处理。
     */
    setSystemModel(state, action: PayloadAction<string>) {
      state.systemModel = action.payload;
    },
    setAvailableModels(state, action: PayloadAction<AIModelOption[]>) {
      state.availableModels = action.payload;
    },
    setConnectionStatus(state, action: PayloadAction<ConnectionStatus>) {
      state.connectionStatus = action.payload;
    },
    setMaxToolRounds(state, action: PayloadAction<number>) {
      state.maxToolRounds = action.payload;
    },
    setEnableStreaming(state, action: PayloadAction<boolean>) {
      state.enableStreaming = action.payload;
      state.outputStrategy = action.payload ? 'auto' : 'off';
    },
    setOutputStrategy(state, action: PayloadAction<OutputStrategy>) {
      state.outputStrategy = action.payload;
      state.enableStreaming = action.payload !== 'off';
    },
    setPseudoStreamSpeed(state, action: PayloadAction<PseudoStreamSpeed>) {
      state.pseudoStreamSpeed = action.payload;
    },
    setShowStreamCursor(state, action: PayloadAction<boolean>) {
      state.showStreamCursor = action.payload;
    },
    setShowGeneratingPlaceholder(state, action: PayloadAction<boolean>) {
      state.showGeneratingPlaceholder = action.payload;
    },
    setStreamThinking(state, action: PayloadAction<boolean>) {
      state.streamThinking = action.payload;
    },
    setShowThinking(state, action: PayloadAction<boolean>) {
      state.showThinking = action.payload;
    },
    setTemperature(state, action: PayloadAction<number>) {
      state.temperature = action.payload;
    },
    setTopP(state, action: PayloadAction<number>) {
      state.topP = action.payload;
    },
    setMaxTokens(state, action: PayloadAction<number>) {
      state.maxTokens = action.payload;
    },
    setReasoningEffort(state, action: PayloadAction<string>) {
      state.reasoningEffort = action.payload;
    },
    setSpeedTier(state, action: PayloadAction<string>) {
      state.speedTier = action.payload;
    },
    setBackgroundSettings(state, action: PayloadAction<Partial<BackgroundSettings>>) {
      state.backgroundSettings = {
        ...state.backgroundSettings,
        ...action.payload,
      };
      state.backgroundSettings.images = normalizeWallpaperImages(state.backgroundSettings.images);
      if (state.backgroundSettings.selectedIndex >= state.backgroundSettings.images.length) {
        state.backgroundSettings.selectedIndex = Math.max(0, state.backgroundSettings.images.length - 1);
      }
    },
    addBackgroundImages(state, action: PayloadAction<Array<WallpaperImage | string>>) {
      const images = normalizeWallpaperImages(action.payload);
      if (images.length === 0) return;
      const wasEmpty = state.backgroundSettings.images.length === 0;
      state.backgroundSettings.images.push(...images);
      state.backgroundSettings.enabled = true;
      if (wasEmpty) {
        state.backgroundSettings.selectedIndex = 0;
      }
    },
    selectBackgroundImage(state, action: PayloadAction<number>) {
      const index = action.payload;
      if (index >= 0 && index < state.backgroundSettings.images.length) {
        state.backgroundSettings.selectedIndex = index;
        state.backgroundSettings.enabled = true;
      }
    },
    removeBackgroundImage(state, action: PayloadAction<number>) {
      const index = action.payload;
      if (index < 0 || index >= state.backgroundSettings.images.length) return;
      state.backgroundSettings.images.splice(index, 1);
      if (state.backgroundSettings.images.length === 0) {
        state.backgroundSettings.selectedIndex = 0;
        state.backgroundSettings.enabled = false;
        return;
      }
      if (state.backgroundSettings.selectedIndex >= state.backgroundSettings.images.length) {
        state.backgroundSettings.selectedIndex = state.backgroundSettings.images.length - 1;
      } else if (index < state.backgroundSettings.selectedIndex) {
        state.backgroundSettings.selectedIndex -= 1;
      }
    },
    clearBackgroundImages(state) {
      state.backgroundSettings.images = [];
      state.backgroundSettings.selectedIndex = 0;
      state.backgroundSettings.enabled = false;
    },
    nextBackgroundImage(state) {
      const count = state.backgroundSettings.images.length;
      if (count < 2) return;
      if (state.backgroundSettings.displayMode === 'random') {
        let nextIndex = Math.floor(Math.random() * count);
        if (nextIndex === state.backgroundSettings.selectedIndex) {
          nextIndex = (nextIndex + 1) % count;
        }
        state.backgroundSettings.selectedIndex = nextIndex;
      } else {
        state.backgroundSettings.selectedIndex = (state.backgroundSettings.selectedIndex + 1) % count;
      }
    },
    setSynopsisSettings(state, action: PayloadAction<Partial<SynopsisSettings>>) {
      state.synopsisSettings = {
        ...state.synopsisSettings,
        ...action.payload,
      };
    },
  },
});

export const {
  setMode, setCurrentModel, setSystemModel, setMaxToolRounds,
  setAvailableModels, setConnectionStatus,
  setEnableStreaming, setOutputStrategy, setPseudoStreamSpeed,
  setShowStreamCursor, setShowGeneratingPlaceholder, setStreamThinking,
  setShowThinking, setTemperature, setTopP,
  setMaxTokens, setReasoningEffort, setSpeedTier,
  setBackgroundSettings, addBackgroundImages, selectBackgroundImage,
  removeBackgroundImage, clearBackgroundImages, nextBackgroundImage,
  setSynopsisSettings,
} = agentSettingsSlice.actions;

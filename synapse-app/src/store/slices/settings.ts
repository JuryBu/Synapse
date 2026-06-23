import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

interface SafetySettings {
  autoApproveRead: boolean;
  autoApproveWrite: boolean;
  autoApproveCommand: boolean;
  autoApproveAll: boolean;
}

interface PromptInjectionSettings {
  injectIdentity: boolean;
  injectTools: boolean;
  injectSkills: boolean;
  injectContext: boolean;
  injectRules: boolean;
  injectWorkflows: boolean;
}

// ★ C1（M7 第七轮反馈#6）：输入框发送键模式。
//   'enter'     = Enter 发送 / Shift+Enter 换行（默认，IM 习惯）。
//   'ctrlEnter' = Ctrl 或 Cmd+Enter 发送 / Enter 换行（编辑器习惯，旧默认行为）。
export type SendKeyMode = 'enter' | 'ctrlEnter';

interface SettingsState {
  language: 'zh-CN' | 'en';
  fontSize: number;
  autoSave: boolean;
  showLineNumbers: boolean;
  wordWrap: boolean;
  // ★ C1：底部主输入框发送键模式（界面交互偏好，随 settings 持久化）。
  sendKeyMode: SendKeyMode;
  // ★ H4-1（M8 第七轮反馈）：用户消息是否归入当前 active task_boundary 卡片（默认 true=维持现状）。
  //   false 时 handleSend 发送前先收口 active 边界（endTaskBoundary），新消息落在卡片外。
  //   读取处一律按「!== false」兜底（旧 localStorage 整体替换 settings 时缺此字段会是 undefined → 视为 true）。
  attachUserMsgToBoundary: boolean;
  apiKeys: Record<string, string>;
  apiEndpoints: Record<string, string>;
  // New settings
  safety: SafetySettings;
  promptInjection: PromptInjectionSettings;
  maxConversationHistory: number;
  autoArchiveAfter: number; // days, 0 = disabled
}

const initialState: SettingsState = {
  language: 'zh-CN',
  fontSize: 14,
  autoSave: true,
  showLineNumbers: true,
  wordWrap: true,
  sendKeyMode: 'enter', // ★ C1：默认 Enter 发送 / Shift+Enter 换行
  attachUserMsgToBoundary: true, // ★ H4-1：默认用户消息归入当前任务边界卡片（维持现状）
  apiKeys: {},
  apiEndpoints: {
    openai: 'https://api.openai.com/v1',
    deepseek: 'https://api.deepseek.com/v1',
  },
  safety: {
    autoApproveRead: true,
    autoApproveWrite: false,
    autoApproveCommand: false,
    autoApproveAll: false,
  },
  promptInjection: {
    injectIdentity: true,
    injectTools: true,
    injectSkills: true,
    injectContext: true,
    injectRules: true,
    injectWorkflows: true,
  },
  maxConversationHistory: 100,
  autoArchiveAfter: 30,
};

export const settingsSlice = createSlice({
  name: 'settings',
  initialState,
  reducers: {
    setLanguage(state, action: PayloadAction<'zh-CN' | 'en'>) {
      state.language = action.payload;
    },
    setFontSize(state, action: PayloadAction<number>) {
      state.fontSize = action.payload;
    },
    setAutoSave(state, action: PayloadAction<boolean>) {
      state.autoSave = action.payload;
    },
    // ★ C1：切换发送键模式（'enter' / 'ctrlEnter'）。
    setSendKeyMode(state, action: PayloadAction<SendKeyMode>) {
      state.sendKeyMode = action.payload;
    },
    // ★ H4-1：切换「用户消息归入当前任务边界」开关。
    setAttachUserMsgToBoundary(state, action: PayloadAction<boolean>) {
      state.attachUserMsgToBoundary = action.payload;
    },
    setApiKey(state, action: PayloadAction<{ provider: string; key: string }>) {
      state.apiKeys[action.payload.provider] = action.payload.key;
    },
    setApiEndpoint(state, action: PayloadAction<{ provider: string; url: string }>) {
      state.apiEndpoints[action.payload.provider] = action.payload.url;
    },
    loadSettings(_, action: PayloadAction<Partial<SettingsState>>) {
      return {
        ...initialState,
        ...action.payload,
        apiKeys: {
          ...initialState.apiKeys,
          ...(action.payload.apiKeys ?? {}),
        },
        apiEndpoints: {
          ...initialState.apiEndpoints,
          ...(action.payload.apiEndpoints ?? {}),
        },
        safety: {
          ...initialState.safety,
          ...(action.payload.safety ?? {}),
        },
        promptInjection: {
          ...initialState.promptInjection,
          ...(action.payload.promptInjection ?? {}),
        },
      };
    },
    // Safety settings
    setSafety(state, action: PayloadAction<Partial<SafetySettings>>) {
      state.safety ??= { ...initialState.safety };
      Object.assign(state.safety, action.payload);
      if (action.payload.autoApproveAll !== undefined) {
        state.safety.autoApproveRead = action.payload.autoApproveAll;
        state.safety.autoApproveWrite = action.payload.autoApproveAll;
        state.safety.autoApproveCommand = action.payload.autoApproveAll;
      }
    },
    // Prompt injection settings
    setPromptInjection(state, action: PayloadAction<Partial<PromptInjectionSettings>>) {
      state.promptInjection ??= { ...initialState.promptInjection };
      Object.assign(state.promptInjection, action.payload);
    },
    setMaxConversationHistory(state, action: PayloadAction<number>) {
      state.maxConversationHistory = action.payload;
    },
    setAutoArchiveAfter(state, action: PayloadAction<number>) {
      state.autoArchiveAfter = action.payload;
    },
  },
});

export const {
  setLanguage, setFontSize, setAutoSave, setSendKeyMode, setAttachUserMsgToBoundary,
  setApiKey, setApiEndpoint, loadSettings,
  setSafety, setPromptInjection,
  setMaxConversationHistory, setAutoArchiveAfter,
} = settingsSlice.actions;

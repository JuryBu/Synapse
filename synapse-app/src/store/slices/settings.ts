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

interface SettingsState {
  language: 'zh-CN' | 'en';
  fontSize: number;
  autoSave: boolean;
  showLineNumbers: boolean;
  wordWrap: boolean;
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
  setLanguage, setFontSize, setAutoSave,
  setApiKey, setApiEndpoint, loadSettings,
  setSafety, setPromptInjection,
  setMaxConversationHistory, setAutoArchiveAfter,
} = settingsSlice.actions;

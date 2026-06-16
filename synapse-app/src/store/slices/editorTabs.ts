import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

interface EditorTab {
  id: string;
  filePath: string;
  fileName: string;
  isDirty: boolean;
  isPreview: boolean;
  type: 'code' | 'pdf' | 'pptx' | 'docx' | 'office' | 'markdown' | 'html' | 'image' | 'video' | 'welcome' | 'showcase' | 'settings' | 'review' | 'workflow' | 'unsupported';
  content?: string;
  savedContent?: string;
  /**
   * ★ M3-3b 子代理中间视图 tab（type==='workflow'）专属：关联的 Multi-AI 工作流运行实例 id
   *   （multiAI.workflowRuns[runId]）。EditorArea 据此渲染 <WorkflowView runId=... />。其它类型 tab 无此字段。
   */
  workflowRunId?: string;
}

const welcomeTab: EditorTab = {
  id: 'welcome',
  filePath: '',
  fileName: '欢迎',
  isDirty: false,
  isPreview: false,
  type: 'welcome',
};

interface EditorTabsState {
  tabs: EditorTab[];
  activeTabId: string | null;
}

const initialState: EditorTabsState = {
  tabs: [welcomeTab],
  activeTabId: 'welcome',
};

export const editorTabsSlice = createSlice({
  name: 'editorTabs',
  initialState,
  reducers: {
    openTab(state, action: PayloadAction<EditorTab>) {
      const existing = state.tabs.find(t => t.filePath === action.payload.filePath);
      if (existing) {
        state.activeTabId = existing.id;
      } else {
        state.tabs.push(action.payload);
        state.activeTabId = action.payload.id;
      }
    },
    /**
     * ★ M3-3b 打开「子代理中间视图」tab（非文件视图，仿 review tab 模式）。
     *   id 用稳定的 `workflow:${runId}`，同 runId 已开则仅激活不重开（去重不依赖 filePath——
     *   workflow tab 无 filePath，故另起 action 而非复用按 filePath 去重的 openTab）。
     */
    openWorkflowTab(state, action: PayloadAction<{ runId: string; title: string }>) {
      const tabId = `workflow:${action.payload.runId}`;
      const existing = state.tabs.find(t => t.id === tabId);
      if (existing) {
        state.activeTabId = existing.id;
        return;
      }
      state.tabs.push({
        id: tabId,
        filePath: '',
        fileName: action.payload.title || '工作流',
        isDirty: false,
        isPreview: false,
        type: 'workflow',
        workflowRunId: action.payload.runId,
      });
      state.activeTabId = tabId;
    },
    closeTab(state, action: PayloadAction<string>) {
      state.tabs = state.tabs.filter(t => t.id !== action.payload);
      if (state.activeTabId === action.payload) {
        state.activeTabId = state.tabs[state.tabs.length - 1]?.id ?? null;
      }
    },
    setActiveTab(state, action: PayloadAction<string>) {
      state.activeTabId = action.payload;
    },
    setTabDirty(state, action: PayloadAction<{ id: string; dirty: boolean }>) {
      const tab = state.tabs.find(t => t.id === action.payload.id);
      if (tab) tab.isDirty = action.payload.dirty;
    },
    setTabContent(state, action: PayloadAction<{ id: string; content: string; dirty?: boolean; markSaved?: boolean }>) {
      const tab = state.tabs.find(t => t.id === action.payload.id);
      if (!tab) return;
      tab.content = action.payload.content;
      if (action.payload.markSaved) {
        tab.savedContent = action.payload.content;
        tab.isDirty = false;
      } else if (action.payload.dirty !== undefined) {
        tab.isDirty = action.payload.dirty;
      } else {
        tab.isDirty = action.payload.content !== (tab.savedContent ?? '');
      }
    },
    markTabSaved(state, action: PayloadAction<{ id: string; content?: string }>) {
      const tab = state.tabs.find(t => t.id === action.payload.id);
      if (!tab) return;
      if (action.payload.content !== undefined) {
        tab.content = action.payload.content;
        tab.savedContent = action.payload.content;
      } else {
        tab.savedContent = tab.content;
      }
      tab.isDirty = false;
    },
    closeAllTabs(state) {
      state.tabs = [];
      state.activeTabId = null;
    },
    resetTabsToWelcome(state) {
      state.tabs = [welcomeTab];
      state.activeTabId = 'welcome';
    },
  },
});

export const {
  openTab, openWorkflowTab, closeTab, setActiveTab, setTabDirty, setTabContent, markTabSaved, closeAllTabs, resetTabsToWelcome,
} = editorTabsSlice.actions;

export type { EditorTab };

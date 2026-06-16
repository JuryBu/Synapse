/**
 * Multi-AI Redux Slice
 * 管理 Multi-AI 协作模式的配置状态
 */
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface SubagentConfig {
  id: string;
  name: string;
  role: string; // 角色描述
  model: string; // 使用的模型
  systemPrompt: string; // 系统提示
  toolPermissions: ('read' | 'write' | 'command' | 'search' | 'generate')[];
  maxTokens: number;
  /**
   * M3-1a 派发深度（递归层数控制）。正整数；不填默认 1。
   *   - 1（默认）→ 不允许该子代理再派发子代理（其工具集剔除 spawn_subagent）。
   *   - N（>1）→ 允许 N 层：子代理工具集【含】spawn_subagent，且其派出的孙代理 maxDepth=N-1，
   *     逐层递减，到 1 时不能再派。防无限递归派发。
   */
  maxDepth?: number;
}

export interface MultiAIMode {
  id: string;
  name: string;
  description: string;
  agentCount: number;
  isBuiltin: boolean;
  isBuiltIn: boolean;
  mainAgentRole: string; // 主 Agent 角色描述
  subagents: SubagentConfig[];
  triggerConditions: ('stageComplete' | 'reviewPhase' | 'userRequest' | 'error')[];
}

/**
 * M3-1a 运行态子代理（为 M3-3 卡片四色 + token 统计 + 计时实时刷新打底）。
 * 四色状态映射（Plan_4_M3 五）：灰=complete、蓝=running、黄=retrying（retry/重连阻塞）、红=error。
 */
export interface RunningSubagent {
  id: string;                 // = subagentId（同时作为 toolRegistry.execute 的 contextId 隔离键）
  parentConversationId: string; // 主对话 id（卡片归属 + 子对话 parent_id）
  status: 'running' | 'complete' | 'error' | 'retrying';
  model: string;
  role: string;
  startTime: number;
  endTime?: number;           // 完成/失败时间（计时停止）
  result?: string;            // 完成 report 摘要 / 错误信息
  toolCallsUsed?: number;     // 工具调用次数（卡片展示）
  tokensUsed?: number;        // 粗估 token 用量（卡片展示）
  depth?: number;             // 本子代理的 maxDepth（剩余可派发层数；卡片可视化递归层级）
  conversationId?: string;    // 子代理落库的独立 conversation id（卡片点进查看其完整对话流）
}

export interface MultiAIState {
  enabled: boolean;
  activeMode: string; // mode id
  modes: MultiAIMode[];
  runningSubagents: RunningSubagent[];
  maxConcurrentSubagents: number;
  defaultSubagentModel: string;
  defaultSubagentMaxTokens: number;
  subagentDefaultModel: string;
}

export const BUILT_IN_MODES: MultiAIMode[] = [
  {
    id: 'solo',
    name: 'Solo (单Agent)',
    description: '仅使用主 Agent 直接完成任务。',
    agentCount: 1,
    isBuiltin: true,
    isBuiltIn: true,
    mainAgentRole: '你是直接与用户协作的主 Agent，独立完成任务。',
    subagents: [],
    triggerConditions: [],
  },
  {
    id: 'adversarial-vibe-coding',
    name: '对抗式 vibe-coding',
    description: '主Agent编码 + 审查Subagent Review，提升代码质量',
    agentCount: 2,
    isBuiltin: true,
    isBuiltIn: true,
    mainAgentRole: '你是项目的主力编码 Agent，直接与用户交互。每完成一个 Stage，等待审查 Subagent 的 Review 报告，逐条处理反馈。',
    subagents: [{
      id: 'reviewer',
      name: '审查者',
      role: '代码审查与质量检测',
      model: '',
      systemPrompt: `你是审查者 Agent。审查标准：功能完整性、代码质量(命名/结构/可读性)、错误处理(边界/异常)、性能问题。
输出格式：🔴 严重问题 (必须修复) | 🟡 建议改进 (推荐修复) | 🟢 肯定亮点 (做得好的地方)`,
      toolPermissions: ['read', 'search'],
      maxTokens: 4096,
    }],
    triggerConditions: ['stageComplete', 'reviewPhase'],
  },
  {
    id: 'deep-research',
    name: '深度研究',
    description: '主Agent讲解 + 文献分析/数据验证 Subagent 并行辅助',
    agentCount: 3,
    isBuiltin: true,
    isBuiltIn: true,
    mainAgentRole: '你是深度教学助手（讲师）。讲解基础概念，同时 spawn 文献分析子代理搜索课件内容、数据验证子代理验证推导正确性。整合报告后给出深度准确的讲解。',
    subagents: [
      {
        id: 'literature',
        name: '文献分析',
        role: '搜索课件中的相关内容并整理引用',
        model: '',
        systemPrompt: '你是文献分析子代理。根据主题搜索课件内容，提取关键引用和上下文。返回结构化报告。',
        toolPermissions: ['read', 'search'],
        maxTokens: 2048,
      },
      {
        id: 'validator',
        name: '数据验证',
        role: '验证公式推导和数据准确性',
        model: '',
        systemPrompt: '你是数据验证子代理。验证主Agent给出的公式推导、数据计算的正确性。如果发现错误，明确指出错误位置和正确答案。',
        toolPermissions: ['read'],
        maxTokens: 2048,
      },
    ],
    triggerConditions: ['userRequest'],
  },
  {
    id: 'teaching-collaboration',
    name: '教学协作',
    description: '主Agent讲解 + 教学 Subagent 生成练习与追问。',
    agentCount: 2,
    isBuiltin: true,
    isBuiltIn: true,
    mainAgentRole: '你是课程讲解主 Agent，负责给出清晰讲解并整合教学子代理的练习建议。',
    subagents: [{
      id: 'tutor',
      name: '教学助理',
      role: '生成练习、追问和理解检查',
      model: '',
      systemPrompt: '你是教学助理子代理。根据主 Agent 的讲解主题，生成练习题、追问和理解检查点，帮助用户巩固知识。',
      toolPermissions: ['read', 'search'],
      maxTokens: 4096,
    }],
    triggerConditions: ['userRequest'],
  },
];

const initialState: MultiAIState = {
  enabled: false,
  activeMode: 'solo',
  modes: BUILT_IN_MODES,
  runningSubagents: [],
  maxConcurrentSubagents: 3,
  defaultSubagentModel: '',
  defaultSubagentMaxTokens: 32000,
  subagentDefaultModel: '',
};

const multiAISlice = createSlice({
  name: 'multiAI',
  initialState,
  reducers: {
    setMultiAIEnabled(state, action: PayloadAction<boolean>) {
      state.enabled = action.payload;
      if (action.payload && !state.activeMode) {
        state.activeMode = 'solo';
      }
    },
    setActiveMode(state, action: PayloadAction<string>) {
      state.activeMode = action.payload;
    },
    addMode(state, action: PayloadAction<MultiAIMode>) {
      state.modes.push(action.payload);
    },
    updateMode(state, action: PayloadAction<{ id: string; updates: Partial<MultiAIMode> }>) {
      const mode = state.modes.find(m => m.id === action.payload.id);
      if (mode && !mode.isBuiltIn) {
        Object.assign(mode, action.payload.updates);
      }
    },
    removeMode(state, action: PayloadAction<string>) {
      state.modes = state.modes.filter(m => m.id !== action.payload || m.isBuiltIn);
      if (state.activeMode === action.payload) {
        state.activeMode = 'solo';
      }
    },
    setMaxConcurrentSubagents(state, action: PayloadAction<number>) {
      state.maxConcurrentSubagents = action.payload;
    },
    setSubagentDefaultModel(state, action: PayloadAction<string>) {
      state.subagentDefaultModel = action.payload;
      state.defaultSubagentModel = action.payload;
    },
    setDefaultSubagentMaxTokens(state, action: PayloadAction<number>) {
      state.defaultSubagentMaxTokens = action.payload;
    },
    addRunningSubagent(state, action: PayloadAction<RunningSubagent>) {
      state.runningSubagents.push(action.payload);
    },
    updateSubagentStatus(
      state,
      action: PayloadAction<{
        id: string;
        status: RunningSubagent['status'];
        result?: string;
        // M3-1a 卡片实时字段：完成/失败时回填，运行中（retrying/running）可携进度。
        endTime?: number;
        toolCallsUsed?: number;
        tokensUsed?: number;
        conversationId?: string;
      }>,
    ) {
      const sub = state.runningSubagents.find(s => s.id === action.payload.id);
      if (sub) {
        sub.status = action.payload.status;
        if (action.payload.result !== undefined) sub.result = action.payload.result;
        if (action.payload.endTime !== undefined) sub.endTime = action.payload.endTime;
        if (action.payload.toolCallsUsed !== undefined) sub.toolCallsUsed = action.payload.toolCallsUsed;
        if (action.payload.tokensUsed !== undefined) sub.tokensUsed = action.payload.tokensUsed;
        if (action.payload.conversationId !== undefined) sub.conversationId = action.payload.conversationId;
      }
    },
    clearCompletedSubagents(state) {
      state.runningSubagents = state.runningSubagents.filter(s => s.status === 'running');
    },
  },
});

export const {
  setMultiAIEnabled,
  setActiveMode,
  addMode,
  updateMode,
  removeMode,
  setMaxConcurrentSubagents,
  setSubagentDefaultModel,
  setDefaultSubagentMaxTokens,
  addRunningSubagent,
  updateSubagentStatus,
  clearCompletedSubagents,
} = multiAISlice.actions;

export default multiAISlice.reducer;

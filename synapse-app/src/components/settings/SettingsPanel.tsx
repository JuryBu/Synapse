import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import type { RootState } from '@/store';
import { setLanguage, setFontSize, setApiKey, setApiEndpoint, setSafety, setPromptInjection, setMaxConversationHistory, setAutoArchiveAfter } from '@/store/slices/settings';
import { clearConversation } from '@/store/slices/conversation';
import { setConversations, setSelectedId } from '@/store/slices/conversationHistory';
import { deleteConversationSnapshot, exportConversationSnapshot, listConversationSummaries } from '@/services/conversationPersistence';
import { extensionManager } from '@/services/extensionManager';
import { setThemeMode, setAccentColor } from '@/store/slices/theme';
import {
  addBackgroundImages,
  clearBackgroundImages,
  getWallpaperName,
  getWallpaperUrl,
  removeBackgroundImage,
  selectBackgroundImage,
  setAvailableModels,
  setBackgroundSettings,
  setConnectionStatus,
  setCurrentModel,
  setOutputStrategy,
  setPseudoStreamSpeed,
  setShowGeneratingPlaceholder,
  setShowStreamCursor,
  setShowThinking,
  setSynopsisSettings,
  setStreamThinking,
  setTemperature,
  setTopP,
  setMaxTokens,
  setReasoningEffort,
  setSpeedTier,
} from '@/store/slices/agentSettings';
import type { WallpaperImage } from '@/store/slices/agentSettings';
import {
  addMode,
  removeMode,
  setActiveMode,
  setDefaultSubagentMaxTokens,
  setMaxConcurrentSubagents,
  setMultiAIEnabled,
  setSubagentDefaultModel,
  updateMode,
} from '@/store/slices/multiAI';
import type { MultiAIMode, WorkflowNode } from '@/store/slices/multiAI';
import { MULTI_AI_TRIGGER_PREFIX } from '@/services/multiAITrigger';
import { WorkflowEditor } from './WorkflowEditor';
import { AIClient } from '@/services/aiClient';
import { describeCapabilities } from '@/services/modelCapabilities';
import type { AIModelOption } from '@/types/aiModel';
import { addNotification } from '@/store/slices/notifications';
import { isElectron, platform } from '@/platform';
import type { PlatformInfo, WorktreeEntry } from '@/platform';
import '@/styles/settings.css';

/**
 * ★ M3-2c#fix 唯一 id 生成（时间戳 + 模块级自增 + 随机后缀）。
 *   旧实现用 `wf-${Date.now()}` / `agent-${Date.now()}` / `sub-${Date.now()}`：同一毫秒内两次点击
 *   「新建模板」或「新建」紧接「复制为模板」会产出完全相同的 mode id，导致 updateMode(find by id) /
 *   removeMode(filter by id) 命中两条、列表 React key 重复、reload 后无法区分。加自增序号 + 随机后缀
 *   保证同毫秒多次创建仍唯一（与 WorkflowEditor.genId 同款思路）。
 */
let multiAiIdSeq = 0;
function genUniqueId(prefix: string): string {
  multiAiIdSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${multiAiIdSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

type PluginEntry = {
  name: string;
  description: string;
  status: string;
  source: string;
  icon: string;
  sourceType?: string;
};

type McpServerInfo = {
  name: string;
  status?: string;
  running?: boolean;
  configured?: boolean;
  enabled?: boolean;
};

type StorageUsageSnapshot = {
  localStorageBytes: number;
  browserUsageBytes?: number;
  browserQuotaBytes?: number;
  source: string;
  measuredAt: number;
};

type SettingAuditStatus = '已实装' | '部分实装' | '未实装' | '待确认扩展';

type SettingAuditRow = {
  item: string;
  status: SettingAuditStatus;
  persistence: string;
  effect: string;
  verify: string;
};

const mcpEntries: PluginEntry[] = [
  {
    name: 'sandbox',
    description: '执行隔离命令、持久会话与长任务托管的 MCP 服务。',
    status: 'Electron 模式下可用',
    source: '~/.synapse/mcp_config.json',
    icon: '📦',
  },
  {
    name: 'web-fetcher',
    description: '负责网页抓取、截图、结构化提取与带登录态访问。',
    status: 'Electron 模式下可用',
    source: '~/.synapse/mcp_config.json',
    icon: '🌐',
  },
  {
    name: 'memory-store',
    description: '保存项目记忆、决策记录与可检索的对话沉淀。',
    status: 'Electron 模式下可用',
    source: '~/.synapse/mcp_config.json',
    icon: '🧠',
  },
];

const settingAuditRows: Record<string, SettingAuditRow[]> = {
  general: [
    { item: '语言', status: '部分实装', persistence: 'Redux / 本地持久化', effect: '当前仅保存偏好，界面文案未完整国际化', verify: '切换后刷新确认值保留' },
    { item: '字号', status: '已实装', persistence: 'settings.fontSize', effect: '映射到 --app-font-size', verify: '调整滑块后检查根 CSS 变量' },
    { item: '主题 / 强调色', status: '已实装', persistence: 'theme slice', effect: '映射 data-theme 与强调色 CSS 变量', verify: '切换深浅色与颜色后观察界面变化' },
    { item: '壁纸 / 磨砂 / 面板透明度', status: '已实装', persistence: 'agentSettings.backgroundSettings', effect: '映射 .app-background 与面板透明度', verify: '上传高对比壁纸并检查背景、模糊和透明度' },
  ],
  ai: [
    { item: 'API Key / Endpoint / 测试连接', status: '已实装', persistence: 'settings.apiKeys / apiEndpoints', effect: 'AIClient 使用同一配置获取模型和请求对话', verify: '测试连接返回模型列表或明确错误' },
    { item: '默认模型 / 模型能力标签', status: '已实装', persistence: 'agentSettings.currentModel / availableModels', effect: '输入区与请求模型同步，能力由接口和推断合并', verify: '获取模型后切换默认模型，检查输入区能力标签' },
    { item: 'Top P / Reasoning Effort / Speed Tier', status: '部分实装', persistence: 'agentSettings', effect: '请求体已接入；输入区参数弹层正在补齐图示交互', verify: 'mock 请求体检查参数，并在输入区直接调整' },
    { item: '多模型位', status: '未实装', persistence: '无', effect: 'thinking / fast / synopsis / vision 等专用模型位未拆分', verify: '保留在后续模型体系任务' },
  ],
  conversation: [
    { item: '最大历史 / 自动归档', status: '部分实装', persistence: 'settings slice', effect: '值已保存，但归档执行链路尚未完整验证', verify: '刷新后保留；归档链路需单独端到端验证' },
    { item: 'Temperature / Max Tokens', status: '部分实装', persistence: 'agentSettings', effect: '请求体已接入；正在并入模型参数弹层，按模型能力禁用', verify: 'mock 请求体检查参数，输入区调整后刷新保留' },
    { item: '流式输出 / Thinking 展示', status: '已实装', persistence: 'agentSettings.outputStrategy / pseudoStreamSpeed / showThinking', effect: '自动 / 真流式 / 伪流式 / 关闭流式进入请求与显示链路', verify: '真流式、伪流式、关闭流式 mock 烟测' },
    { item: '上下文压缩策略细项', status: '部分实装', persistence: '静态策略', effect: '有压缩入口，但阈值/保留轮数仍是固定说明', verify: '超过阈值时观察 compressContext 调用' },
  ],
  safety: [
    { item: '自动批准读取 / 写入 / 命令 / 全部', status: '已实装', persistence: 'settings.safety', effect: 'toolRegistry 审批判断读取这些开关', verify: '切换后执行 read/write/command 工具审批路径' },
    { item: '命令超时 / 内存限制', status: '部分实装', persistence: '无', effect: '当前是固定默认展示，未开放可编辑配置', verify: 'UI 标记固定默认，不作为完成态控制项' },
    { item: '系统提示注入', status: '已实装', persistence: 'settings.promptInjection', effect: 'systemPrompt 按开关注入身份、规则、Skill、Workflow、上下文；AgentLoop 按工具定义开关决定是否向 API 传 tools', verify: '动态导入 promptBuilder 构造 prompt，mock 请求体检查 tools' },
  ],
  synopsis: [
    { item: 'TEXT MODE / chunk / 并发 / 自动索引', status: '部分实装', persistence: 'agentSettings.synopsisSettings', effect: '设置已保存，生成管线是否完全消费仍需 Synopsis 专项验证', verify: '刷新保留；索引与生成链路另测' },
    { item: '缓存策略', status: '部分实装', persistence: '本地缓存键', effect: '数据页能清理 synopsis 缓存，细粒度策略未开放', verify: '写入 synapse:synopsis:* 后清缓存' },
  ],
  multiAI: [
    { item: '启用 / 模式选择 / 默认子代理参数', status: '部分实装', persistence: 'multiAI slice', effect: 'agentOrchestrator 读取 enabled、activeMode、并发和模型', verify: '开启后触发 orchestrator 获取当前模式' },
    { item: '模式编辑器 / Mode.md 两级覆盖', status: '未实装', persistence: '无', effect: '仅本地草稿模式，未读写 Mode.md', verify: '保留为后续 Multi-AI 配置任务' },
  ],
  plugins: [
    { item: 'MCP 状态 / 启动 / 重启', status: '已实装', persistence: 'mcp_config.json + 进程 Map', effect: 'Electron IPC 读取配置与真实进程状态', verify: 'stage9-smoke stopped/running/stopped 烟测' },
    { item: 'SKILL / WORKFLOW / RULES 来源展示', status: '部分实装', persistence: 'extensionManager 清单', effect: '内置与规则文件状态可见，完整目录扫描/禁用未完成', verify: '插件页查看 sourceType 与规则缺失状态' },
    { item: 'Codex / Antigravity 特化插件源', status: '待确认扩展', persistence: '无', effect: '未混入通用插件页完成项', verify: '等待单独确认边界' },
  ],
  data: [
    { item: '导出对话 / 清除历史', status: '已实装', persistence: 'conversationPersistence', effect: 'Electron 数据库与 Web 降级存储均走统一服务', verify: '创建历史后导出、清除、刷新确认' },
    { item: '清除缓存 / 存储估算', status: '部分实装', persistence: 'localStorage + navigator.storage', effect: '清理本地 synopsis/temp/cache 键；显示 localStorage 与浏览器估算，不再显示固定 5 MB 限额', verify: '写入缓存键后清理并刷新用量' },
    { item: '导入 / 导出设置', status: '部分实装', persistence: 'localStorage 设置键', effect: '导入 JSON 写回本地设置；不含 Electron 数据库完整备份', verify: '导出后修改再导入回滚' },
    { item: 'Markdown / PDF 导出格式', status: '未实装', persistence: '无', effect: '当前只提供 JSON', verify: '后续导出格式任务' },
  ],
  about: [
    { item: '版本 / 运行模式', status: '已实装', persistence: 'platform.info', effect: '显示 Web/Electron、平台、版本', verify: 'Electron 和 Web 分别打开关于页' },
    { item: '数据库位置 / 配置路径', status: '部分实装', persistence: 'platform.info.userDataPath', effect: '显示用户数据目录；具体 DB / config 文件路径未逐项列出', verify: 'Electron 关于页查看 userDataPath' },
  ],
};

export function SettingsPanel() {
  const dispatch = useAppDispatch();
  const settings = useAppSelector((s: RootState) => (s as any).settings);
  const theme = useAppSelector((s: RootState) => (s as any).theme);
  const agentSettings = useAppSelector((s: RootState) => (s as any).agentSettings);
  const multiAI = useAppSelector((s: RootState) => (s as any).multiAI);
  const [activeTab, setActiveTab] = useState('general');
  // ★ M3-2c：当前正在编辑的工作流模板 id（null=显示模式列表，否则显示 WorkflowEditor）。
  const [editingModeId, setEditingModeId] = useState<string | null>(null);
  /**
   * ★ M3-2c#fix「新建未保存」草稿：新建/复制为模板时【不立即 addMode】（避免「新建→取消」在
   *   列表/localStorage 留下永久空壳）。草稿仅存本地 state，进编辑器编辑；onSave 才 addMode 落库，
   *   onCancel 直接丢弃。draftMode 非空时编辑器以它为数据源（其 id 不在 modes 里）。
   */
  const [draftMode, setDraftMode] = useState<MultiAIMode | null>(null);
  const [availableModels, setLocalAvailableModels] = useState<AIModelOption[]>(agentSettings.availableModels ?? []);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [mcpServers, setMcpServers] = useState<Record<string, McpServerInfo>>({});
  const [loadingMcpStatus, setLoadingMcpStatus] = useState(false);
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null);
  // ── git worktree (M2-4) ──
  const [worktreeRepoRoot, setWorktreeRepoRoot] = useState('');
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [worktreeNewBranch, setWorktreeNewBranch] = useState('');
  const [worktreeForce, setWorktreeForce] = useState(false);
  const [worktreeBusy, setWorktreeBusy] = useState(false);
  const [worktreeLoaded, setWorktreeLoaded] = useState(false);
  const pluginSkills = useMemo<PluginEntry[]>(() => extensionManager.getSkills().map(skill => ({
    name: skill.name,
    description: skill.description,
    status: skill.enabled ? '启用' : '禁用',
    source: skill.contentPath,
    sourceType: skill.sourceType,
    icon: '📄',
  })), []);
  const pluginWorkflows = useMemo<PluginEntry[]>(() => extensionManager.getWorkflows().map(workflow => ({
    name: workflow.slashCommand,
    description: workflow.description,
    status: workflow.enabled ? '启用' : '禁用',
    source: workflow.contentPath,
    sourceType: workflow.sourceType,
    icon: '🚀',
  })), []);
  const [pluginRules, setPluginRules] = useState<PluginEntry[]>(() => extensionManager.getRulesSources().map(rule => ({
    name: rule.name,
    description: rule.description,
    status: rule.status === 'loaded' ? `已加载 ${rule.contentLength} 字符` : '未配置',
    source: rule.path,
    sourceType: rule.sourceType,
    icon: rule.status === 'loaded' ? '📘' : '📄',
  })));
  const pluginMcpEntries = useMemo<PluginEntry[]>(() => {
    const entries = [...mcpEntries];
    for (const name of Object.keys(mcpServers)) {
      if (entries.some(entry => entry.name === name)) continue;
      entries.push({
        name,
        description: '来自 MCP 配置文件的服务器。',
        status: '已配置',
        source: '~/.synapse/mcp_config.json 或 .synapse/mcp_config.json',
        sourceType: 'mcp',
        icon: '🔌',
      });
    }
    return entries;
  }, [mcpServers]);
  const [storageUsage, setStorageUsage] = useState<StorageUsageSnapshot>(() => calculateStorageUsageSync());
  const [loadingStorageUsage, setLoadingStorageUsage] = useState(false);
  const tabsRef = useRef<HTMLDivElement>(null);
  const settingsImportRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLocalAvailableModels(agentSettings.availableModels ?? []);
  }, [agentSettings.availableModels]);

  useEffect(() => {
    void platform.platform.info().then(setPlatformInfo).catch(() => setPlatformInfo(null));
  }, []);

  const selectedModel = useMemo(() => {
    return availableModels.some(m => m.id === agentSettings.currentModel)
      ? agentSettings.currentModel
      : '';
  }, [availableModels, agentSettings.currentModel]);
  const selectedModelOption = useMemo(
    () => availableModels.find(m => m.id === selectedModel),
    [availableModels, selectedModel],
  );
  const selectedCapabilities = selectedModelOption?.capabilities;
  const backgroundSettings = agentSettings.backgroundSettings ?? {
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
  const synopsisSettings = agentSettings.synopsisSettings ?? {
    textModeEnabled: false,
    chunkMaxTokens: 2000,
    mapConcurrency: 3,
    autoIndexEnabled: true,
    autoIndexMethod: 'contentHash',
  };

  const tabs = [
    { id: 'general', label: '⚙️ 通用' },
    { id: 'ai', label: '🤖 AI' },
    { id: 'conversation', label: '💬 对话' },
    { id: 'safety', label: '🛡 安全' },
    { id: 'synopsis', label: '📊 Synopsis' },
    { id: 'multiAI', label: '🤝 Multi-AI' },
    { id: 'plugins', label: '🧩 插件' },
    { id: 'worktree', label: '🌿 工作树' },
    { id: 'data', label: '📤 数据' },
    { id: 'about', label: 'ℹ️ 关于' },
  ];

  const fetchModels = useCallback(async () => {
    const key = settings.apiKeys?.openai;
    const endpoint = settings.apiEndpoints?.openai;
    if (!key || !endpoint) {
      dispatch(setConnectionStatus('missing'));
      dispatch(addNotification({ type: 'warning', title: '未配置 API', message: '请先填写 API Key 和端点' }));
      return [];
    }
    setLoadingModels(true);
    dispatch(setConnectionStatus('checking'));
    try {
      const models = await AIClient.fetchModels(key, endpoint);
      setLocalAvailableModels(models);
      dispatch(setAvailableModels(models));
      if (models.length > 0) {
        dispatch(setConnectionStatus('configured'));
        dispatch(addNotification({ type: 'success', title: '模型列表', message: `获取到 ${models.length} 个可用模型` }));
        if (!models.some(m => m.id === agentSettings.currentModel)) {
          dispatch(setCurrentModel(''));
        }
        dispatch(addNotification({ type: 'info', title: '请选择默认模型', message: '模型列表已刷新，请显式选择需要使用的模型。' }));
      } else {
        dispatch(setConnectionStatus('failed'));
      }
      return models;
    } catch {
      dispatch(setConnectionStatus('failed'));
      dispatch(addNotification({ type: 'error', title: '获取模型失败', message: '请检查 API Key 和端点' }));
      return [];
    } finally {
      setLoadingModels(false);
    }
  }, [settings.apiKeys?.openai, settings.apiEndpoints?.openai, agentSettings.currentModel, dispatch]);

  const refreshMcpStatus = useCallback(async () => {
    if (!isElectron) return;
    setLoadingMcpStatus(true);
    try {
      const result = await platform.mcp.getStatus();
      const servers = Array.isArray(result?.servers) ? result.servers : [];
      const next: Record<string, McpServerInfo> = {};
      for (const server of servers) {
        if (server?.name) {
          next[server.name] = server;
        }
      }
      setMcpServers(next);
    } catch (error: any) {
      dispatch(addNotification({ type: 'error', title: 'MCP 状态读取失败', message: error?.message ?? '请检查 Electron IPC 状态' }));
    } finally {
      setLoadingMcpStatus(false);
    }
  }, [dispatch]);

  useEffect(() => {
    if (activeTab === 'plugins') {
      void refreshMcpStatus();
      void extensionManager.loadRulesFromFS().then(() => {
        setPluginRules(extensionManager.getRulesSources().map(rule => ({
          name: rule.name,
          description: rule.description,
          status: rule.status === 'loaded' ? `已加载 ${rule.contentLength} 字符` : '未配置',
          source: rule.path,
          sourceType: rule.sourceType,
          icon: rule.status === 'loaded' ? '📘' : '📄',
        })));
      });
    }
  }, [activeTab, refreshMcpStatus]);

  const handleRestartMcp = useCallback(async (name: string) => {
    try {
      await platform.mcp.restart(name);
      dispatch(addNotification({ type: 'success', title: 'MCP 已重启', message: `${name} 已重新启动` }));
      await refreshMcpStatus();
    } catch (error: any) {
      dispatch(addNotification({ type: 'error', title: 'MCP 重启失败', message: error?.message ?? name }));
    }
  }, [dispatch, refreshMcpStatus]);

  const handleStartMcp = useCallback(async (name: string) => {
    try {
      await platform.mcp.start(name);
      dispatch(addNotification({ type: 'success', title: 'MCP 已启动', message: `${name} 已启动` }));
      await refreshMcpStatus();
    } catch (error: any) {
      dispatch(addNotification({ type: 'error', title: 'MCP 启动失败', message: error?.message ?? name }));
    }
  }, [dispatch, refreshMcpStatus]);

  const handleOpenExtensionPath = useCallback(async (source: string) => {
    if (!isElectron) return;
    const normalized = source.replace(/\//g, '\\');
    const escaped = normalized.replace(/'/g, "''");
    const command = [
      'powershell -NoProfile -Command',
      `"`,
      `$raw='${escaped}';`,
      `$userHome=[Environment]::GetFolderPath('UserProfile');`,
      `$p=if ($raw -eq '~') { $userHome } elseif ($raw.StartsWith('~\\')) { Join-Path $userHome $raw.Substring(2) } else { $raw };`,
      `if (Test-Path -LiteralPath $p -PathType Leaf) { explorer.exe /select,$p }`,
      `elseif (Test-Path -LiteralPath $p) { explorer.exe $p }`,
      `else { $parent=Split-Path -Parent $p; if ($parent -and (Test-Path -LiteralPath $parent)) { explorer.exe $parent } else { exit 1 } }`,
      `"`,
    ].join(' ');
    try {
      const result = await platform.command.exec(command);
      if (result.exitCode !== 0) throw new Error(result.stderr || '路径不存在或无法打开');
    } catch (error: any) {
      dispatch(addNotification({ type: 'error', title: '打开来源失败', message: error?.message ?? source }));
    }
  }, [dispatch]);

  const updateSynopsisSettings = useCallback((updates: Partial<typeof synopsisSettings>) => {
    dispatch(setSynopsisSettings(updates));
    dispatch(addNotification({ type: 'success', title: 'Synopsis 设置已保存', message: '参数已写入本地设置' }));
  }, [dispatch]);

  // ★ M3-2c：新建一个空白固定工作流模板（带一个默认 agent 节点起步），创建后直接进入编辑器。
  // ★ M3-2c#fix：不再立即 addMode——构造为本地草稿（draftMode），onSave 才落库、onCancel 直接丢弃，
  //   彻底消除「新建 → 取消」在列表/localStorage 残留空壳模板的问题。id 用唯一生成防同毫秒碰撞。
  const createWorkflowTemplate = useCallback(() => {
    const nextIndex = (multiAI?.modes || []).filter((mode: any) => !mode.isBuiltIn && !mode.isBuiltin).length + 1;
    const id = genUniqueId('wf');
    const mode: MultiAIMode = {
      id,
      name: `自定义工作流 ${nextIndex}`,
      description: '自定义固定工作流模板，可通过 @MultiAI 触发。',
      agentCount: 2,
      isBuiltin: false,
      isBuiltIn: false,
      mainAgentRole: '你是固定工作流的协调者，按节点编排推进任务。',
      subagents: [],
      triggerConditions: ['userRequest'],
      workflow: [
        {
          id: genUniqueId('agent'),
          type: 'agent',
          subagent: {
            id: genUniqueId('sub'),
            name: '执行者',
            role: '理解并完成任务',
            model: '',
            systemPrompt: '',
            toolPermissions: ['read', 'search'],
            maxTokens: 4096,
          },
          taskTemplate: '{{userInput}}',
        },
      ],
    };
    setDraftMode(mode);
    setEditingModeId(id);
  }, [multiAI?.modes]);

  // ★ M3-2c：把内建模式复制为一个新的可编辑自定义模板（内建只读，复制后才可改）。
  // ★ M3-2c#fix：同样走草稿（复制也是「新建未保存」语义，取消应丢弃，不留空壳）。id 唯一生成防碰撞。
  const duplicateModeAsTemplate = useCallback((source: MultiAIMode) => {
    const id = genUniqueId('wf');
    const cloned: MultiAIMode = {
      ...JSON.parse(JSON.stringify(source)) as MultiAIMode,
      id,
      name: `${source.name} (副本)`,
      isBuiltin: false,
      isBuiltIn: false,
    };
    setDraftMode(cloned);
    setEditingModeId(id);
  }, []);

  // ★ M3-2c：保存编辑器产出（落库走 persistMiddleware；workflow 是配置类字段，仍持久化）。
  // ★ M3-2c#fix：区分「新建未保存草稿」与「编辑已存在」——草稿（id 不在 modes 里）首次保存走 addMode，
  //   已存在走 updateMode。updates 含 subagents:[]（编辑器已归一，消除复制内建后的 subagents 僵尸数据）。
  const saveWorkflowTemplate = useCallback((id: string, updates: { name: string; description: string; workflow: WorkflowNode[]; agentCount: number; subagents: [] }) => {
    const exists = (multiAI?.modes || []).some((m: any) => m.id === id);
    if (!exists && draftMode && draftMode.id === id) {
      // 草稿首次保存：以草稿为基底，覆盖编辑器产出的字段后整条 addMode（保留 mainAgentRole/triggerConditions）。
      dispatch(addMode({ ...draftMode, ...updates }));
    } else {
      dispatch(updateMode({ id, updates }));
    }
    setDraftMode(null);
    setEditingModeId(null);
    dispatch(addNotification({ type: 'success', title: '模板已保存', message: `${updates.name} 已保存到本地设置` }));
  }, [dispatch, multiAI?.modes, draftMode]);

  // ★ M3-2c#fix：取消编辑——丢弃草稿（若有）并返回列表。草稿从未落库，无需 removeMode。
  const cancelWorkflowEdit = useCallback(() => {
    setDraftMode(null);
    setEditingModeId(null);
  }, []);

  // ★ M3-2c：删除自定义模板（内建不可删，removeMode reducer 已对 isBuiltIn 做保护）。
  // ★ M3-2c#fix：草稿（未落库）删除时只丢草稿、不 dispatch removeMode（store 里本就没有它）。
  const deleteWorkflowTemplate = useCallback((mode: MultiAIMode) => {
    const isDraft = Boolean(draftMode && draftMode.id === mode.id && !(multiAI?.modes || []).some((m: any) => m.id === mode.id));
    if (!window.confirm(`确定删除工作流模板「${mode.name}」吗？此操作不可恢复。`)) return;
    if (!isDraft) {
      dispatch(removeMode(mode.id));
      dispatch(addNotification({ type: 'warning', title: '模板已删除', message: `${mode.name} 已删除` }));
    }
    setDraftMode(null);
    setEditingModeId(null);
  }, [dispatch, draftMode, multiAI?.modes]);

  const refreshStorageUsage = useCallback(async () => {
    setLoadingStorageUsage(true);
    try {
      setStorageUsage(await calculateStorageUsage());
    } finally {
      setLoadingStorageUsage(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'data') {
      void refreshStorageUsage();
    }
  }, [activeTab, refreshStorageUsage]);

  const exportConversations = useCallback(async () => {
    const conversations = collectLocalStorage(isConversationStorageKey);
    const summaries = await listConversationSummaries().catch(() => []);
    const snapshots = await Promise.all(
      summaries.map(async (summary) => ({
        summary,
        snapshot: await exportConversationSnapshot(summary.id).catch(() => null),
      })),
    );
    downloadJson('conversations.json', {
      type: 'synapse-conversations',
      exportedAt: new Date().toISOString(),
      environment: isElectron ? 'electron' : 'web',
      conversations,
      platformConversations: snapshots.filter(item => item.snapshot),
    });
    dispatch(addNotification({
      type: 'success',
      title: '导出成功',
      message: `已导出 ${snapshots.filter(item => item.snapshot).length} 个持久化对话和 ${Object.keys(conversations).length} 个旧存储条目`,
    }));
  }, [dispatch]);

  const clearConversationHistory = useCallback(async () => {
    if (!window.confirm('确定要清除所有对话历史吗？此操作不可恢复。')) return;
    const summaries = await listConversationSummaries().catch(() => []);
    await Promise.all(summaries.map(summary => deleteConversationSnapshot(summary.id)));
    const removed = removeLocalStorage(isConversationStorageKey);
    dispatch(clearConversation());
    dispatch(setConversations([]));
    dispatch(setSelectedId(null));
    void refreshStorageUsage();
    dispatch(addNotification({
      type: 'warning',
      title: '对话历史已清除',
      message: `已删除 ${summaries.length} 个持久化对话并移除 ${removed} 个旧存储条目`,
    }));
  }, [dispatch, refreshStorageUsage]);

  const clearCache = useCallback(() => {
    const removed = removeLocalStorage(isCacheStorageKey);
    void refreshStorageUsage();
    dispatch(addNotification({ type: 'success', title: '缓存已清理', message: `已移除 ${removed} 个缓存条目` }));
  }, [dispatch, refreshStorageUsage]);

  // ── git worktree (M2-4) 操作 ──
  const pickWorktreeRepo = useCallback(async () => {
    if (!isElectron) return;
    try {
      const ws = await platform.workspace.open();
      if (ws?.path) {
        setWorktreeRepoRoot(ws.path);
        setWorktrees([]);
        setWorktreeLoaded(false);
      }
    } catch (error: any) {
      dispatch(addNotification({ type: 'error', title: '选择仓库失败', message: error?.message ?? '无法打开文件夹选择器' }));
    }
  }, [dispatch]);

  const refreshWorktrees = useCallback(async () => {
    if (!isElectron || !platform.worktree) return;
    const repoRoot = worktreeRepoRoot.trim();
    if (!repoRoot) {
      dispatch(addNotification({ type: 'warning', title: '未选择仓库', message: '请先选择一个 git 仓库目录' }));
      return;
    }
    setWorktreeBusy(true);
    try {
      const result = await platform.worktree.list({ repoRoot });
      if (result?.error) {
        setWorktrees([]);
        setWorktreeLoaded(true);
        dispatch(addNotification({ type: 'error', title: '列出工作树失败', message: result.message ?? '请确认目录是 git 仓库' }));
        return;
      }
      setWorktrees(result.worktrees ?? []);
      setWorktreeLoaded(true);
    } catch (error: any) {
      dispatch(addNotification({ type: 'error', title: '列出工作树失败', message: error?.message ?? '未知错误' }));
    } finally {
      setWorktreeBusy(false);
    }
  }, [dispatch, worktreeRepoRoot]);

  const createWorktree = useCallback(async () => {
    if (!isElectron || !platform.worktree) return;
    const repoRoot = worktreeRepoRoot.trim();
    const branch = worktreeNewBranch.trim();
    if (!repoRoot) {
      dispatch(addNotification({ type: 'warning', title: '未选择仓库', message: '请先选择一个 git 仓库目录' }));
      return;
    }
    if (!branch) {
      dispatch(addNotification({ type: 'warning', title: '缺少分支名', message: '请输入新建工作树的分支名' }));
      return;
    }
    setWorktreeBusy(true);
    try {
      const result = await platform.worktree.create({ repoRoot, branch });
      if (result?.error) {
        dispatch(addNotification({ type: 'error', title: '新建工作树失败', message: result.message ?? '请检查分支名是否合法或已存在' }));
        return;
      }
      dispatch(addNotification({ type: 'success', title: '工作树已创建', message: `${branch} → ${result.path ?? ''}` }));
      setWorktreeNewBranch('');
      await refreshWorktrees();
    } catch (error: any) {
      dispatch(addNotification({ type: 'error', title: '新建工作树失败', message: error?.message ?? '未知错误' }));
    } finally {
      setWorktreeBusy(false);
    }
  }, [dispatch, worktreeRepoRoot, worktreeNewBranch, refreshWorktrees]);

  const removeWorktree = useCallback(async (targetPath: string) => {
    if (!isElectron || !platform.worktree) return;
    const repoRoot = worktreeRepoRoot.trim();
    if (!repoRoot) return;
    // 二次确认：worktree remove 会操作 .git，force 模式可能丢弃未提交改动。
    const warnForce = worktreeForce
      ? '\n\n⚠️ 已勾选「强制删除」：该工作树内未提交的改动将被永久丢弃，且不可恢复！'
      : '';
    const confirmed = window.confirm(
      `确定删除工作树吗？\n\n${targetPath}\n\n此操作会移除该工作树目录并更新仓库的 .git 记录。${warnForce}`,
    );
    if (!confirmed) return;
    setWorktreeBusy(true);
    try {
      const result = await platform.worktree.remove({ repoRoot, path: targetPath, force: worktreeForce });
      if (result?.error) {
        dispatch(addNotification({
          type: 'error',
          title: '删除工作树失败',
          message: result.message ?? '若有未提交改动，可勾选「强制删除」后重试（会丢弃改动）',
        }));
        return;
      }
      dispatch(addNotification({ type: 'warning', title: '工作树已删除', message: targetPath }));
      await refreshWorktrees();
    } catch (error: any) {
      dispatch(addNotification({ type: 'error', title: '删除工作树失败', message: error?.message ?? '未知错误' }));
    } finally {
      setWorktreeBusy(false);
    }
  }, [dispatch, worktreeRepoRoot, worktreeForce, refreshWorktrees]);

  const exportSettings = useCallback(() => {
    const settingsDump = sanitizeSettingsExport(collectLocalStorage(isSettingsStorageKey));
    downloadJson('synapse-settings.json', {
      type: 'synapse-settings',
      exportedAt: new Date().toISOString(),
      environment: isElectron ? 'electron' : 'web',
      settings: settingsDump,
    });
    dispatch(addNotification({ type: 'success', title: '设置已导出', message: `已导出 ${Object.keys(settingsDump).length} 个设置条目` }));
  }, [dispatch]);

  const importSettings = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const settingsDump = parsed?.settings ?? parsed;
      if (!settingsDump || typeof settingsDump !== 'object' || Array.isArray(settingsDump)) {
        throw new Error('导入文件缺少 settings 对象');
      }
      let imported = 0;
      for (const [key, value] of Object.entries(settingsDump)) {
        if (!isSettingsStorageKey(key)) continue;
        localStorage.setItem(key, serializeStorageValue(value));
        imported += 1;
      }
      if (imported === 0) {
        throw new Error('导入文件没有可识别的 Synapse 设置键');
      }
      dispatch(addNotification({ type: 'success', title: '设置已导入', message: `已导入 ${imported} 个设置条目，页面将刷新` }));
      window.setTimeout(() => window.location.reload(), 300);
    } catch (error: any) {
      dispatch(addNotification({ type: 'error', title: '导入失败', message: error?.message ?? 'JSON 解析失败' }));
    }
  }, [dispatch]);

  // 壁纸选择
  const handleWallpaperSelect = useCallback(async () => {
    if (isElectron && platform.wallpaper?.importFromDialog) {
      try {
        const assets = await platform.wallpaper.importFromDialog();
        if (assets.length === 0) return;
        dispatch(addBackgroundImages(assets as WallpaperImage[]));
        dispatch(addNotification({ type: 'success', title: '壁纸', message: `已导入 ${assets.length} 张壁纸到受管目录` }));
      } catch (error: any) {
        dispatch(addNotification({ type: 'error', title: '壁纸导入失败', message: error?.message ?? '请选择有效的图片文件' }));
      }
      return;
    }
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true;
    fileInput.onchange = async (ev: any) => {
      const files = Array.from(ev.target?.files || []) as File[];
      if (files.length === 0) return;
      try {
        const images = await Promise.all(files.map((file, index) => readImageAsDataUrl(file, index)));
        dispatch(addBackgroundImages(images));
        dispatch(addNotification({ type: 'success', title: '壁纸', message: `已添加 ${files.length} 张壁纸` }));
      } catch {
        dispatch(addNotification({ type: 'error', title: '壁纸读取失败', message: '请选择有效的图片文件' }));
      }
    };
    fileInput.click();
  }, [dispatch]);

  const handleRemoveWallpaper = useCallback(async (index: number) => {
    const item = backgroundSettings.images[index] as WallpaperImage | undefined;
    if (isManagedWallpaper(item) && platform.wallpaper?.remove) {
      const result = await platform.wallpaper.remove(item);
      if (result?.error) {
        dispatch(addNotification({ type: 'error', title: '壁纸删除失败', message: result.message ?? '受管壁纸文件删除失败' }));
        return;
      }
    }
    dispatch(removeBackgroundImage(index));
  }, [backgroundSettings.images, dispatch]);

  // 清除壁纸
  const handleClearWallpaper = useCallback(async () => {
    const managed = backgroundSettings.images.filter(isManagedWallpaper);
    if (managed.length > 0 && platform.wallpaper?.clear) {
      const result = await platform.wallpaper.clear(managed);
      if (result?.error) {
        dispatch(addNotification({ type: 'error', title: '壁纸清除失败', message: result.message ?? '受管壁纸文件清除失败' }));
        return;
      }
    }
    dispatch(clearBackgroundImages());
  }, [backgroundSettings.images, dispatch]);

  const scrollTabs = useCallback((direction: 'left' | 'right') => {
    tabsRef.current?.scrollBy({
      left: direction === 'left' ? -160 : 160,
      behavior: 'smooth',
    });
  }, []);

  return (
    <div className="settings-panel">
      <div className="settings-tabs-shell">
        <button className="settings-tabs-nav" type="button" aria-label="向左滚动设置标签" onClick={() => scrollTabs('left')}>
          ‹
        </button>
        <div className="settings-tabs" ref={tabsRef}>
          {tabs.map(tab => (
            <button
              key={tab.id}
              className={`settings-tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              title={tab.label}
            >
              <span className="settings-tab-label">{tab.label}</span>
            </button>
          ))}
        </div>
        <button className="settings-tabs-nav" type="button" aria-label="向右滚动设置标签" onClick={() => scrollTabs('right')}>
          ›
        </button>
      </div>

      <div className="settings-content">
        {activeTab === 'general' && (
          <div className="settings-section">
            <h3>通用设置</h3>
            <SettingsAuditMatrix rows={settingAuditRows.general} />
            <div className="setting-item">
              <label>语言</label>
              <select value={settings.language} onChange={e => {
                dispatch(setLanguage(e.target.value as 'zh-CN' | 'en'));
                dispatch(addNotification({ type: 'info', title: '语言设置', message: '多语言界面即将支持，当前仅保存偏好。' }));
              }}>
                <option value="zh-CN">中文</option>
                <option value="en">English</option>
              </select>
            </div>
            <div className="setting-item">
              <label>字号</label>
              <input type="range" min="12" max="20" step="1" value={settings.fontSize}
                onChange={e => dispatch(setFontSize(Number(e.target.value)))} />
              <span>{settings.fontSize}px</span>
            </div>
            <div className="setting-item">
              <label>主题</label>
              <select value={theme.mode} onChange={e => dispatch(setThemeMode(e.target.value as 'dark' | 'light' | 'system'))}>
                <option value="dark">深色</option>
                <option value="light">浅色</option>
                <option value="system">跟随系统</option>
              </select>
            </div>
            <div className="setting-item">
              <label>强调色</label>
              <input type="color" value={theme.accentColor} onChange={e => dispatch(setAccentColor(e.target.value))} />
            </div>

            <h3 style={{ marginTop: 24 }}>🖼️ 壁纸与磨砂</h3>
            <ToggleItem label="启用壁纸" checked={backgroundSettings.enabled}
              onChange={v => dispatch(setBackgroundSettings({ enabled: v }))} />
            <div className="setting-item">
              <label>背景图</label>
              <div className="setting-control-row">
                <button className="settings-btn" onClick={handleWallpaperSelect}>
                  📁 选择图片
                </button>
                {backgroundSettings.images.length > 0 && (
                  <button className="settings-btn danger" onClick={handleClearWallpaper}>
                    ✕ 清除
                  </button>
                )}
              </div>
            </div>
            {backgroundSettings.images.length > 0 && (
              <div className="setting-item">
                <label>已添加 ({backgroundSettings.images.length})</label>
                <div className="wallpaper-grid">
                  {backgroundSettings.images.map((bg: WallpaperImage, i: number) => (
                    <button
                      key={`${bg.id ?? getWallpaperUrl(bg).slice(0, 24)}-${i}`}
                      type="button"
                      className={`wallpaper-thumb ${i === backgroundSettings.selectedIndex ? 'active' : ''}`}
                      style={{ backgroundImage: `url(${getWallpaperUrl(bg)})` }}
                      aria-label={`选择 ${getWallpaperName(bg, i)}`}
                      title={`${getWallpaperName(bg, i)}${bg.kind === 'managed' ? ' · 受管文件' : ' · Web 本地数据'}`}
                      onClick={() => dispatch(selectBackgroundImage(i))}
                    >
                      <span
                        role="button"
                        tabIndex={0}
                        className="wallpaper-remove"
                        aria-label={`删除第 ${i + 1} 张壁纸`}
                        onClick={event => {
                          event.stopPropagation();
                          void handleRemoveWallpaper(i);
                        }}
                        onKeyDown={event => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            event.stopPropagation();
                            void handleRemoveWallpaper(i);
                          }
                        }}
                      >
                        ×
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="setting-item">
              <label>轮播模式</label>
              <select value={backgroundSettings.displayMode} onChange={e => dispatch(setBackgroundSettings({ displayMode: e.target.value as any }))}>
                <option value="static">静态</option>
                <option value="carousel">顺序轮播</option>
                <option value="random">随机切换</option>
              </select>
            </div>
            {backgroundSettings.displayMode !== 'static' && (
              <div className="setting-item">
                <label>切换间隔</label>
                <input type="range" min="10" max="600" step="10" value={backgroundSettings.carouselInterval}
                  onChange={e => dispatch(setBackgroundSettings({ carouselInterval: Number(e.target.value) }))} />
                <span>{backgroundSettings.carouselInterval}s</span>
              </div>
            )}
            <div className="setting-item">
              <label>切换效果</label>
              <select value={backgroundSettings.transitionEffect} onChange={e => dispatch(setBackgroundSettings({ transitionEffect: e.target.value as any }))}>
                <option value="fade">淡入淡出</option>
                <option value="slide">滑动</option>
              </select>
            </div>
            <div className="setting-item">
              <label>磨砂度</label>
              <input type="range" min="0" max="30" step="1" value={backgroundSettings.blur}
                onChange={e => dispatch(setBackgroundSettings({ blur: Number(e.target.value) }))} />
              <span>{backgroundSettings.blur}px</span>
            </div>
            <div className="setting-item">
              <label>壁纸透明度</label>
              <input type="range" min="10" max="100" step="5"
                value={Math.round(backgroundSettings.opacity * 100)}
                onChange={e => dispatch(setBackgroundSettings({ opacity: Number(e.target.value) / 100 }))} />
              <span>{Math.round(backgroundSettings.opacity * 100)}%</span>
            </div>
            <div className="setting-item">
              <label>面板透明度</label>
              <input type="range" min="50" max="95" step="5"
                value={Math.round(backgroundSettings.panelOpacity * 100)}
                onChange={e => dispatch(setBackgroundSettings({ panelOpacity: Number(e.target.value) / 100 }))} />
              <span>{Math.round(backgroundSettings.panelOpacity * 100)}%</span>
            </div>
          </div>
        )}

        {activeTab === 'ai' && (
          <div className="settings-section">
            <h3>AI 设置</h3>
            <SettingsAuditMatrix rows={settingAuditRows.ai} />
            <div className="setting-item">
              <label>API Key</label>
              <input type="password" placeholder="sk-..."
                value={settings.apiKeys?.openai ?? ''}
                onChange={e => dispatch(setApiKey({ provider: 'openai', key: e.target.value }))} />
            </div>
            <div className="setting-item">
              <label>API 端点</label>
              <input type="text" placeholder="https://api.openai.com/v1"
                value={settings.apiEndpoints?.openai ?? ''}
                onChange={e => dispatch(setApiEndpoint({ provider: 'openai', url: e.target.value }))} />
            </div>
            <div className="setting-item">
              <label>测试连接</label>
              <button className="settings-btn" disabled={testingConnection}
                onClick={async () => {
                  setTestingConnection(true);
                  try {
                    const models = await fetchModels();
                    if (models && models.length > 0) {
                      dispatch(addNotification({ type: 'success', title: '✅ 连接成功', message: `发现 ${models.length} 个模型` }));
                    } else {
                      dispatch(addNotification({ type: 'warning', title: '⚠️ 连接异常', message: '端点可达但未返回模型列表' }));
                    }
                  } catch {
                    dispatch(addNotification({ type: 'error', title: '❌ 连接失败', message: '请检查 API Key 和端点' }));
                  }
                  setTestingConnection(false);
                }}>
                {testingConnection ? '⏳ 测试中...' : '🔌 测试连接'}
              </button>
            </div>
            <div className="setting-item">
              <label>默认模型</label>
              <div className="setting-control-row">
                <select value={selectedModel}
                  onChange={e => dispatch(setCurrentModel(e.target.value))}>
                  <option value="">{availableModels.length > 0 ? '未选择模型' : '请先获取模型列表'}</option>
                  {availableModels.map(m => (
                    <option key={m.id} value={m.id}>{m.name || m.id}</option>
                  ))}
                </select>
                <button className="settings-btn" onClick={fetchModels} disabled={loadingModels}
                  style={{ flexShrink: 0 }}>
                  {loadingModels ? '⏳ 获取中...' : '🔄 获取模型'}
                </button>
              </div>
            </div>
            {availableModels.length > 0 && (
              <div className="setting-item" style={{ fontSize: 12, color: 'var(--syn-text-muted)' }}>
                已获取 {availableModels.length} 个模型
              </div>
            )}
            {selectedModelOption && (
              <div className="setting-item model-capability-summary">
                <label>模型能力</label>
                <div className="settings-chip-row">
                  {describeCapabilities(selectedCapabilities).map(label => (
                    <span key={label} className="settings-chip">{label}</span>
                  ))}
                  {selectedCapabilities?.source && (
                    <span className="setting-hint">来源: {selectedCapabilities.source === 'inferred' ? '推断' : '接口 + 推断'}</span>
                  )}
                </div>
              </div>
            )}
            <div className="setting-item">
              <label>输出策略</label>
              <select
                value={agentSettings.outputStrategy ?? ((agentSettings.enableStreaming ?? true) ? 'auto' : 'off')}
                onChange={e => dispatch(setOutputStrategy(e.target.value as any))}
              >
                <option value="auto">自动：真流式优先，失败后伪流式</option>
                <option value="real" disabled={selectedCapabilities?.streaming === false}>真流式：强制 SSE</option>
                <option value="pseudo">伪流式：完整响应后前端播放</option>
                <option value="off">关闭流式：一次性显示</option>
              </select>
              <span className="setting-hint">
                {selectedCapabilities?.streaming === false ? '当前模型未声明支持 SSE，自动模式会使用伪流式' : '支持时优先使用 SSE 实时输出'}
              </span>
            </div>
            <div className="setting-item">
              <label>伪流式速度</label>
              <select
                value={agentSettings.pseudoStreamSpeed ?? 'medium'}
                onChange={e => dispatch(setPseudoStreamSpeed(e.target.value as any))}
              >
                <option value="slow">慢</option>
                <option value="medium">中</option>
                <option value="fast">快</option>
              </select>
              <span className="setting-hint">自动降级和伪流式模式使用</span>
            </div>
            <div className="setting-item">
              <label>流式光标</label>
              <input type="checkbox"
                checked={agentSettings.showStreamCursor ?? true}
                onChange={e => dispatch(setShowStreamCursor(e.target.checked))} />
              <span className="setting-hint">生成中显示闪烁光标</span>
            </div>
            <div className="setting-item">
              <label>生成占位</label>
              <input type="checkbox"
                checked={agentSettings.showGeneratingPlaceholder ?? true}
                onChange={e => dispatch(setShowGeneratingPlaceholder(e.target.checked))} />
              <span className="setting-hint">尚未收到文本时显示思考中</span>
            </div>
            <div className="setting-item">
              <label>显示 Thinking</label>
              <input type="checkbox"
                checked={(agentSettings.showThinking ?? true) && (selectedCapabilities?.thinking ?? true)}
                disabled={selectedCapabilities?.thinking === false}
                onChange={e => dispatch(setShowThinking(e.target.checked))} />
              <span className="setting-hint">
                {selectedCapabilities?.thinking === false ? '当前模型未声明支持 thinking' : '默认折叠显示思考内容'}
              </span>
            </div>
            <div className="setting-item">
              <label>Thinking 伪流式</label>
              <input type="checkbox"
                checked={(agentSettings.streamThinking ?? true) && (selectedCapabilities?.thinking ?? true)}
                disabled={selectedCapabilities?.thinking === false}
                onChange={e => dispatch(setStreamThinking(e.target.checked))} />
              <span className="setting-hint">
                {selectedCapabilities?.thinking === false ? '当前模型未声明支持 thinking' : '非流式返回 thinking 时按伪流式展开'}
              </span>
            </div>
            <div className="setting-item">
              <label>Top P</label>
              <input type="range" min="0" max="100" step="5" value={Math.round((agentSettings.topP ?? 1) * 100)}
                onChange={e => dispatch(setTopP(Number(e.target.value) / 100))} />
              <span>{(agentSettings.topP ?? 1).toFixed(2)}</span>
            </div>
            <div className="setting-item">
              <label>Reasoning Effort</label>
              <select
                value={selectedCapabilities?.reasoning ? (agentSettings.reasoningEffort ?? 'auto') : 'auto'}
                disabled={!selectedCapabilities?.reasoning}
                onChange={e => dispatch(setReasoningEffort(e.target.value))}
              >
                {(selectedCapabilities?.reasoningEffortOptions ?? ['auto']).map(option => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
              {!selectedCapabilities?.reasoning && <span className="setting-hint">当前模型不支持</span>}
            </div>
            <div className="setting-item">
              <label>Speed Tier</label>
              <select
                value={(selectedCapabilities?.speedTierOptions ?? ['auto']).includes(agentSettings.speedTier) ? agentSettings.speedTier : 'auto'}
                disabled={(selectedCapabilities?.speedTierOptions ?? ['auto']).length <= 1}
                onChange={e => dispatch(setSpeedTier(e.target.value))}
              >
                {(selectedCapabilities?.speedTierOptions ?? ['auto']).map(option => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
              {(selectedCapabilities?.speedTierOptions ?? ['auto']).length <= 1 && <span className="setting-hint">当前模型不支持</span>}
            </div>

            <h3 style={{ marginTop: 24 }}>🔒 安全与审批</h3>
            <ToggleItem label="自动批准读取" checked={settings.safety?.autoApproveRead ?? true}
              onChange={v => dispatch(setSafety({ autoApproveRead: v }))} />
            <ToggleItem label="自动批准写入" checked={settings.safety?.autoApproveWrite ?? false}
              onChange={v => dispatch(setSafety({ autoApproveWrite: v }))} />
            <ToggleItem label="自动批准命令" checked={settings.safety?.autoApproveCommand ?? false}
              onChange={v => dispatch(setSafety({ autoApproveCommand: v }))} />
            <ToggleItem label="全部自动批准" checked={settings.safety?.autoApproveAll ?? false}
              onChange={v => dispatch(setSafety({ autoApproveAll: v }))} />

            <h3 style={{ marginTop: 24 }}>🧩 AI 注入配置</h3>
            <ToggleItem label="身份提示词" checked={settings.promptInjection?.injectIdentity ?? true}
              onChange={v => dispatch(setPromptInjection({ injectIdentity: v }))} />
            <ToggleItem label="工具定义" checked={settings.promptInjection?.injectTools ?? true}
              onChange={v => dispatch(setPromptInjection({ injectTools: v }))} />
            <ToggleItem label="SKILL 注入" checked={settings.promptInjection?.injectSkills ?? true}
              onChange={v => dispatch(setPromptInjection({ injectSkills: v }))} />
            <ToggleItem label="上下文注入" checked={settings.promptInjection?.injectContext ?? true}
              onChange={v => dispatch(setPromptInjection({ injectContext: v }))} />
            <ToggleItem label="用户规则" checked={settings.promptInjection?.injectRules ?? true}
              onChange={v => dispatch(setPromptInjection({ injectRules: v }))} />
            <ToggleItem label="Workflow 注入" checked={settings.promptInjection?.injectWorkflows ?? true}
              onChange={v => dispatch(setPromptInjection({ injectWorkflows: v }))} />
          </div>
        )}

        {activeTab === 'conversation' && (
          <div className="settings-section">
            <h3>💬 对话管理</h3>
            <SettingsAuditMatrix rows={settingAuditRows.conversation} />
            <div className="setting-item">
              <label>最大对话历史</label>
              <input type="range" min="10" max="500" step="10" value={settings.maxConversationHistory}
                onChange={e => dispatch(setMaxConversationHistory(Number(e.target.value)))} />
              <span>{settings.maxConversationHistory} 条</span>
            </div>
            <div className="setting-item">
              <label>自动归档天数</label>
              <input type="range" min="0" max="90" step="5" value={settings.autoArchiveAfter}
                onChange={e => dispatch(setAutoArchiveAfter(Number(e.target.value)))} />
              <span>{settings.autoArchiveAfter === 0 ? '关闭' : `${settings.autoArchiveAfter} 天`}</span>
            </div>
            <div className="setting-item">
              <label>Temperature</label>
              <input type="range" min="0" max="200" step="5" value={Math.round((agentSettings.temperature ?? 0.7) * 100)}
                onChange={e => dispatch(setTemperature(Number(e.target.value) / 100))} />
              <span>{(agentSettings.temperature ?? 0.7).toFixed(2)}</span>
            </div>
            <div className="setting-item">
              <label>Max Tokens</label>
              <input type="number" min="256" max="128000" step="256" value={agentSettings.maxTokens ?? 4096}
                style={{ width: 100 }} onChange={e => dispatch(setMaxTokens(Number(e.target.value)))} />
              <span className="setting-hint">最大输出 Token 数</span>
            </div>

            <h3 style={{ marginTop: 24 }}>📝 压缩策略</h3>
            <div className="setting-item">
              <label>CHECKPOINT 触发阈值</label>
              <span className="setting-hint">当上下文超过 Token 限制的 80% 时自动压缩</span>
            </div>
            <div className="setting-item">
              <label>每次压缩保留</label>
              <span className="setting-hint">保留最近 4 条消息 + 系统摘要</span>
            </div>
          </div>
        )}

        {activeTab === 'safety' && (
          <div className="settings-section">
            <h3>🛡 安全与审批</h3>
            <SettingsAuditMatrix rows={settingAuditRows.safety} />
            <ToggleItem label="自动批准读取" checked={settings.safety?.autoApproveRead ?? true}
              onChange={v => dispatch(setSafety({ autoApproveRead: v }))} />
            <ToggleItem label="自动批准写入" checked={settings.safety?.autoApproveWrite ?? false}
              onChange={v => dispatch(setSafety({ autoApproveWrite: v }))} />
            <ToggleItem label="自动批准命令" checked={settings.safety?.autoApproveCommand ?? false}
              onChange={v => dispatch(setSafety({ autoApproveCommand: v }))} />
            <ToggleItem label="全部自动批准" checked={settings.safety?.autoApproveAll ?? false}
              onChange={v => dispatch(setSafety({ autoApproveAll: v }))} />

            <h3 style={{ marginTop: 24 }}>Sandbox 限制</h3>
            <div className="setting-item">
              <label>命令超时</label>
              <span>30 秒</span>
              <span className="setting-hint">固定默认，暂未开放调整</span>
            </div>
            <div className="setting-item">
              <label>内存限制</label>
              <span>256 MB</span>
              <span className="setting-hint">固定默认，暂未开放调整</span>
            </div>

            <h3 style={{ marginTop: 24 }}>📌 系统提示注入</h3>
            <ToggleItem label="身份提示词" checked={settings.promptInjection?.injectIdentity ?? true}
              onChange={v => dispatch(setPromptInjection({ injectIdentity: v }))} />
            <ToggleItem label="工具定义" checked={settings.promptInjection?.injectTools ?? true}
              onChange={v => dispatch(setPromptInjection({ injectTools: v }))} />
            <ToggleItem label="SKILL 注入" checked={settings.promptInjection?.injectSkills ?? true}
              onChange={v => dispatch(setPromptInjection({ injectSkills: v }))} />
            <ToggleItem label="上下文注入" checked={settings.promptInjection?.injectContext ?? true}
              onChange={v => dispatch(setPromptInjection({ injectContext: v }))} />
            <ToggleItem label="用户规则" checked={settings.promptInjection?.injectRules ?? true}
              onChange={v => dispatch(setPromptInjection({ injectRules: v }))} />
            <ToggleItem label="Workflow 注入" checked={settings.promptInjection?.injectWorkflows ?? true}
              onChange={v => dispatch(setPromptInjection({ injectWorkflows: v }))} />
          </div>
        )}

        {activeTab === 'synopsis' && (
          <div className="settings-section">
            <h3>📊 Synopsis 引擎</h3>
            <SettingsAuditMatrix rows={settingAuditRows.synopsis} />
            <p className="setting-hint">文档解析与 RAG 生成管线参数，修改后会写入本地设置。</p>
            <ToggleItem label="TEXT MODE (纯文本模式)" checked={synopsisSettings.textModeEnabled}
              onChange={v => updateSynopsisSettings({ textModeEnabled: v })} />
            <div className="setting-hint" style={{ padding: '0 16px', fontSize: 12, color: 'var(--syn-text-muted)' }}>
              ℹ️ 当您没有多模态 API 时，开启 TEXT MODE 将使用 OCR 提取文字后送入文本模型
            </div>
            <div className="setting-item">
              <label>每块最大 Token</label>
              <input type="number" min="100" max="8000" step="100" value={synopsisSettings.chunkMaxTokens}
                onChange={e => updateSynopsisSettings({ chunkMaxTokens: clampNumber(e.target.value, 100, 8000, 2000) })} />
            </div>
            <div className="setting-item">
              <label>Map 并发数</label>
              <input type="number" min="1" max="10" step="1" value={synopsisSettings.mapConcurrency}
                onChange={e => updateSynopsisSettings({ mapConcurrency: clampNumber(e.target.value, 1, 10, 3) })} />
            </div>
            <ToggleItem label="索引自动更新" checked={synopsisSettings.autoIndexEnabled}
              onChange={v => updateSynopsisSettings({ autoIndexEnabled: v })} />
            <div className="setting-item">
              <label>更新策略</label>
              <select value={synopsisSettings.autoIndexMethod}
                onChange={e => updateSynopsisSettings({ autoIndexMethod: e.target.value as 'contentHash' | 'timestamp' })}>
                <option value="contentHash">contentHash 对比</option>
                <option value="timestamp">timestamp 时间戳</option>
              </select>
            </div>
          </div>
        )}

        {activeTab === 'plugins' && (
          <div className="settings-section">
            <h3>🧩 插件管理</h3>
            <SettingsAuditMatrix rows={settingAuditRows.plugins} />
            <p className="setting-hint">MCP 在 Electron 模式下读取真实进程状态；扩展条目保留来源信息并支持打开目录。</p>
            <div className="plugin-section">
              <div className="plugin-section-heading">
                <h4>MCP 服务器</h4>
                {isElectron && (
                  <button className="settings-btn compact" type="button" onClick={refreshMcpStatus} disabled={loadingMcpStatus}>
                    {loadingMcpStatus ? '刷新中' : '刷新'}
                  </button>
                )}
              </div>
              <div className="plugin-list">
                {pluginMcpEntries.map(item => {
                  const serverInfo = mcpServers[item.name];
                  const status = isElectron ? getMcpStatus(serverInfo) : { label: 'Electron 模式下可用', tone: 'muted' as const };
                  return (
                    <PluginItem
                      key={item.name}
                      {...item}
                      status={status.label}
                      statusTone={status.tone}
                      actionLabel={isElectron && serverInfo && serverInfo.configured !== false ? (serverInfo.running ? '重启' : '启动') : undefined}
                      actionDisabled={loadingMcpStatus || serverInfo?.enabled === false}
                      onAction={() => serverInfo?.running ? handleRestartMcp(item.name) : handleStartMcp(item.name)}
                    />
                  );
                })}
              </div>
            </div>
            <div className="plugin-section">
              <h4>SKILL ({pluginSkills.length})</h4>
              <div className="plugin-list">
                {pluginSkills.map(item => (
                  <PluginItem
                    key={item.name}
                    {...item}
                    statusTone="ok"
                    actionLabel={isElectron ? '📂 打开目录' : undefined}
                    onAction={() => handleOpenExtensionPath(item.source)}
                  />
                ))}
              </div>
            </div>
            <div className="plugin-section">
              <h4>WORKFLOW ({pluginWorkflows.length})</h4>
              <div className="plugin-list">
                {pluginWorkflows.map(item => (
                  <PluginItem
                    key={item.name}
                    {...item}
                    statusTone="ok"
                    actionLabel={isElectron ? '📂 打开目录' : undefined}
                    onAction={() => handleOpenExtensionPath(item.source)}
                  />
                ))}
              </div>
            </div>
            <div className="plugin-section">
              <h4>RULES</h4>
              <div className="plugin-list">
                {pluginRules.map(item => (
                  <PluginItem
                    key={item.name}
                    {...item}
                    statusTone={item.status === '未配置' ? 'muted' : 'ok'}
                    actionLabel={isElectron ? '📂 打开来源' : undefined}
                    onAction={() => handleOpenExtensionPath(item.source)}
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'multiAI' && (
          <div className="settings-section">
            <h3>🤝 Multi-AI 协作</h3>
            <SettingsAuditMatrix rows={settingAuditRows.multiAI} />
            <p className="setting-hint">启用后，主 Agent 可按当前模式创建子代理协助工作，设置会写入本地持久化。</p>
            <ToggleItem label="启用 Multi-AI" checked={multiAI?.enabled ?? false}
              onChange={v => dispatch(setMultiAIEnabled(v))} />
            <div className="setting-hint" style={{ padding: '0 16px', fontSize: 12, color: 'var(--syn-text-muted)' }}>
              ℹ️ 启用后，主 Agent 可以通过 spawn_subagent 工具创建子代理来协助工作
            </div>

            {(() => {
              const modes: MultiAIMode[] = (multiAI?.modes || []) as MultiAIMode[];
              // ★ M3-2c#fix：草稿（新建/复制未保存，id 不在 modes 里）优先；否则按 id 找已存在的自定义模式。
              const editingMode = editingModeId
                ? (draftMode && draftMode.id === editingModeId ? draftMode : modes.find(m => m.id === editingModeId))
                : undefined;
              // ★ M3-2c：进入编辑器视图（仅自定义模板可编辑；built-in 不会被设为 editingModeId）。
              if (editingMode && !editingMode.isBuiltIn && !(editingMode as any).isBuiltin) {
                return (
                  <WorkflowEditor
                    key={editingMode.id}
                    mode={editingMode}
                    availableModels={availableModels}
                    onSave={updates => saveWorkflowTemplate(editingMode.id, updates)}
                    onCancel={cancelWorkflowEdit}
                    onDelete={() => deleteWorkflowTemplate(editingMode)}
                    notify={(type, title, message) => dispatch(addNotification({ type, title, message }))}
                    // ★ M3-2c#fix 重名校验：与现有 modes（排除本 mode 自身 id）大小写不敏感比对。
                    isNameTaken={(trimmedName) => {
                      const lower = trimmedName.toLowerCase();
                      return modes.some(m => m.id !== editingMode.id && m.name.trim().toLowerCase() === lower);
                    }}
                  />
                );
              }
              // 列表视图：内建（只读 / 可复制）与自定义（可编辑 / 可删）分别给操作。
              return (
                <>
                  <div className="settings-subsection-title">固定工作流模板</div>
                  <p className="setting-hint">
                    内建模板只读（可「复制为模板」后再改）；自定义模板可编辑 / 删除。
                    带工作流的模板可用 <code>{MULTI_AI_TRIGGER_PREFIX}模式名 任务描述</code> 在对话中触发。
                  </p>
                  <div className="multi-ai-mode-list">
                    {modes.map((mode) => {
                      const builtIn = Boolean(mode.isBuiltIn || (mode as any).isBuiltin);
                      const hasWorkflow = Array.isArray(mode.workflow) && mode.workflow.length > 0;
                      const active = (multiAI?.activeMode || 'solo') === mode.id;
                      return (
                        <div key={mode.id} className={`multi-ai-mode ${active ? 'active' : ''}`}>
                          <div className="multi-ai-mode-main">
                            <span className="multi-ai-mode-icon">{hasWorkflow ? '🔀' : '📋'}</span>
                            <div className="multi-ai-mode-text">
                              <span className="multi-ai-mode-name">
                                {mode.name}
                                {' '}
                                <span className={`workflow-mode-badge ${builtIn ? 'builtin' : 'custom'}`}>
                                  {builtIn ? '内建' : '自定义'}
                                </span>
                                {hasWorkflow && <span className="workflow-mode-badge wf">工作流·{mode.workflow!.length}节点</span>}
                              </span>
                              <span className="multi-ai-mode-description">{mode.description}</span>
                            </div>
                          </div>
                          <span className="multi-ai-agent-count">{formatAgentCount(mode.agentCount ?? ((mode.subagents?.length ?? 0) + 1))}</span>
                          <div className="workflow-mode-actions">
                            {active ? (
                              <span className="plugin-status ok">默认</span>
                            ) : (
                              <button className="settings-btn compact" type="button" onClick={() => dispatch(setActiveMode(mode.id))}>
                                选择
                              </button>
                            )}
                            {builtIn ? (
                              <button className="settings-btn compact" type="button" onClick={() => duplicateModeAsTemplate(mode)} title="复制为可编辑的自定义模板">
                                复制为模板
                              </button>
                            ) : (
                              <>
                                <button className="settings-btn compact" type="button" onClick={() => setEditingModeId(mode.id)}>
                                  编辑
                                </button>
                                <button className="settings-btn danger compact" type="button" onClick={() => deleteWorkflowTemplate(mode)}>
                                  删除
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="setting-item">
                    <label>新建工作流模板</label>
                    <button className="settings-btn" type="button" onClick={createWorkflowTemplate}>
                      ＋ 新建模板
                    </button>
                  </div>
                </>
              );
            })()}

            <div className="settings-subsection-title">默认 Subagent 配置</div>
            <div className="setting-item">
              <label>子代理模型</label>
              <select value={multiAI?.defaultSubagentModel ?? multiAI?.subagentDefaultModel ?? ''}
                onChange={e => dispatch(setSubagentDefaultModel(e.target.value))}>
                <option value="">跟随主 Agent 模型</option>
                {availableModels.map(m => (
                  <option key={m.id} value={m.id}>{m.name || m.id}</option>
                ))}
              </select>
            </div>
            <div className="setting-item">
              <label>Token 上限</label>
              <input type="number" min="1024" max="128000" step="1024" value={multiAI?.defaultSubagentMaxTokens ?? 32000}
                onChange={e => dispatch(setDefaultSubagentMaxTokens(clampNumber(e.target.value, 1024, 128000, 32000)))} />
            </div>
            <div className="setting-item">
              <label>最大并行</label>
              <input type="number" min="1" max="10" step="1" value={multiAI?.maxConcurrentSubagents || 3}
                onChange={e => dispatch(setMaxConcurrentSubagents(clampNumber(e.target.value, 1, 10, 3)))} />
            </div>

            {(multiAI?.runningSubagents || []).length > 0 && (
              <>
                <h3 style={{ marginTop: 24 }}>🟢 运行中的子代理</h3>
                {multiAI.runningSubagents.map((sub: any) => (
                  <div key={sub.id} className="plugin-item">
                    <span className="plugin-icon">{sub.status === 'running' ? '⏳' : sub.status === 'complete' ? '✅' : '❌'}</span>
                    <div className="plugin-info">
                      <span className="plugin-name">{sub.role}</span>
                      <span className="plugin-status">{sub.model} • {sub.status}</span>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {activeTab === 'worktree' && (
          <div className="settings-section">
            <h3>🌿 Git 工作树</h3>
            <p className="setting-hint">
              在一个 git 仓库基础上创建、查看、删除独立的工作树（git worktree），为隔离任务环境做准备。
              {' '}这是磁盘上真实的 git worktree，区别于对话分支。
            </p>
            {!isElectron ? (
              <div className="setting-item">
                <span className="plugin-status muted">git worktree 管理仅在 Electron 桌面模式下可用</span>
              </div>
            ) : (
              <>
                <div className="setting-item">
                  <label>目标仓库</label>
                  <div className="setting-control-row">
                    <input
                      type="text"
                      placeholder="选择或填写 git 仓库根目录"
                      value={worktreeRepoRoot}
                      onChange={e => { setWorktreeRepoRoot(e.target.value); setWorktreeLoaded(false); }}
                    />
                    <button className="settings-btn" type="button" onClick={pickWorktreeRepo} disabled={worktreeBusy} style={{ flexShrink: 0 }}>
                      📁 选择
                    </button>
                    <button className="settings-btn" type="button" onClick={refreshWorktrees} disabled={worktreeBusy || !worktreeRepoRoot.trim()} style={{ flexShrink: 0 }}>
                      {worktreeBusy ? '⏳' : '🔄 列出'}
                    </button>
                  </div>
                  <p className="setting-hint">非 git 仓库会提示先执行 git init。新建工作树默认放在用户数据目录的 worktrees/ 下。</p>
                </div>

                <div className="setting-item">
                  <label>新建工作树</label>
                  <div className="setting-control-row">
                    <input
                      type="text"
                      placeholder="新分支名（如 feature-x）"
                      value={worktreeNewBranch}
                      onChange={e => setWorktreeNewBranch(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') void createWorktree(); }}
                    />
                    <button className="settings-btn" type="button" onClick={createWorktree} disabled={worktreeBusy || !worktreeRepoRoot.trim() || !worktreeNewBranch.trim()} style={{ flexShrink: 0 }}>
                      ➕ 创建
                    </button>
                  </div>
                  <p className="setting-hint">执行 git worktree add &lt;路径&gt; -b &lt;分支&gt;，会在该工作树中新建同名分支。</p>
                </div>

                <ToggleItem
                  label="删除时强制（丢弃未提交改动）"
                  checked={worktreeForce}
                  onChange={setWorktreeForce}
                />
                <p className="setting-hint" style={{ padding: '0 16px', fontSize: 12, color: 'var(--syn-text-muted)' }}>
                  ⚠️ 默认关闭。关闭时若工作树有未提交改动，删除会被 git 拒绝以保护数据；开启后将带 --force 强制删除并丢弃改动。
                </p>

                <div className="plugin-section" style={{ marginTop: 16 }}>
                  <div className="plugin-section-heading">
                    <h4>工作树列表 ({worktrees.length})</h4>
                  </div>
                  <div className="plugin-list">
                    {worktrees.length === 0 ? (
                      <div className="setting-hint" style={{ padding: '8px 0' }}>
                        {worktreeLoaded ? '没有找到工作树（或仅有主工作树）。' : '选择仓库后点击「列出」查看工作树。'}
                      </div>
                    ) : (
                      worktrees.map((wt, index) => {
                        // git worktree list --porcelain 的第一条恒为主工作树（已实测确认）。
                        const isMain = index === 0;
                        return (
                          <div className="plugin-item" key={wt.path}>
                            <span className="plugin-icon">{wt.bare ? '📦' : isMain ? '🏠' : '🌿'}</span>
                            <div className="plugin-info">
                              <span className="plugin-name">{wt.branch ?? (wt.detached ? '(detached HEAD)' : wt.bare ? '(bare)' : '(无分支)')}</span>
                              <div className="plugin-meta">
                                {wt.head && <span className="plugin-status muted">{wt.head.slice(0, 8)}</span>}
                                {isMain && <span className="plugin-status ok">主工作树</span>}
                                {wt.locked && <span className="plugin-status warn">已锁定</span>}
                                <span className="plugin-source">{wt.path}</span>
                              </div>
                            </div>
                            {!isMain && !wt.bare && (
                              <button
                                className="settings-btn danger plugin-action"
                                type="button"
                                disabled={worktreeBusy}
                                onClick={() => void removeWorktree(wt.path)}
                              >
                                🗑 删除
                              </button>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {activeTab === 'data' && (
          <div className="settings-section">
            <h3>📤 数据管理</h3>
            <SettingsAuditMatrix rows={settingAuditRows.data} />
            <p className="setting-hint">
              当前按钮只处理本地可访问的数据源：对话导出/清除覆盖持久化对话快照和旧 localStorage 对话键；设置导入/导出只覆盖 Synapse 设置键，不包含 Electron 数据库、用户目录文件或完整备份。
            </p>
            <div className="setting-item">
              <label>导出全部对话</label>
              <button className="settings-btn" onClick={exportConversations}>
                📥 导出为 JSON
              </button>
            </div>
            <div className="setting-item">
              <label>清除对话历史</label>
              <button className="settings-btn danger" onClick={clearConversationHistory}>
                🗑 清除
              </button>
            </div>
            <div className="setting-item">
              <label>存储使用量</label>
              <div className="storage-usage-breakdown">
                <strong>localStorage {formatBytes(storageUsage.localStorageBytes)}</strong>
                <span>
                  浏览器估算 {formatStorageEstimate(storageUsage)}
                </span>
                <small>{storageUsage.source} · {new Date(storageUsage.measuredAt).toLocaleTimeString()}</small>
              </div>
              <button
                className="settings-btn compact"
                type="button"
                disabled={loadingStorageUsage}
                onClick={() => void refreshStorageUsage()}
              >
                {loadingStorageUsage ? '刷新中' : '刷新'}
              </button>
            </div>
            <div className="setting-item">
              <label>清除缓存</label>
              <button className="settings-btn" onClick={clearCache}>
                🧹 清理
              </button>
              <p className="setting-hint">仅清理 localStorage 中的 Synopsis / temp / tmp 缓存键；Electron 文件缓存与数据库缓存暂列待确认扩展。</p>
            </div>
            <div className="settings-subsection-title">设置导入导出</div>
            <div className="setting-item">
              <label>导出设置</label>
              <button className="settings-btn" onClick={exportSettings}>
                📤 导出
              </button>
              <p className="setting-hint">导出格式为 `synapse-settings.json`，内容来自当前 localStorage 中可识别的设置键。</p>
            </div>
            <div className="setting-item">
              <label>导入设置</label>
              <button className="settings-btn" onClick={() => settingsImportRef.current?.click()}>
                📥 导入
              </button>
              <p className="setting-hint">只导入 JSON 中可识别的 Synapse 设置键；不会覆盖对话记录、文件、数据库或插件目录。</p>
              <input
                ref={settingsImportRef}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={e => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void importSettings(file);
                }}
              />
            </div>
          </div>
        )}

        {activeTab === 'about' && (
          <div className="settings-section about-card">
            <span style={{ fontSize: 48 }}>🧠</span>
            <h2>Synapse</h2>
            <p>AI 驱动的交互式学习平台</p>
            <p className="about-version">v0.1.0 (Preview)</p>
            <SettingsAuditMatrix rows={settingAuditRows.about} />
            <div className="about-details">
              <div><span>运行模式</span><strong>{platformInfo?.isElectron ? 'Electron' : 'Web'}</strong></div>
              <div><span>平台</span><strong>{platformInfo?.platform ?? (isElectron ? 'electron' : 'web')}</strong></div>
              <div><span>版本</span><strong>{platformInfo?.version ?? '0.1.0'}</strong></div>
              <div><span>用户数据目录</span><strong>{platformInfo?.userDataPath ?? (isElectron ? '读取中' : '/virtual')}</strong></div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PluginItem({
  name,
  description,
  status,
  source,
  sourceType,
  icon,
  statusTone = 'muted',
  actionLabel,
  actionDisabled,
  onAction,
}: PluginEntry & {
  statusTone?: 'ok' | 'warn' | 'danger' | 'muted';
  actionLabel?: string;
  actionDisabled?: boolean;
  onAction?: () => void;
}) {
  return (
    <div className="plugin-item">
      <span className="plugin-icon">{icon}</span>
      <div className="plugin-info">
        <span className="plugin-name">{name}</span>
        <span className="plugin-description">{description}</span>
        <div className="plugin-meta">
          <span className={`plugin-status ${statusTone}`}>{status}</span>
          {sourceType && <span className="plugin-status muted">{sourceType}</span>}
          <span className="plugin-source">{source}</span>
        </div>
      </div>
      {actionLabel && (
        <button className="settings-btn plugin-action" type="button" disabled={actionDisabled} onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function SettingsAuditMatrix({ rows }: { rows: SettingAuditRow[] }) {
  return (
    <div className="settings-audit-matrix">
      <div className="settings-audit-header">
        <span>设置项</span>
        <span>状态</span>
        <span>持久化</span>
        <span>实际生效</span>
        <span>验证方式</span>
      </div>
      {rows.map(row => (
        <div className="settings-audit-row" key={row.item}>
          <span className="settings-audit-item">{row.item}</span>
          <span className={`settings-audit-status ${auditStatusClass(row.status)}`}>{row.status}</span>
          <span>{row.persistence}</span>
          <span>{row.effect}</span>
          <span>{row.verify}</span>
        </div>
      ))}
    </div>
  );
}

function auditStatusClass(status: SettingAuditStatus) {
  if (status === '已实装') return 'ok';
  if (status === '部分实装') return 'warn';
  if (status === '待确认扩展') return 'muted';
  return 'danger';
}

function getMcpStatus(server?: McpServerInfo): { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' } {
  if (!server) return { label: '未配置', tone: 'muted' };
  const raw = String(server.status ?? '').toLowerCase();
  if (server.enabled === false || raw === 'disabled') return { label: '已禁用', tone: 'muted' };
  if (server.running || raw === 'running' || raw.includes('run') || raw.includes('运行')) {
    return { label: '运行中', tone: 'ok' };
  }
  if (raw.includes('start') || raw.includes('启动')) {
    return { label: '启动中', tone: 'warn' };
  }
  if (raw.includes('stop') || raw.includes('exit') || raw.includes('停止')) {
    return { label: server.configured ? '已配置，未启动' : '已停止', tone: 'warn' };
  }
  return { label: server.status || '状态未知', tone: 'muted' };
}

function clampNumber(value: string, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function formatAgentCount(count: number) {
  if (count <= 1) return '仅主';
  return `主+${count - 1}子`;
}

function calculateLocalStorageBytes() {
  let bytes = 0;
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i) ?? '';
    const value = localStorage.getItem(key) ?? '';
    bytes += new Blob([key, value]).size;
  }
  return bytes;
}

function calculateStorageUsageSync(): StorageUsageSnapshot {
  return {
    localStorageBytes: calculateLocalStorageBytes(),
    source: 'localStorage 同步统计',
    measuredAt: Date.now(),
  };
}

async function calculateStorageUsage(): Promise<StorageUsageSnapshot> {
  const localStorageBytes = calculateLocalStorageBytes();
  if (!navigator.storage?.estimate) {
    return {
      localStorageBytes,
      source: 'localStorage；当前运行环境不支持 navigator.storage.estimate',
      measuredAt: Date.now(),
    };
  }
  const estimate = await navigator.storage.estimate();
  return {
    localStorageBytes,
    browserUsageBytes: estimate.usage,
    browserQuotaBytes: estimate.quota,
    source: 'localStorage + 浏览器存储估算',
    measuredAt: Date.now(),
  };
}

function formatStorageEstimate(usage: StorageUsageSnapshot) {
  if (typeof usage.browserUsageBytes !== 'number') return '不可用';
  if (typeof usage.browserQuotaBytes !== 'number' || usage.browserQuotaBytes <= 0) {
    return formatBytes(usage.browserUsageBytes);
  }
  return `${formatBytes(usage.browserUsageBytes)} / ${formatBytes(usage.browserQuotaBytes)}`;
}

function collectLocalStorage(predicate: (key: string) => boolean) {
  const result: Record<string, unknown> = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !predicate(key)) continue;
    result[key] = parseStorageValue(localStorage.getItem(key) ?? '');
  }
  return result;
}

function removeLocalStorage(predicate: (key: string) => boolean) {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && predicate(key)) keys.push(key);
  }
  keys.forEach(key => localStorage.removeItem(key));
  return keys.length;
}

function isConversationStorageKey(key: string) {
  return key.startsWith('synapse:conversation:')
    || key === 'synapse_conversations'
    || key === 'synapse_autosave'
    || key === 'synapse_conversation_history';
}

function isCacheStorageKey(key: string) {
  return key.startsWith('synapse:synopsis:')
    || key.startsWith('synapse:temp:')
    || key.startsWith('synapse:tmp:')
    || key.startsWith('synapse_temp')
    || key.includes(':cache:');
}

function isSettingsStorageKey(key: string) {
  return key.startsWith('synapse:config:')
    || [
      'synapse:background',
      'synapse:synopsis',
      'synapse:multi-ai',
      'synapse_settings',
      'synapse_theme',
      'synapse_agent_settings',
      'synapse_multi_ai',
    ].includes(key);
}

function parseStorageValue(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function serializeStorageValue(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function sanitizeSettingsExport(settingsDump: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settingsDump)) {
    result[key] = sanitizeWallpaperData(value);
  }
  return result;
}

function sanitizeWallpaperData(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('data:image/')) {
      return '[wallpaper-data-url-omitted]';
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitizeWallpaperData);
  if (!value || typeof value !== 'object') return value;
  const next: Record<string, unknown> = {};
  for (const [key, itemValue] of Object.entries(value as Record<string, unknown>)) {
    next[key] = sanitizeWallpaperData(itemValue);
  }
  return next;
}

function readImageAsDataUrl(file: File, index: number) {
  return new Promise<WallpaperImage>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      resolve({
        id: `web-${Date.now()}-${index}`,
        name: file.name || `壁纸 ${index + 1}`,
        kind: 'dataUrl',
        url,
        mime: file.type || 'image/*',
        size: file.size,
        addedAt: Date.now(),
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function isManagedWallpaper(item: unknown): item is WallpaperImage {
  return Boolean(item && typeof item === 'object' && (item as WallpaperImage).kind === 'managed' && (item as WallpaperImage).relativePath);
}

function ToggleItem({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="setting-item">
      <label>{label}</label>
      <label className="toggle-switch">
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
        <span className="toggle-slider" />
      </label>
    </div>
  );
}

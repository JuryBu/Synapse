import { SendHorizontal, Sparkles, Zap, StopCircle, Plus, Download, PanelRightClose } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import {
  setCurrentModel,
  setMaxTokens,
  setMode,
  setOutputStrategy,
  setPseudoStreamSpeed,
  setReasoningEffort,
  setShowGeneratingPlaceholder,
  setShowStreamCursor,
  setShowThinking,
  setSpeedTier,
  setStreamThinking,
  setTemperature,
  setTopP,
} from '@/store/slices/agentSettings';
import { toggleAgentPanel } from '@/store/slices/layout';
import { MessageBubble } from '@/components/chat/MessageBubble';
import { useState, useCallback, useRef, useEffect, useMemo, Fragment } from 'react';
import { AIClient } from '@/services/aiClient';
import { AgentLoop } from '@/services/agentLoop';
import { toolRegistry } from '@/services/toolRegistry';
import { addNotification } from '@/store/slices/notifications';
import { addMessage, clearConversation, editMessage, truncateAt, deleteMessage, setConversation, setModel as setConversationModel, setStreaming, updateDiffStatus, updateMessage, updateMessageMeta, type AttachmentRef, type MessageContentPart } from '@/store/slices/conversation';
// ★ M3-2b：@MultiAI:模式名 触发固定工作流（解析 + 跑 runWorkflow + 汇总文本），见 services/multiAITrigger.ts。
// ★ M3-3a：generateWorkflowRunId 预生成稳定 runId，跑前先建占位 assistant 消息 + 关联卡片实时显示。
import { parseMultiAITrigger, runMultiAITrigger, generateWorkflowRunId } from '@/services/multiAITrigger';
// ★ M3-2b 修复：工作流走 agentOrchestrator（非 agentLoop），handleStop 需直接调 abortAll() 才能真正中止工作流。
import { agentOrchestrator } from '@/services/agentOrchestrator';
import { exitWorktree } from '@/store/slices/worktreeSession';
import { countConversationTokens } from '@/services/systemPrompt';
import { getModelContextWindowForOption } from '@/store/selectors/modelSelectors';
import { conversationExporter } from '@/services/conversationExporter';
import { clearAutosaveSnapshot, loadAutosaveSnapshot, saveAutosaveSnapshot, saveConversationSnapshot, migrateSnapshotAttachments, branchConversation, beginConversationSwitch, endConversationSwitch, AUTOSAVE_ID } from '@/services/conversationPersistence';
import { platform } from '@/platform';
import { releaseMessageAttachments, resolveAttachmentDataUrl, sanitizeMessagesForPersistence } from '@/services/attachmentRefs';
import { setSelectedId, updateConversation } from '@/store/slices/conversationHistory';
import { openTab } from '@/store/slices/editorTabs';
import type { RootState } from '@/store';
import { rollbackFileDiff } from '@/services/fileRollback';
import { describeCapabilities } from '@/services/modelCapabilities';
import { getRecord, clampToBatch } from '@/services/recordStore';

const MAX_IMAGE_PAYLOAD_BYTES = 8 * 1024 * 1024;

function generateAttachmentId(): string {
  return `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ★ M3-2b：@MultiAI 工作流分支用的消息 id 生成器（与 agentLoop 的 msg_ 前缀口径一致，供 user/assistant 汇总消息使用）。
function generateMessageId(prefix = 'msg'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatBytes(bytes?: number): string {
  if (!bytes) return '0 B';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function getAttachmentKind(file: File): AttachmentRef['kind'] {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('text/') || /\.(md|txt|json|csv|ts|tsx|js|jsx|py|java|cpp|c|h)$/i.test(file.name)) return 'text';
  if (/\.(pdf|docx?|pptx?|xlsx?)$/i.test(file.name)) return 'document';
  if (/\.(zip|rar|7z|tar|gz)$/i.test(file.name)) return 'archive';
  return 'other';
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('读取附件失败'));
    reader.readAsDataURL(file);
  });
}

export function AgentPanel() {
  const dispatch = useAppDispatch();
  const mode = useAppSelector((s: RootState) => (s as any).agentSettings.mode);
  const model = useAppSelector((s: RootState) => (s as any).agentSettings.currentModel);
  const conversation = useAppSelector((s: RootState) => (s as any).conversation);
  const messages = conversation.messages;
  // 持有最新 conversation 供异步回调（如懒迁移 onMigrated）安全校验当前对话身份/消息数，不被 effect 闭包旧值误导。
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  // ★ M3-2b 修复（high）：标记当前是否在跑 @MultiAI 工作流（走 agentOrchestrator 而非 agentLoop）。
  //   runWorkflowFromInput 进入置 true / finally 置 false；handleStop 据此分流到 agentOrchestrator.abortAll()。
  const isWorkflowRunningRef = useRef(false);
  const isStreaming = useAppSelector((s: RootState) => (s as any).conversation.isStreaming);
  const settings = useAppSelector((s: RootState) => (s as any).settings);
  const agentSettings = useAppSelector((s: RootState) => (s as any).agentSettings);
  // M2-6：handleBranch 等异步回调（useCallback 依赖窄）需读当前 mode / reasoningEffort 落库，
  //   用 ref 持有最新值避免闭包旧值，且无需把这两项塞进回调依赖数组。
  const agentMetaRef = useRef({ mode, reasoningEffort: agentSettings.reasoningEffort as string });
  agentMetaRef.current = { mode, reasoningEffort: agentSettings.reasoningEffort };
  const apiTokenCount = useAppSelector((s: RootState) => s.conversation.tokenCount);
  const [input, setInput] = useState('');
  const [activeAgentTab, setActiveAgentTab] = useState<'chat' | 'plan' | 'context'>('chat');
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!modelMenuOpen) return;
    const handleDocMouseDown = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleDocMouseDown);
    return () => document.removeEventListener('mousedown', handleDocMouseDown);
  }, [modelMenuOpen]);
  const [modelSearch, setModelSearch] = useState('');
  // M2-R1: 读取当前对话 record 各批次的 stepEnd（不含 tool 口径），用于在消息流按批次标出
  // 多条「压缩点」分隔线（展示仍完整原文）。空 record 时为空数组。
  // 问题1：新对话 id 为 null 时回退 AUTOSAVE_ID（autosave 落盘用同一 id），让 record 分隔线/回溯也对新对话生效。
  const conversationId = (conversation.id as string | null) || AUTOSAVE_ID;
  const [recordBatchStepEnds, setRecordBatchStepEnds] = useState<number[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!conversationId) { setRecordBatchStepEnds([]); return; }
    void getRecord(conversationId).then(rec => {
      if (cancelled) return;
      const ends = (rec?.batches ?? [])
        .map(b => b.stepEnd)
        .filter(s => s > 0);
      setRecordBatchStepEnds(ends);
    });
    return () => { cancelled = true; };
  }, [conversationId, messages.length]);

  // 把各批 stepEnd（不含 tool 计数）映射到含-tool 的真实 messages 下标：
  // 分隔线画在「该批最后一条非-tool 消息」之后。返回 Map<messageIdx, [批序号...]>。
  const batchDividerByIdx = useMemo(() => {
    const map = new Map<number, number[]>();
    if (recordBatchStepEnds.length === 0) return map;
    const endSet = new Map<number, number[]>(); // stepEnd -> 批序号列表
    recordBatchStepEnds.forEach((end, i) => {
      const arr = endSet.get(end) ?? [];
      arr.push(i);
      endSet.set(end, arr);
    });
    let eligibleCount = 0;
    for (let idx = 0; idx < messages.length; idx++) {
      if ((messages[idx] as any).role === 'tool') continue;
      eligibleCount += 1;
      const hit = endSet.get(eligibleCount);
      if (hit) {
        // 分隔线挂在「下一条消息之前」，即该批最后一条非-tool 消息的下一个下标。
        const dividerIdx = idx + 1;
        const existing = map.get(dividerIdx) ?? [];
        map.set(dividerIdx, [...existing, ...hit]);
      }
    }
    return map;
  }, [recordBatchStepEnds, messages]);
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentRef[]>([]);
  const [previewAttachment, setPreviewAttachment] = useState<AttachmentRef | null>(null);
  // M2-R6 渲染还原：历史消息的 image 附件落库后只有 sha256（无 previewUrl base64），
  // 按 sha256 懒加载还原成 dataUrl 供 MessageBubble 渲染。Map<sha256, dataUrl>。
  const [resolvedPreviews, setResolvedPreviews] = useState<Map<string, string>>(new Map());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const agentLoopRef = useRef<AgentLoop | null>(null);
  const hasApiKey = !!settings.apiKeys?.openai;
  const hasModel = !!model;
  const availableModels = useMemo(() => agentSettings.availableModels ?? [], [agentSettings.availableModels]);
  const currentModelOption = useMemo(
    () => availableModels.find((m: any) => m.id === model),
    [availableModels, model],
  );
  const currentCapabilities = currentModelOption?.capabilities;
  const capabilityLabels = useMemo(() => describeCapabilities(currentCapabilities), [currentCapabilities]);
  const reasoningOptions = currentCapabilities?.reasoning
    ? (currentCapabilities.reasoningEffortOptions?.length
      ? currentCapabilities.reasoningEffortOptions
      : ['auto', 'low', 'medium', 'high', 'xhigh'])
    : ['auto'];
  const speedOptions = currentCapabilities?.speedTierOptions?.length
    ? currentCapabilities.speedTierOptions
    : ['auto'];
  const supportedParameters = currentCapabilities?.supportedParameters ?? [];
  const supportsTemperature = supportedParameters.length === 0 || supportedParameters.includes('temperature');
  const supportsTopP = supportedParameters.length === 0 || supportedParameters.includes('top_p');
  const supportsMaxTokens = supportedParameters.length === 0 || supportedParameters.includes('max_tokens');

  // Build AIClient from current settings
  const aiClient = useMemo(() => {
    const apiKey = settings.apiKeys?.openai || '';
    const baseUrl = settings.apiEndpoints?.openai || 'https://openrouter.ai/api/v1';
    if (!apiKey || !model) return null;
    return new AIClient({
      apiKey,
      baseUrl,
      model,
      temperature: agentSettings.temperature ?? 0.7,
      topP: agentSettings.topP ?? 1,
      maxTokens: agentSettings.maxTokens ?? 4096,
      stream: currentCapabilities?.streaming ?? true,
      outputStrategy: agentSettings.outputStrategy ?? ((agentSettings.enableStreaming ?? true) ? 'auto' : 'off'),
      pseudoStreamSpeed: agentSettings.pseudoStreamSpeed ?? 'medium',
      showStreamCursor: agentSettings.showStreamCursor ?? true,
      showGeneratingPlaceholder: agentSettings.showGeneratingPlaceholder ?? true,
      streamThinking: agentSettings.streamThinking ?? true,
      reasoningEffort: currentCapabilities?.reasoning ? agentSettings.reasoningEffort : 'auto',
      speedTier: currentCapabilities?.speedTierOptions?.includes(agentSettings.speedTier) ? agentSettings.speedTier : 'auto',
    });
  }, [
    settings.apiKeys?.openai,
    settings.apiEndpoints?.openai,
    model,
    agentSettings.temperature,
    agentSettings.topP,
    agentSettings.maxTokens,
    agentSettings.enableStreaming,
    agentSettings.outputStrategy,
    agentSettings.pseudoStreamSpeed,
    agentSettings.showStreamCursor,
    agentSettings.showGeneratingPlaceholder,
    agentSettings.streamThinking,
    agentSettings.reasoningEffort,
    agentSettings.speedTier,
    currentCapabilities,
  ]);

  // Build AgentLoop + P1-3: 接入工具审批
  useEffect(() => {
    if (!aiClient) {
      agentLoopRef.current = null;
      return;
    }
    const loop = new AgentLoop(aiClient);
    loop.registerTools(
      toolRegistry.getSchemas() as any[],
      // M2-5：透传 agentLoop 注入的 contextId，让 worktree 工具按本上下文定位活动 worktree（并行不串台）。
      (name, args, contextId) => toolRegistry.execute(name, args, contextId),
    );
    // P1-3: 设置审批回调（弹出确认对话框）
    // ★ M3-1a medium#4：meta 携带子代理来源标识——后台子代理调用 write/command 级工具弹审批时，
    //   文案前缀「子代理「角色」请求…」，让用户分清是主代理还是哪个子代理发起（旧文案只说「AI 请求」无法区分）。
    toolRegistry.setApprovalCallback(async (toolName, args, level, meta) => {
      const origin = meta?.isSubagent
        ? `子代理「${meta.subagentRole || '未命名'}」`
        : 'AI';
      // ★ medium#5：worktree 创建是真实 git 写盘 + 建新分支，通用「执行工具」文案会让用户误以为是无害模式切换。
      //   给 enter_worktree 定制说明，明确「会在磁盘建工作树目录 + git 里新建/复用分支」，降低误批风险。
      if (toolName === 'enter_worktree') {
        const branch = typeof args?.branch === 'string' && args.branch.trim() ? args.branch.trim() : '（自动生成时间戳分支）';
        const msg = `${origin}请求进入 git worktree（隔离工作树）\n\n这会在磁盘 userData/worktrees 下创建一个工作树目录，并在当前仓库新建（或复用已有）分支：\n  分支：${branch}\n\n进入后 AI 的文件读写/命令将作用于该工作树（与主工作区隔离），而非直接改主工作区。是否同意？`;
        return window.confirm(msg);
      }
      const msg = `${origin}请求执行工具 "${toolName}"（权限: ${level}）\n参数: ${JSON.stringify(args, null, 2).slice(0, 200)}`;
      return window.confirm(msg);
    });
    // P1-3: 同步安全设置
    const safety = settings.safety;
    if (safety) {
      toolRegistry.updateAutoApprove({
        read: safety.autoApproveRead ?? true,
        write: safety.autoApproveWrite ?? false,
        command: safety.autoApproveCommand ?? false,
        all: safety.autoApproveAll ?? false,
      });
    }
    agentLoopRef.current = loop;
    return () => { loop.stop(); };
  }, [aiClient, settings.safety]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const focusInput = (event: Event) => {
      const detail = (event as CustomEvent<string | undefined>).detail;
      if (detail) setInput(detail);
      inputRef.current?.focus();
      setActiveAgentTab('chat');
    };
    window.addEventListener('synapse:focus-agent-input', focusInput);
    return () => window.removeEventListener('synapse:focus-agent-input', focusInput);
  }, []);

  // Auto-save conversation to the active persistence backend.
  // ★ M2-6：本 effect 同时承担「对话级 mode / reasoningEffort 持久化」职责——
  //   id 为真实对话 id 时 saveAutosaveSnapshot 直接 update 该对话行，id 为空/autosave 时落 AUTOSAVE_ID 行。
  //   故 mode/reasoningEffort 切换 UI 处只需 dispatch 改全局 agentSettings，本 effect（依赖含这两项）会去重落库，
  //   无需在每个切换按钮里手写持久化。切走前 ConversationList.saveCurrentToHistory 再兜一道（debounce 未触发也不丢）。
  useEffect(() => {
    if (messages.length === 0 || isStreaming) return;
    // effect 闭包捕获触发时刻的对话身份（A 的 id），供 700ms 后到点时与 store 最新身份比对。
    const scopedId = conversation.id;
    const timeout = window.setTimeout(() => {
      // ★ M2-6 切换竞态守卫：切走对话期间（ConversationList.handleSwitchConversation 异步多 await），
      //   本 effect 的旧定时器可能在 cleanup 之前到点。若此刻 store 已切到别的对话（conversationRef.current.id
      //   ≠ 本次闭包的 scopedId），这就是一条「属于已切走对话的迟到写入」——直接跳过，避免：
      //   ① saveCurrentToHistory 已把 autosave fork 成真实 id 并 clearAutosaveSnapshot 后，
      //      这条迟到 debounce 又用 id=null/AUTOSAVE_ID 重建一条 autosave 草稿（复活已 fork 的对话），
      //      导致下次启动 loadAutosaveSnapshot 把复活草稿连同其 mode 当成上次对话恢复、mode 归属错乱。
      const liveId = (conversationRef.current.id as string | null);
      if (liveId !== (scopedId as string | null)) return;
      void saveAutosaveSnapshot({
        id: conversation.id,
        title: conversation.title,
        messages,
        model,
        // M2-6：autosave 也带当前 mode / reasoningEffort，刷新/重启从 autosave 恢复时能拿回设置。
        mode,
        reasoningEffort: agentSettings.reasoningEffort,
        assistantRuns: conversation.assistantRuns,
        fileSnapshots: conversation.fileSnapshots,
        pendingDiffs: conversation.pendingDiffs,
        timestamp: Date.now(),
      }).catch(() => {
        try {
          // M2-R6：兜底 localStorage 写入同样过 sanitize，杜绝 base64 经退化路径漏进存储。
          localStorage.setItem('synapse_autosave', JSON.stringify({
            messages: sanitizeMessagesForPersistence(messages),
            model,
            timestamp: Date.now(),
          }));
        } catch { /* quota exceeded — silently skip */ }
      });
    }, 700);
    return () => window.clearTimeout(timeout);
  }, [
    messages,
    model,
    // M2-6：mode / reasoningEffort 变化也要重新落 autosave 行，保证刷新恢复拿到最新设置。
    mode,
    agentSettings.reasoningEffort,
    isStreaming,
    conversation.id,
    conversation.title,
    conversation.assistantRuns,
    conversation.fileSnapshots,
    conversation.pendingDiffs,
  ]);

  // Restore from autosave on mount
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await loadAutosaveSnapshot();
        const restoredMessages = data?.messages ?? [];
        if (!cancelled && restoredMessages.length > 0 && messages.length === 0) {
          dispatch(setConversation({
            id: data?.id || 'autosave-current',
            title: data?.title || '自动保存',
            messages: restoredMessages,
            assistantRuns: data?.assistantRuns,
            fileSnapshots: data?.fileSnapshots,
            pendingDiffs: data?.pendingDiffs,
            // M2-3：恢复对话也回填分支溯源（autosave 行的 parent 字段，普通对话为 null）。
            parentId: data?.parentId ?? null,
            branchedFromMessageId: data?.branchedFromMessageId ?? null,
          }));
          // M2-6：恢复对话时同步其 mode / reasoningEffort 到全局 agentSettings（旧 autosave 无此字段则回退默认）。
          dispatch(setMode(data?.mode === 'fast' ? 'fast' : 'planning'));
          dispatch(setReasoningEffort(data?.reasoningEffort || 'auto'));
          dispatch(addNotification({ type: 'info', title: '已恢复', message: '已恢复上次对话', duration: 2000 }));
          // ★ M2-R6 懒迁移：后台把旧内联 base64 抽离成 sha256 引用并回写 DB（用到才迁、不阻塞渲染）。
          // 首屏仍用内联 base64 渲染（能显示）；迁移确有变更时通过 onMigrated 把引用态写回 store，
          // 杜绝 store 残留 base64 被后续 autosave 反复落库。回写前严格校验对话身份未变且消息未追加，避免覆盖新消息。
          if (data) {
            const restoredId = data.id || 'autosave-current';
            const restoredLen = restoredMessages.length;
            void migrateSnapshotAttachments(data, (migratedId, migratedMessages) => {
              if (cancelled) return;
              const cur = conversationRef.current;
              if (!cur || cur.isStreaming) return;
              const curId = (cur.id as string | null) || 'autosave-current';
              // 仅当仍是同一对话、且消息数量未变（未追加/未截断新消息）时安全替换为引用态。
              if (curId === (migratedId === AUTOSAVE_ID ? restoredId : migratedId) && curId === restoredId
                  && cur.messages.length === restoredLen) {
                dispatch(setConversation({
                  id: restoredId,
                  title: cur.title,
                  messages: migratedMessages,
                  assistantRuns: cur.assistantRuns,
                  fileSnapshots: cur.fileSnapshots,
                  pendingDiffs: cur.pendingDiffs,
                  model: cur.model,
                }));
              }
            }).catch(() => undefined);
          }
        }
      } catch { /* corrupted — skip */ }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // M2-6：顶栏「新建对话」入口。与 ConversationList.handleNewConversation 口径单一：
  //   先把当前对话的 mode / reasoningEffort 随对话落库（saveConversationSnapshot），
  //   再【条件清】autosave——仅当确实发生 autosave→真实 id 的 fork（summary.id 非 AUTOSAVE_ID）才
  //   clearAutosaveSnapshot()，避免「当前对话是真实 id」场景下无条件 delete(AUTOSAVE_ID) 误删并存草稿镜像。
  //   读 conversationRef / agentMetaRef 的 current 取最新值，杜绝 700ms debounce 未触发时按钮拿到旧 mode。
  const handleNewConversation = useCallback(async () => {
    // ★ M2-6 切换竞态：置闸覆盖 save(可能 fork+clearAutosave) → clearConversation/重置 整段窗口，
    //   挡住旧对话迟到 autosave debounce 复活 AUTOSAVE_ID 草稿（与 ConversationList 两入口口径一致）。finally 复位。
    beginConversationSwitch();
    // ★ M2-5 worktree 止血：新建对话即回主工作区——清掉【离开的对话】+ AUTOSAVE_ID 的活动 worktree 条目，
    //   防新对话（共用 AUTOSAVE_ID contextId）继承上一条 autosave 对话的 worktree 重定向（串台）。
    {
      const leavingContextId = (conversationRef.current.id as string | null) || AUTOSAVE_ID;
      dispatch(exitWorktree({ contextId: leavingContextId }));
      dispatch(exitWorktree({ contextId: AUTOSAVE_ID }));
    }
    try {
      const cur = conversationRef.current;
      if ((cur.messages?.length ?? 0) > 0) {
        // fork 判据与 ConversationList.saveCurrentToHistory 一致：当前是 autosave / 无 id 时 save 会 fork 成新 id。
        const wasAutosave = !cur.id || cur.id === AUTOSAVE_ID;
        try {
          const summary = await saveConversationSnapshot({
            id: cur.id,
            title: cur.title,
            messages: cur.messages,
            model: cur.model,
            // M2-6：新建前把当前对话的 mode / reasoningEffort 随对话落库，切回时能恢复。
            mode: agentMetaRef.current.mode,
            reasoningEffort: agentMetaRef.current.reasoningEffort,
            assistantRuns: cur.assistantRuns,
            fileSnapshots: cur.fileSnapshots,
            pendingDiffs: cur.pendingDiffs,
            timestamp: Date.now(),
          });
          if (summary) {
            dispatch(updateConversation(summary));
            // M2-R6：此处【不】GC 附件——save 已把这批消息（含 sha256 引用）落到新对话 id，实体仍被新对话引用
            //   （refCount 不变、归属转移）；clearAutosaveSnapshot 走 conversation.delete(AUTOSAVE_ID)（不 release）。
            //   故 refCount 守恒。仅在确实 fork 出真实 id 时清 autosave 镜像（条件清，与 ConversationList 对齐），
            //   真实对话场景不再无条件 delete(AUTOSAVE_ID)，避免误删并存的真草稿镜像。
            if (wasAutosave && summary.id && summary.id !== AUTOSAVE_ID) {
              await clearAutosaveSnapshot();
            }
          }
        } catch {
          dispatch(addNotification({ type: 'warning', title: '自动保存失败', message: '当前对话保存失败，但仍会创建新对话' }));
        }
      }
      dispatch(clearConversation());
      // M2-6：新对话回默认设置（mode=planning / reasoningEffort=auto）。先落定旧对话设置再重置。
      dispatch(setMode('planning'));
      dispatch(setReasoningEffort('auto'));
      dispatch(setSelectedId(null));
      dispatch(addNotification({ type: 'info', title: '新对话', message: '已创建新对话' }));
    } finally {
      endConversationSwitch();
    }
  }, [dispatch]);

  const buildUserContentParts = useCallback((text: string, attachments: AttachmentRef[]): MessageContentPart[] => {
    const parts: MessageContentPart[] = [];
    if (text) parts.push({ type: 'text', text });
    for (const attachment of attachments) {
      if (attachment.status !== 'ready') continue;
      // M2-R6：image part 以 sha256 引用 + 元数据(size/mime/name) 落库/发送；
      // url 仅填内存态预览(previewUrl)，发送前 agentLoop 按 sha256 还原成真 base64，落库前被 sanitize 清掉。
      if (attachment.kind === 'image' && attachment.sha256) {
        parts.push({
          type: 'image_url',
          image_url: { url: attachment.previewUrl || '', detail: 'auto' },
          attachmentId: attachment.id,
          sha256: attachment.sha256,
          size: attachment.size,
          mime: attachment.mimeType,
          name: attachment.name,
        });
      }
    }
    return parts;
  }, []);

  // ★ M3-2b：@MultiAI:模式名 触发固定工作流。
  //   - 用户那条输入【照常】作为 user 消息插入对话（用户能看到自己发了什么），随后走 runWorkflow 而非普通 agentLoop.run。
  //   - 跑期间用 setStreaming(true) 占位（复用既有「流式中」语义防止重复发送 / 禁用输入），完成后插一条 assistant 汇总消息。
  //   - 工作流自身的进度/错误已由 agentOrchestrator 内部 addNotification 反馈；这里只负责对话消息的 user/assistant 落位。
  //   TODO(M3-3)：assistant 汇总目前是结构化文本；M3-3 会替换/增强为工作流卡片（节点四色 + 子代理树 + 点进子对话）。
  const runWorkflowFromInput = useCallback(async (rawText: string) => {
    // ★ M3-2b 修复（medium 串台）：捕获触发时刻的对话身份。runWorkflow 可能耗时数十分钟，
    //   期间用户可能切走对话（ConversationList 双击不设防）。await 解析后回填 assistant/error 消息前
    //   比对 conversationRef.current.id === scopedId，不一致则改走 notification、不污染当前（已切走的别的）对话 slice。
    //   与 autosave 既有迟到守卫（见上方 effect scopedId/liveId 比对）同款思路。
    const scopedId = (conversationRef.current.id as string | null);
    const isStillScoped = () => (conversationRef.current.id as string | null) === scopedId;

    // 1. 用户输入照常入对话流（与普通发送一致，让用户看到自己发了什么）。同步 dispatch，必在当前对话。
    dispatch(addMessage({
      id: generateMessageId('user'),
      role: 'user',
      content: rawText,
      timestamp: Date.now(),
    }));

    // ★ M3-3a：跑前先预生成 runId + 占位 assistant 消息（带 workflowRunId），让【工作流卡片在启动瞬间即出现】
    //   并随子代理状态实时四色刷新，而非等整个工作流跑完才显示。triggerMessageId = 该 assistant 消息 id，
    //   使 runWorkflow 建立的运行实例关联到这条消息（WorkflowCard 渲染锚点）。
    const runId = generateWorkflowRunId();
    const assistantMsgId = generateMessageId('assistant');
    dispatch(addMessage({
      id: assistantMsgId,
      role: 'assistant',
      content: '', // 跑完回填文本汇总（作为卡片下方可折叠 fallback）
      model: 'Multi-AI 工作流',
      timestamp: Date.now(),
      workflowRunId: runId,
    }));

    // 2. 置流式占位，期间禁用再次发送（runWorkflow 可能耗时较长）。
    //    isWorkflowRunningRef 让 handleStop 知道现在该 abort 工作流而非 agentLoop。
    isWorkflowRunningRef.current = true;
    dispatch(setStreaming(true));
    try {
      const outcome = await runMultiAITrigger(rawText, { runId, triggerMessageId: assistantMsgId });
      if (outcome.kind === 'error') {
        // 匹配失败（无此模式 / 该模式无 workflow）→ 友好提示，不静默吞。
        //   此时 runWorkflow 未被调用、卡片运行实例不存在（WorkflowCard 自然返回 null），
        //   把占位消息回填为错误说明文本即可（去掉 workflowRunId，纯文本展示）。
        dispatch(addNotification({
          type: 'warning',
          title: '无法触发工作流',
          message: outcome.message,
        }));
        if (isStillScoped()) {
          dispatch(updateMessage({ id: assistantMsgId, content: `⚠️ ${outcome.message}` }));
          dispatch(updateMessageMeta({ id: assistantMsgId, changes: { workflowRunId: undefined } }));
        }
        return;
      }
      if (outcome.kind === 'ran') {
        // 3. 工作流跑完——把占位 assistant 消息回填为文本汇总（卡片仍由 workflowRunId 实时渲染）。
        //    迟到结果（已切走对话）→ updateMessage 在当前 slice 找不到该 id 自然 no-op，额外 notification 告知。
        if (isStillScoped()) {
          dispatch(updateMessage({ id: assistantMsgId, content: outcome.assistantText }));
        } else {
          dispatch(addNotification({
            type: 'info',
            title: '工作流已完成',
            message: '工作流已执行完成，但你已切换到其它对话，汇总未回填当前对话。',
          }));
        }
      }
    } catch (err: any) {
      dispatch(addNotification({
        type: 'error',
        title: '工作流执行失败',
        message: err?.message || '未知错误',
      }));
      // 同样守护：异常汇总只回填触发它的那条对话的占位消息。
      if (isStillScoped()) {
        dispatch(updateMessage({ id: assistantMsgId, content: `❌ 工作流执行失败：${err?.message || '未知错误'}` }));
      }
    } finally {
      isWorkflowRunningRef.current = false;
      dispatch(setStreaming(false));
    }
  }, [dispatch]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    const readyAttachments = pendingAttachments.filter(att => att.status === 'ready');
    if ((!text && readyAttachments.length === 0) || isStreaming) return;

    if (!hasApiKey) {
      dispatch(addNotification({
        type: 'warning',
        title: '未配置 API',
        message: '请先在设置 → AI 中配置 API Key 和端点',
      }));
      return;
    }

    if (!hasModel) {
      dispatch(addNotification({
        type: 'warning',
        title: '未选择模型',
        message: '请先在设置 → AI 中获取并选择模型',
      }));
      return;
    }

    if (!agentLoopRef.current) {
      dispatch(addNotification({
        type: 'warning',
        title: 'AI 未就绪',
        message: '请确认 API Key、端点和模型均已配置',
      }));
      return;
    }

    // ★ M3-2b：检测 @MultiAI:模式名 前缀 → 分流到固定工作流（不走普通 agentLoop.run）。
    //   parseMultiAITrigger 返回 null（非触发）时完全走下方原有发送链路，普通对话零改动。
    if (parseMultiAITrigger(text)) {
      setInput('');
      // ★ M3-2b 修复（medium refCount 泄漏）：工作流路径不把附件转交给任何消息（runWorkflow 只收 string），
      //   也不走 removePendingAttachment 的 GC。若直接 setPendingAttachments([]) 丢弃，带 sha256 的草稿图
      //   （addPendingFiles 已 platform.attachment.put → refCount=1）会变成孤儿实体，违反 M2-R6 refCount 守恒契约。
      //   故清空前对每个带 sha256 的草稿附件 release（复用 removePendingAttachment 同款逻辑）止血。
      //   注：用 pendingAttachments（含 ready 与非 ready），凡 put 过的（有 sha256）都要 release。
      for (const att of pendingAttachments) {
        if (att.sha256) void platform.attachment.delete(att.sha256).catch(() => undefined);
      }
      setPendingAttachments([]);
      setPreviewAttachment(null);
      void runWorkflowFromInput(text);
      return;
    }

    setInput('');
    setPendingAttachments([]);
    setPreviewAttachment(null);
    agentLoopRef.current.run(text, {
      contentParts: buildUserContentParts(text, readyAttachments),
      attachments: readyAttachments.map(att => ({ ...att, status: 'sent' as const })),
    }).catch((err: any) => {
      dispatch(addNotification({
        type: 'error',
        title: 'AI 请求失败',
        message: err.message || '未知错误',
      }));
    });
  }, [input, pendingAttachments, isStreaming, hasApiKey, hasModel, buildUserContentParts, runWorkflowFromInput, dispatch]);

  const handleStop = useCallback(() => {
    // ★ M3-2b 修复（high）：Stop 按钮要同时管「普通对话」与「@MultiAI 工作流」两条路。
    //   两条路共用同一个 isStreaming 闸门和同一个 Stop 控件，但工作流不由 agentLoop 驱动——
    //   它在 agentOrchestrator.runWorkflow 这条独立链路上跑（可长达 30 分钟、派发 60 个子代理）。
    //   - agentLoopRef.current?.stop()：停普通 agentLoop（工作流期间 agentLoop 未运行，是 no-op）。
    //   - agentOrchestrator.abortAll()：abort workflowAbortController（让 runWorkflow 在下个节点前 return aborted）
    //       + 杀在途子代理；无运行工作流时 abortAll 内部全是 optional-chain/空集合遍历，安全 no-op。
    //   abortAll 后 runWorkflow 返回 aborted 结果，照常走 outcome.kind==='ran' 插「无法推进」汇总，闭环正常。
    agentLoopRef.current?.stop();
    if (isWorkflowRunningRef.current) {
      agentOrchestrator.abortAll();
    }
  }, []);

  // Plan_4 M2-1：编辑/重试/回溯会截断后续消息。把 record 水位线 clamp 到保留范围（替代此前的整条删）：
  // 覆盖区在保留范围内则不动；否则 clamp totalRounds/totalSteps/lastUpdatedRound，保住 M 之前已生成的摘要、
  // 且保证后续增量压缩批次起点正确；clamp 后归零才删。record 是加速层，失败吞异常不阻塞主对话。
  const invalidateRecordForTruncation = useCallback((remainingMessages: any[]) => {
    const conversationId = conversation.id || AUTOSAVE_ID;
    const keptRounds = remainingMessages.filter((m: any) => m.role === 'user').length;
    // step 口径对齐 agentLoop：record.totalSteps 来自不含 tool 的 requestHistory
    const keptSteps = remainingMessages.filter((m: any) => m.role !== 'tool').length;
    // M2-R1：批次整体保留语义（穿过截断点的批及之后整批回退原文），替代旧数字 clamp。
    void clampToBatch(conversationId, keptRounds, keptSteps);
  }, [conversation.id]);

  // M2-R6 refCount GC：对被移除/被丢弃引用的消息，fire-and-forget release 其附件 sha256（归零删实体）。
  // 漏 release 只多占盘（不致命）；多 release 才危险，故只在「明确移除」处调用。
  const gcMessages = useCallback((removed: any[]) => {
    if (removed.length === 0) return;
    void releaseMessageAttachments(removed).catch(() => undefined);
  }, []);

  // Edit user message → truncate after it → re-send
  const handleEdit = useCallback((msgId: string, newContent: string) => {
    // 截断后剩余消息 = 该消息及之前（与 editMessage reducer 的 slice(0, idx+1) 对齐）
    const editIdx = messages.findIndex((m: any) => m.id === msgId);
    if (editIdx >= 0) {
      invalidateRecordForTruncation(messages.slice(0, editIdx + 1));
      // 被截断的后续消息整体移除 → GC；被编辑消息本身 editMessage 会把 contentParts 重置为纯文本（丢弃图引用）→ 也 GC。
      gcMessages([...messages.slice(editIdx + 1), messages[editIdx]]);
    }
    dispatch(editMessage({ id: msgId, content: newContent }));
    // Re-send edited message
    if (agentLoopRef.current) {
      setTimeout(() => {
        agentLoopRef.current?.run(newContent, { skipUserMessage: true }).catch((err: any) => {
          dispatch(addNotification({ type: 'error', title: 'AI 请求失败', message: err.message }));
        });
      }, 100);
    }
  }, [dispatch, messages, invalidateRecordForTruncation, gcMessages]);

  // Retry: delete last AI message → re-send last user message
  const handleRetry = useCallback((msgId: string) => {
    // truncateAt 保留到 msgId，随后 deleteMessage(msgId) 再删掉这条 AI 消息。
    const retryIdx = messages.findIndex((m: any) => m.id === msgId);
    if (retryIdx >= 0) {
      invalidateRecordForTruncation(messages.slice(0, retryIdx));
      // 被移除 = msgId 这条 AI 消息及其之后的所有消息（重试会重发上一条 user，故这些全丢）→ GC。
      gcMessages(messages.slice(retryIdx));
    }
    dispatch(truncateAt(msgId));
    // Find the previous user message to re-send
    const msgIdx = messages.findIndex((m: any) => m.id === msgId);
    if (msgIdx > 0) {
      const prevUserMsg = messages.slice(0, msgIdx).reverse().find((m: any) => m.role === 'user');
      if (prevUserMsg && agentLoopRef.current) {
        // Remove the AI message being retried
        dispatch(deleteMessage(msgId));
        setTimeout(() => {
          agentLoopRef.current?.run((prevUserMsg as any).content, { skipUserMessage: true }).catch((err: any) => {
            dispatch(addNotification({ type: 'error', title: 'AI 请求失败', message: err.message }));
          });
        }, 100);
      }
    }
  }, [messages, dispatch, invalidateRecordForTruncation, gcMessages]);

  // Delete single message
  const handleDelete = useCallback((msgId: string) => {
    // M2-R6 GC：删单条消息前 release 其附件 sha256。
    const target = messages.find((m: any) => m.id === msgId);
    if (target) gcMessages([target]);
    dispatch(deleteMessage(msgId));
  }, [dispatch, messages, gcMessages]);

  const handleUndoToMessage = useCallback((msgId: string) => {
    void (async () => {
      const targetIndex = messages.findIndex((msg: any) => msg.id === msgId);
      const diffsToRollback = targetIndex >= 0
        ? messages
          .slice(targetIndex + 1)
          .flatMap((msg: any) => msg.diffs ?? [])
          .filter((diff: any) => diff.status !== 'rejected')
          .reverse()
        : [];

      const prompt = diffsToRollback.length > 0
        ? `回溯到这条消息？后续消息会移除，${diffsToRollback.length} 个关联文件变更会按快照回退。`
        : '回溯到这条消息？后续消息会从当前对话中移除。';
      if (!window.confirm(prompt)) return;

      for (const diff of diffsToRollback) {
        const snapshot = diff.snapshotId ? conversation.fileSnapshots[diff.snapshotId] : undefined;
        try {
          await rollbackFileDiff(diff, snapshot);
          dispatch(updateDiffStatus({ diffId: diff.id, status: 'rejected' }));
        } catch (err: any) {
          dispatch(addNotification({ type: 'error', title: '回溯失败', message: err?.message || diff.path }));
          return;
        }
      }

      // 回溯保留到该消息（含）；若 record 覆盖到被截掉的轮次则失效重建。
      if (targetIndex >= 0) {
        invalidateRecordForTruncation(messages.slice(0, targetIndex + 1));
        // 被截掉的后续消息（targetIndex 之后）整体移除 → GC 其附件。
        gcMessages(messages.slice(targetIndex + 1));
      }
      dispatch(truncateAt(msgId));
    })();
  }, [conversation.fileSnapshots, dispatch, messages, invalidateRecordForTruncation, gcMessages]);

  // M2-3 对话分支：在某条消息处「从此分支」→ 把该消息及之前另存为【新对话】，源对话原样保留。
  // 源若仍是 autosave（未落真实 id），先 save 一次 fork 成真实 id 作为稳定 parent，并把当前 store 切到该真实 id，
  // 再从真实 id 分支——避免 parentId 指向易被清理/复用的 AUTOSAVE_ID。源对话内容/消息不被修改（分支是复制）。
  const handleBranch = useCallback((msgId: string) => {
    if (isStreaming) return;
    // ★ M2-6 切换竞态：autosave 源分支会 clearAutosaveSnapshot()+promotion(fork 真实 id)+setConversation，
    //   与切换/新建同构，置闸覆盖整段，挡住旧对话迟到 autosave debounce 复活 AUTOSAVE_ID 草稿。finally 复位。
    beginConversationSwitch();
    // ★ M2-5 worktree 止血：分支切到新对话即回主工作区——清掉源对话 + AUTOSAVE_ID 的活动 worktree 条目。
    //   分支是【新对话】，应从主工作区起步，不继承源对话的 worktree 重定向（避免新分支误写进源的隔离分支）。
    //   promotion（autosave 源 fork 成真实 id）会改变 contextId，这里把源侧两个可能的键都清干净。
    {
      const leavingContextId = (conversationRef.current.id as string | null) || AUTOSAVE_ID;
      dispatch(exitWorktree({ contextId: leavingContextId }));
      dispatch(exitWorktree({ contextId: AUTOSAVE_ID }));
    }
    void (async () => {
      try {
        const snapshotMessages = conversationRef.current.messages;
        if (!snapshotMessages.length) return;

        // 1. 确定稳定的源 id：autosave 源先 fork 成真实 id（与「新对话」fork 同款，clearAutosave 不 release，refCount 守恒）。
        //    recordSrcId 记住 record 当前实际所在的 id（promotion 前的 id）——fork 不迁移 record，故 copyRecord 须从这里读。
        const recordSrcId = (conversationRef.current.id as string | null) || AUTOSAVE_ID;
        let srcId = recordSrcId;
        // ★ issue④⑤修复：autosave 源分支时，下面的 clearAutosaveSnapshot() 在 Electron 会经 SQLite FK CASCADE
        //   级联删掉 `records WHERE conversation_id='autosave-current'`。之后 branchConversation 再去现读 record
        //   就读到 null（新分支零 record 继承），而 Web 模式 record 存独立分键不级联 → 继承正常 → 双模式分叉。
        //   故在级联删除【之前】先把源 record 抓成内存快照，传给 branchConversation 从内存继承，两端一致。
        //   （真实对话分支不走 clearAutosaveSnapshot，无此问题，故仅 autosave 分支需要快照；undefined 时
        //    branchConversation 回退按 recordSrcId 现读。）
        let recordSnapshot: Awaited<ReturnType<typeof getRecord>> | undefined;
        const wasAutosave = !conversationRef.current.id || conversationRef.current.id === AUTOSAVE_ID;
        if (wasAutosave) {
          // 在 clearAutosaveSnapshot 触发 FK CASCADE 之前抓取源 record 内存快照（失败吞为 null，不阻塞分支）。
          recordSnapshot = await getRecord(recordSrcId).catch(() => null);
          // ★ M2-3 主键修复（核心）：messages.id 是全局 UNIQUE 主键。promotion 把当前 autosave 草稿
          //   提升为真实源对话——saveConversationSnapshot(id=AUTOSAVE_ID) 会 createConversationId() 落到【新真实 id】，
          //   并 replaceMessages(新id, 带原 message.id 的消息)。此时若 `autosave-current` 行仍占着同一批 message.id，
          //   INSERT 会撞 `UNIQUE constraint failed: messages.id`、promotion 当场炸（走不到 branchConversation）。
          //   修法：先 clearAutosaveSnapshot 删掉 autosave 行（释放这批 message.id）再 save——与「新建对话 fork
          //   先清后写」严格同构。这样 promotion 全程【保持原 message.id 不变】，落库的 assistantRuns / runEvents
          //   里按 message.id 的反向指针（AssistantRun.messageId / AssistantRunEvent.messageId）零破坏，源对话运行态完整。
          //   安全：消息体已抓进局部 snapshotMessages（不依赖 DB autosave 行），先删 autosave 行不影响 save。
          await clearAutosaveSnapshot();
          const saved = await saveConversationSnapshot({
            id: conversationRef.current.id,
            title: conversationRef.current.title,
            messages: snapshotMessages,
            model: conversationRef.current.model,
            // M2-6：promotion（autosave 源提升为真实对话）随对话落当前 mode / reasoningEffort。
            mode: agentMetaRef.current.mode,
            reasoningEffort: agentMetaRef.current.reasoningEffort,
            assistantRuns: conversationRef.current.assistantRuns,
            fileSnapshots: conversationRef.current.fileSnapshots,
            pendingDiffs: conversationRef.current.pendingDiffs,
            timestamp: Date.now(),
          });
          // 前置条件：autosave 源必须先 promotion 成稳定真实 id 才能作为 parent。
          // 若落库失败（saved 为 null）或仍是 AUTOSAVE_ID（理论不会，防御），则【中止分支】——
          // 绝不带着 AUTOSAVE_ID/null 作 parentId 继续 branchConversation（那会让溯源指针悬空/指向会被复用的 id）。
          if (!saved?.id || saved.id === AUTOSAVE_ID) {
            dispatch(addNotification({
              type: 'warning',
              title: '暂时无法分支',
              message: '请先发送至少一条消息（让对话落库）再从此分支',
            }));
            return;
          }
          srcId = saved.id;
          dispatch(updateConversation(saved));
          // 把当前 store 身份切到真实源 id（消息不变）。autosave 镜像已在 save 前 clearAutosaveSnapshot
          // 清掉（为释放 message.id 主键占用，见上），此处无需再清。
          dispatch(setConversation({
            id: srcId,
            title: conversationRef.current.title,
            messages: snapshotMessages,
            model: conversationRef.current.model,
            assistantRuns: conversationRef.current.assistantRuns,
            fileSnapshots: conversationRef.current.fileSnapshots,
            pendingDiffs: conversationRef.current.pendingDiffs,
          }));
          dispatch(setSelectedId(srcId));
        }

        // 2. 分支：复制子集到新对话 + copyRecord 继承 + 附件 addRef（源对话不动）。
        //    parent = 稳定 srcId；record 优先用 autosave 级联删除前抓的内存快照（issue④⑤），
        //    否则（真实对话分支，未抓快照）回退按 recordSrcId 现读。
        const result = await branchConversation(srcId, msgId, snapshotMessages, {
          title: conversationRef.current.title,
          model: conversationRef.current.model,
          // M2-6：把当前 mode / reasoningEffort 传入，新分支 DB 行一开始即继承源设置（切回不退回默认）。
          mode: agentMetaRef.current.mode,
          reasoningEffort: agentMetaRef.current.reasoningEffort,
          recordSrcId,
          ...(wasAutosave ? { recordSnapshot } : {}),
        });
        if (!result) {
          dispatch(addNotification({ type: 'error', title: '分支失败', message: '无法从此消息分支为新对话' }));
          return;
        }

        // 3. 历史列表加入新对话条目 + 切换到新对话。
        dispatch(updateConversation(result.summary));
        dispatch(setConversation({
          id: result.newId,
          title: result.title,
          messages: result.messages,
          model: result.model,
          // M2-3：切到新分支时回填溯源（DB 已由 branchConversation 写入 parentId/branchedFromMessageId）。
          parentId: result.parentId,
          branchedFromMessageId: result.branchedFromMessageId,
        }));
        // M2-6：分支继承源对话当前的 mode / reasoningEffort（全局 agentSettings 此刻即源设置，无需改动）。
        //   新分支落库时 branchConversation 未带 mode/reasoningEffort → DB 取默认；下次该分支被保存
        //   （saveCurrentToHistory / autosave）即写入其当时设置，与切换恢复闭环一致。
        dispatch(setSelectedId(result.newId));
        // 附件 addRef 守恒检查：若有 sha 重试后仍未 +1，新分支这些图在源对话删除后可能被误删，提示用户。
        if (result.addRefFailedShas.length > 0) {
          dispatch(addNotification({
            type: 'warning',
            title: '已分支（附件未完整保留）',
            message: `${result.addRefFailedShas.length} 个图片附件引用未对齐，删除源对话后可能丢失；建议保留源对话或重新分支`,
          }));
        } else {
          dispatch(addNotification({ type: 'success', title: '已分支', message: '已分支为新对话（源对话保留不变）' }));
        }
      } catch (err: any) {
        dispatch(addNotification({ type: 'error', title: '分支失败', message: err?.message || '从此分支时出错' }));
      } finally {
        endConversationSwitch();
      }
    })();
  }, [dispatch, isStreaming]);

  const openReviewChanges = useCallback(() => {
    dispatch(openTab({
      id: 'review-changes',
      filePath: 'review://changes',
      fileName: 'Review Changes',
      isDirty: false,
      isPreview: false,
      type: 'review',
    }));
  }, [dispatch]);

  const openDiffTarget = useCallback((diff: { path: string }) => {
    dispatch(openTab({
      id: `tab-${Date.now()}`,
      filePath: diff.path,
      fileName: diff.path.split(/[\\/]/).pop() || diff.path,
      isDirty: false,
      isPreview: true,
      type: 'code',
    }));
  }, [dispatch]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const hasMessages = messages.length > 0;

  // Token counter
  const estimatedTokenCount = useMemo(() => {
    if (!messages.length) return 0;
    return countConversationTokens(messages.map((m: any) => ({ role: m.role, content: m.content })));
  }, [messages]);
  const tokenCount = apiTokenCount || estimatedTokenCount;
  // M4-1-S3：统一走 selector 纯函数版（fallback 链 capabilities.contextWindow ?? option.contextWindow ?? MAX_CONTEXT_TOKENS）
  const effectiveContextWindow = getModelContextWindowForOption(currentModelOption);
  const tokenRatio = effectiveContextWindow > 0 ? tokenCount / effectiveContextWindow : 0;

  const formatTokens = (n: number) => {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  };

  const filteredModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return availableModels;
    return availableModels.filter((m: any) =>
      m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q),
    );
  }, [availableModels, modelSearch]);

  const handleSelectModel = useCallback((nextModel: string) => {
    dispatch(setCurrentModel(nextModel));
    dispatch(setConversationModel(nextModel));
    setModelMenuOpen(false);
    setModelSearch('');
    dispatch(addNotification({
      type: 'success',
      title: '模型已切换',
      message: nextModel,
      duration: 2000,
    }));
  }, [dispatch]);

  const addPendingFiles = useCallback(async (files: File[], kind: 'file' | 'image') => {
    const nextAttachments: AttachmentRef[] = [];
    for (const file of files) {
      const id = generateAttachmentId();
      const fileKind = kind === 'image' ? 'image' : getAttachmentKind(file);
      const path = (file as any).path || (file as any).webkitRelativePath || file.name;
      const base: AttachmentRef = {
        id,
        name: file.name,
        path,
        mimeType: file.type || undefined,
        size: file.size,
        kind: fileKind,
        status: 'ready',
      };
      if (fileKind === 'image') {
        if (file.size > MAX_IMAGE_PAYLOAD_BYTES) {
          nextAttachments.push({
            ...base,
            status: 'error',
            error: `图片超过 ${formatBytes(MAX_IMAGE_PAYLOAD_BYTES)}，暂不发送`,
          });
          continue;
        }
        try {
          // M2-R6 上传分离：读出 dataUrl 后立即 platform.attachment.put 抽离成 sha256 内容寻址实体。
          // dataUrl 仅留作内存态即时预览(previewUrl)，落库/发送只认 sha256（payloadUrl 不再内联 base64）。
          const dataUrl = await readAsDataUrl(file);
          const ref = await platform.attachment.put({
            data: dataUrl,
            mime: file.type || undefined,
            name: file.name,
            kind: 'image',
          });
          if ('error' in ref) {
            nextAttachments.push({ ...base, status: 'error', error: ref.message || '附件存储失败' });
          } else {
            nextAttachments.push({
              ...base,
              sha256: ref.sha256,
              size: ref.size || file.size,
              mimeType: ref.mime || base.mimeType,
              previewUrl: dataUrl, // 内存态即时预览；落库前 sanitize 清掉
            });
          }
        } catch (err: any) {
          nextAttachments.push({
            ...base,
            status: 'error',
            error: err?.message || '图片读取失败',
          });
        }
      } else {
        nextAttachments.push(base);
      }
    }

    setPendingAttachments(prev => [...prev, ...nextAttachments]);
    const failed = nextAttachments.filter(att => att.status === 'error').length;
    dispatch(addNotification({
      type: failed ? 'warning' : 'info',
      title: kind === 'image' ? '已加入图片附件' : '已加入文件附件',
      message: failed ? `${nextAttachments.length - failed} 个成功，${failed} 个失败` : nextAttachments.map(att => att.name).join(', '),
      duration: 2500,
    }));
  }, [dispatch]);

  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments(prev => {
      // M2-R6 GC（Codex 中风险③修复）：草稿图选中时已 platform.attachment.put（refCount=1），
      // 移除草稿/放弃发送时必须 release，否则留孤儿实体 + 账本行。已发送的图不走这里（发送转为消息引用）。
      const removed = prev.find(att => att.id === id);
      if (removed?.sha256) void platform.attachment.delete(removed.sha256).catch(() => undefined);
      return prev.filter(att => att.id !== id);
    });
    setPreviewAttachment(prev => prev?.id === id ? null : prev);
  }, []);

  // M2-R6 渲染还原：扫描历史消息里「有 sha256 但无内联预览(previewUrl/payloadUrl)」的 image 附件，
  // 按 sha256 懒加载 dataUrl 填进 resolvedPreviews，触发重渲染显示历史图。仅在确有缺口时拉取（带模块级缓存）。
  useEffect(() => {
    let cancelled = false;
    const wanted = new Set<string>();
    for (const msg of messages as any[]) {
      for (const att of (msg.attachments ?? [])) {
        if (att.kind === 'image' && att.sha256 && !att.previewUrl && !att.payloadUrl && !resolvedPreviews.has(att.sha256)) {
          wanted.add(att.sha256);
        }
      }
    }
    if (wanted.size === 0) return;
    void Promise.all([...wanted].map(async sha => {
      const dataUrl = await resolveAttachmentDataUrl(sha);
      return [sha, dataUrl] as const;
    })).then(pairs => {
      if (cancelled) return;
      const hits = pairs.filter((p): p is readonly [string, string] => !!p[1]);
      if (hits.length === 0) return;
      setResolvedPreviews(prev => {
        const next = new Map(prev);
        for (const [sha, url] of hits) next.set(sha, url);
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [messages, resolvedPreviews]);

  // 把一条消息的 attachments 注入还原后的 previewUrl（内存预览优先；缺失则用 resolvedPreviews 里 sha256 还原的 dataUrl）。
  const resolveAttachmentsForRender = useCallback((atts: AttachmentRef[] | undefined): AttachmentRef[] | undefined => {
    if (!atts || atts.length === 0) return atts;
    let touched = false;
    const next = atts.map(att => {
      if (att.previewUrl || att.payloadUrl) return att;
      if (att.kind === 'image' && att.sha256) {
        const restored = resolvedPreviews.get(att.sha256);
        if (restored) { touched = true; return { ...att, previewUrl: restored }; }
      }
      return att;
    });
    return touched ? next : atts;
  }, [resolvedPreviews]);

  return (
    <div className="agent-panel glass-panel">
      <div className="agent-header">
        <div className="agent-tabs">
          <button className={`agent-tab ${activeAgentTab === 'chat' ? 'active' : ''}`} onClick={() => setActiveAgentTab('chat')}>💬 Chat</button>
          <button className={`agent-tab ${activeAgentTab === 'plan' ? 'active' : ''}`} onClick={() => setActiveAgentTab('plan')}>📋 Plan</button>
          <button className={`agent-tab ${activeAgentTab === 'context' ? 'active' : ''}`} onClick={() => setActiveAgentTab('context')}>📖 Context</button>
          <button
            className="mode-btn"
            onClick={() => { void handleNewConversation(); }}
            title="新建对话"
            style={{ marginLeft: 'auto' }}
            disabled={isStreaming}
          >
            <Plus size={14} />
          </button>
          {messages.length > 0 && (
            <button
              className="mode-btn"
              onClick={() => {
                conversationExporter.export(
                  messages.map((m: any) => ({ role: m.role, content: m.content, timestamp: m.timestamp })),
                  'markdown'
                );
                dispatch(addNotification({ type: 'success', title: '导出成功', message: '对话已导出为 Markdown' }));
              }}
              title="导出对话"
            >
              <Download size={14} />
            </button>
          )}
          <button
            className="mode-btn agent-collapse-btn"
            type="button"
            onClick={() => dispatch(toggleAgentPanel())}
            title="收起 AI 面板"
            aria-label="收起 AI 面板"
          >
            <PanelRightClose size={14} />
          </button>
        </div>
        <div className="agent-mode-switch">
          <button
            className={`mode-btn ${mode === 'fast' ? 'active' : ''}`}
            onClick={() => dispatch(setMode('fast'))}
            disabled={isStreaming}
          >
            <Zap size={14} /><span>Fast</span>
          </button>
          <button
            className={`mode-btn ${mode === 'planning' ? 'active' : ''}`}
            onClick={() => dispatch(setMode('planning'))}
            disabled={isStreaming}
          >
            <Sparkles size={14} /><span>Plan</span>
          </button>
        </div>
      </div>

      <div className="agent-messages">
        {activeAgentTab === 'chat' && (
          <>
            {!hasMessages ? (
              <div className="agent-welcome">
                <div className="agent-welcome-icon">🧠</div>
                <h3>你好，准备好学习了吗？</h3>
                {!hasApiKey && (
                  <p style={{ color: 'var(--syn-accent)', fontSize: 12 }}>
                    ⚠️ 请先在设置 → AI 中配置 API Key
                  </p>
                )}
                {hasApiKey && !hasModel && (
                  <p style={{ color: 'var(--syn-accent)', fontSize: 12 }}>
                    ⚠️ 请先在设置 → AI 中选择模型
                  </p>
                )}
                <p>上传课件，或直接向我提问</p>
                <div className="agent-suggestions">
                  <button className="suggestion-chip" onClick={() => setInput('帮我总结这节课的重点')}>
                    📖 帮我总结这节课的重点
                  </button>
                  <button className="suggestion-chip" onClick={() => setInput('解释这道题的解题思路')}>
                    🧮 解释这道题的解题思路
                  </button>
                  <button className="suggestion-chip" onClick={() => setInput('用简单的例子解释概念')}>
                    💡 用简单的例子解释概念
                  </button>
                </div>
              </div>
            ) : (
              <>
                {messages.map((msg: any, idx: number) => (
                  <Fragment key={msg.id}>
                    {batchDividerByIdx.has(idx) && (
                      <div
                        style={{ textAlign: 'center', fontSize: 11, color: 'var(--syn-text-muted)', padding: '6px 12px', margin: '6px 0', borderTop: '1px dashed rgba(255,255,255,0.12)', opacity: 0.75 }}
                        title="此线以上的历史已压缩为 record 摘要批次；发送给 AI 时用摘要代替原文，这里仍显示完整对话"
                      >
                        ⌁ record 批次 {batchDividerByIdx.get(idx)!.map(i => `#${i + 1}`).join('、')} 边界 — 以上已压缩为摘要，AI 看摘要 + 最近对话 ⌁
                      </div>
                    )}
                  <MessageBubble
                    id={msg.id}
                    role={msg.role}
                    content={msg.content}
                    timestamp={msg.timestamp}
                    model={(msg as any).model}
                    isStreaming={(msg as any).isStreaming}
                    streamState={(msg as any).streamState}
                    streamMode={(msg as any).streamMode}
                    fallbackReason={(msg as any).fallbackReason}
                    showStreamCursor={(msg as any).showStreamCursor}
                    showGeneratingPlaceholder={(msg as any).showGeneratingPlaceholder}
                    durationMs={(msg as any).durationMs}
                    thinking={(msg as any).thinking}
                    attachments={resolveAttachmentsForRender((msg as any).attachments)}
                    toolCalls={(msg as any).toolCalls}
                    diffs={(msg as any).diffs}
                    workflowRunId={(msg as any).workflowRunId}
                    onReviewChanges={openReviewChanges}
                    onOpenDiff={openDiffTarget}
                    onUndoToMessage={handleUndoToMessage}
                    onEdit={handleEdit}
                    onRetry={handleRetry}
                    onDelete={handleDelete}
                    onBranch={handleBranch}
                  />
                  </Fragment>
                ))}
              </>
            )}
            <div ref={messagesEndRef} />
          </>
        )}

        {activeAgentTab === 'plan' && (
          <div className="agent-plan-view">
            <h3 style={{ fontSize: 14, color: 'var(--syn-text-primary)', margin: '8px 12px' }}>🛠️ 工具调用计划</h3>
            {messages.filter((m: any) => m.toolCalls?.length > 0).length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--syn-text-muted)', fontSize: 13 }}>
                暂无工具调用记录
              </div>
            ) : (
              messages.filter((m: any) => m.toolCalls?.length > 0).map((msg: any, i: number) => (
                <div key={i} className="plan-step">
                  <div className="plan-step-header">
                    <span className="plan-step-num">Step {i + 1}</span>
                    <span className="plan-step-time">{new Date(msg.timestamp).toLocaleTimeString()}</span>
                  </div>
                  {msg.toolCalls.map((tc: any, j: number) => (
                    <div key={j} className="plan-tool-item">
                      <span className="plan-tool-icon">🔧</span>
                      <span className="plan-tool-name">{tc.name}</span>
                      <span className="plan-tool-status">✅</span>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        )}

        {activeAgentTab === 'context' && (
          <div className="agent-context-view">
            <h3 style={{ fontSize: 14, color: 'var(--syn-text-primary)', margin: '8px 12px' }}>📖 上下文信息</h3>
            <div className="context-section">
              <div className="context-label">模式</div>
              <div className="context-value">{mode === 'fast' ? '⚡ 快速模式' : '✨ 规划模式'}</div>
            </div>
            <div className="context-section">
              <div className="context-label">模型</div>
              <div className="context-value">{model || '未选择模型'}</div>
            </div>
            <div className="context-section">
              <div className="context-label">Token 使用</div>
              <div className="context-value">
                {formatTokens(tokenCount)} / {formatTokens(effectiveContextWindow)}
                ({Math.round(tokenRatio * 100)}%)
              </div>
            </div>
            <div className="context-section">
              <div className="context-label">已注册工具</div>
              <div className="context-value">{toolRegistry.list().join(', ')}</div>
            </div>
            <div className="context-section">
              <div className="context-label">对话消息</div>
              <div className="context-value">{messages.length} 条</div>
            </div>
            <div className="context-section">
              <div className="context-label">API 端点</div>
              <div className="context-value" style={{ fontSize: 11 }}>{settings.apiEndpoints?.openai || '未配置'}</div>
            </div>
          </div>
        )}
      </div>

      <div className="agent-input-area">
        <div className="agent-input-toolbar">
          <button className="input-tool-btn" title="附加文件" onClick={() => {
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.onchange = (ev: any) => {
              const files = Array.from(ev.target?.files || []) as File[];
              if (files.length > 0) {
                void addPendingFiles(files, 'file');
              }
            };
            input.click();
          }}>📎</button>
          <button className="input-tool-btn" title="附加图片" onClick={() => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.multiple = true;
            input.onchange = (ev: any) => {
              const files = Array.from(ev.target?.files || []) as File[];
              if (files.length > 0) {
                void addPendingFiles(files, 'image');
              }
            };
            input.click();
          }}>🖼</button>
          <div style={{ flex: 1 }} />
          <button
            className={`mode-switch-btn ${mode === 'fast' ? 'fast' : 'planning'}`}
            onClick={() => dispatch(setMode(mode === 'fast' ? 'planning' : 'fast'))}
            title={`切换到${mode === 'fast' ? '规划' : '快速'}模式`}
          >
            {mode === 'fast' ? '⚡ Fast' : '✨ Planning'}
          </button>
        </div>
        {pendingAttachments.length > 0 && (
          <div className="attachment-tray">
            {pendingAttachments.map(att => (
              <button
                key={att.id}
                className={`attachment-chip status-${att.status} kind-${att.kind}`}
                onClick={() => att.kind === 'image' && att.previewUrl ? setPreviewAttachment(att) : undefined}
                title={att.error || `${att.name} · ${formatBytes(att.size)}`}
              >
                {att.kind === 'image' && att.previewUrl ? (
                  <img src={att.previewUrl} alt={att.name} />
                ) : (
                  <span className="attachment-icon">{att.kind === 'document' ? '📄' : att.kind === 'archive' ? '🗜' : '📎'}</span>
                )}
                <span className="attachment-meta">
                  <strong>{att.name}</strong>
                  <small>{att.error || `${att.mimeType || att.kind} · ${formatBytes(att.size)}`}</small>
                </span>
                <span
                  className="attachment-remove"
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    removePendingAttachment(att.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      event.stopPropagation();
                      removePendingAttachment(att.id);
                    }
                  }}
                  aria-label="移除附件"
                >
                  ×
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="agent-input-container">
          <textarea
            ref={inputRef}
            className="agent-input"
            placeholder={!hasApiKey ? "请先配置 API Key..." : !hasModel ? "请先选择模型..." : "输入消息... (Ctrl+Enter 发送；@MultiAI:模式名 触发工作流)"}
            rows={1}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {isStreaming ? (
            <button className="agent-send-btn" onClick={handleStop} title="停止">
              <StopCircle size={18} />
            </button>
          ) : (
            <button
              className="agent-send-btn"
              onClick={handleSend}
              disabled={(!input.trim() && pendingAttachments.filter(att => att.status === 'ready').length === 0) || !hasApiKey || !hasModel}
              title="发送"
            >
              <SendHorizontal size={18} />
            </button>
          )}
        </div>
        <div className="agent-input-footer">
          <span
            className="token-counter"
            style={{
              color: tokenRatio > 0.8 ? 'var(--syn-error)'
                : tokenRatio > 0.5 ? '#f59e0b'
                  : 'var(--syn-text-muted)'
            }}
          >
            Token: {formatTokens(tokenCount)} / {formatTokens(effectiveContextWindow)} ({Math.round(tokenRatio * 100)}%)
          </span>
          {capabilityLabels.length > 0 && (
            <button
              className="model-capability-row"
              type="button"
              title="当前模型能力与参数"
              onClick={() => setModelMenuOpen(true)}
            >
              {capabilityLabels.slice(0, 5).map(label => (
                <span key={label} className="model-capability-chip">{label}</span>
              ))}
            </button>
          )}
          <div className="agent-model-picker" ref={modelPickerRef}>
            <span
              className="model-label clickable"
              style={{
                color: mode === 'fast' ? 'var(--syn-info)' : 'var(--syn-accent)',
                fontWeight: 600,
                cursor: 'pointer',
              }}
              title="切换模型"
              tabIndex={0}
              onClick={() => setModelMenuOpen(open => !open)}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setModelMenuOpen(open => !open);
                }
                if (e.key === 'Escape') setModelMenuOpen(false);
              }}
            >
              {mode === 'fast' ? '⚡' : '✨'} {model || '未选择模型'}
            </span>
            {modelMenuOpen && (
              <div className="model-dropdown">
                {availableModels.length > 0 && (
                  <input
                    className="model-search-input"
                    value={modelSearch}
                    onChange={e => setModelSearch(e.target.value)}
                    placeholder="搜索模型..."
                    autoFocus
                  />
                )}
                {availableModels.length === 0 ? (
                  <div className="model-empty">请在设置中获取模型列表</div>
                ) : filteredModels.length === 0 ? (
                  <div className="model-empty">没有匹配的模型</div>
                ) : (
                  <div className="model-list">
                    {filteredModels.map((m: any) => (
                      <button
                        key={m.id}
                        className={`model-option ${m.id === model ? 'active' : ''}`}
                        onClick={() => handleSelectModel(m.id)}
                        title={m.id}
                      >
                        <span>{m.name || m.id}</span>
                        {m.name && m.name !== m.id && <small>{m.id}</small>}
                        {m.capabilities && (
                          <small>{describeCapabilities(m.capabilities).slice(0, 4).join(' · ')}</small>
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {currentModelOption && (
                  <div className="model-parameter-panel">
                    <div className="model-parameter-header">
                      <span>模型参数</span>
                      <small>{currentCapabilities?.source === 'api' ? 'API 能力' : '能力推断'}</small>
                    </div>
                    <p className="model-param-hint">不支持的参数会保持禁用，不会写入请求。</p>
                    <label className="model-param-row">
                      <span>输出策略</span>
                      <select
                        value={agentSettings.outputStrategy ?? ((agentSettings.enableStreaming ?? true) ? 'auto' : 'off')}
                        onChange={e => dispatch(setOutputStrategy(e.target.value as any))}
                      >
                        <option value="auto">自动</option>
                        <option value="real" disabled={currentCapabilities?.streaming === false}>真流式</option>
                        <option value="pseudo">伪流式</option>
                        <option value="off">关闭流式</option>
                      </select>
                    </label>
                    <label className="model-param-row">
                      <span>伪流式速度</span>
                      <select
                        value={agentSettings.pseudoStreamSpeed ?? 'medium'}
                        disabled={(agentSettings.outputStrategy ?? 'auto') === 'real' && currentCapabilities?.streaming !== false}
                        onChange={e => dispatch(setPseudoStreamSpeed(e.target.value as any))}
                      >
                        <option value="slow">慢</option>
                        <option value="medium">中</option>
                        <option value="fast">快</option>
                      </select>
                    </label>
                    <label className="model-toggle-row">
                      <input
                        type="checkbox"
                        checked={agentSettings.showStreamCursor ?? true}
                        onChange={e => dispatch(setShowStreamCursor(e.target.checked))}
                      />
                      <span>流式光标</span>
                    </label>
                    <label className="model-toggle-row">
                      <input
                        type="checkbox"
                        checked={agentSettings.showGeneratingPlaceholder ?? true}
                        onChange={e => dispatch(setShowGeneratingPlaceholder(e.target.checked))}
                      />
                      <span>生成占位</span>
                    </label>
                    <label className="model-toggle-row">
                      <input
                        type="checkbox"
                        checked={agentSettings.showThinking ?? true}
                        disabled={currentCapabilities?.thinking === false}
                        onChange={e => dispatch(setShowThinking(e.target.checked))}
                      />
                      <span>Thinking 展示</span>
                    </label>
                    <label className="model-toggle-row">
                      <input
                        type="checkbox"
                        checked={agentSettings.streamThinking ?? true}
                        disabled={currentCapabilities?.thinking === false}
                        onChange={e => dispatch(setStreamThinking(e.target.checked))}
                      />
                      <span>Thinking 伪流式</span>
                    </label>
                    <label className="model-param-row">
                      <span>Reasoning</span>
                      <select
                        value={currentCapabilities?.reasoning ? (agentSettings.reasoningEffort ?? 'auto') : 'auto'}
                        disabled={!currentCapabilities?.reasoning}
                        onChange={e => dispatch(setReasoningEffort(e.target.value))}
                      >
                        {reasoningOptions.map((option: string) => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </select>
                    </label>
                    <label className="model-param-row">
                      <span>Speed</span>
                      <select
                        value={speedOptions.includes(agentSettings.speedTier) ? agentSettings.speedTier : 'auto'}
                        disabled={speedOptions.length <= 1 && speedOptions[0] === 'auto'}
                        onChange={e => dispatch(setSpeedTier(e.target.value))}
                      >
                        {speedOptions.map((option: string) => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </select>
                    </label>
                    <label className={`model-slider-row ${supportsTemperature ? '' : 'disabled'}`}>
                      <span>Temperature <strong>{(agentSettings.temperature ?? 0.7).toFixed(2)}</strong></span>
                      <input
                        type="range"
                        min="0"
                        max="2"
                        step="0.05"
                        value={agentSettings.temperature ?? 0.7}
                        disabled={!supportsTemperature}
                        onChange={e => dispatch(setTemperature(Number(e.target.value)))}
                      />
                    </label>
                    <label className={`model-slider-row ${supportsTopP ? '' : 'disabled'}`}>
                      <span>Top P <strong>{(agentSettings.topP ?? 1).toFixed(2)}</strong></span>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={agentSettings.topP ?? 1}
                        disabled={!supportsTopP}
                        onChange={e => dispatch(setTopP(Number(e.target.value)))}
                      />
                    </label>
                    <label className="model-param-row">
                      <span>Max Tokens</span>
                      <input
                        type="number"
                        min="256"
                        max={currentCapabilities?.maxOutputTokens ?? 128000}
                        step="256"
                        value={agentSettings.maxTokens ?? 4096}
                        disabled={!supportsMaxTokens}
                        onChange={e => dispatch(setMaxTokens(Math.max(256, Number(e.target.value) || 4096)))}
                      />
                    </label>
                  </div>
                )}
              </div>
            )}
          </div>
          {!hasApiKey && <span style={{ color: '#f59e0b', fontSize: 11 }}>未配置</span>}
          {hasApiKey && !hasModel && <span style={{ color: '#f59e0b', fontSize: 11 }}>未选择模型</span>}
        </div>
        {previewAttachment && (
          <div className="attachment-preview-backdrop" onClick={() => setPreviewAttachment(null)}>
            <div className="attachment-preview-modal" onClick={event => event.stopPropagation()}>
              <div className="attachment-preview-header">
                <span>{previewAttachment.name}</span>
                <button onClick={() => setPreviewAttachment(null)} title="关闭">×</button>
              </div>
              {previewAttachment.previewUrl && (
                <img className="attachment-preview-image" src={previewAttachment.previewUrl} alt={previewAttachment.name} />
              )}
              <div className="attachment-preview-actions">
                <span>{formatBytes(previewAttachment.size)} · {previewAttachment.mimeType || 'image'}</span>
                <button className="settings-btn danger" onClick={() => removePendingAttachment(previewAttachment.id)}>移除</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

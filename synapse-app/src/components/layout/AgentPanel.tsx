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
import { clearConversation, editMessage, truncateAt, deleteMessage, setConversation, setModel as setConversationModel, updateDiffStatus, type AttachmentRef, type MessageContentPart } from '@/store/slices/conversation';
import { countConversationTokens, MAX_CONTEXT_TOKENS } from '@/services/systemPrompt';
import { conversationExporter } from '@/services/conversationExporter';
import { clearAutosaveSnapshot, loadAutosaveSnapshot, saveAutosaveSnapshot, saveConversationSnapshot } from '@/services/conversationPersistence';
import { setSelectedId, updateConversation } from '@/store/slices/conversationHistory';
import { openTab } from '@/store/slices/editorTabs';
import type { RootState } from '@/store';
import { rollbackFileDiff } from '@/services/fileRollback';
import { describeCapabilities } from '@/services/modelCapabilities';
import { getRecord, deleteRecord } from '@/services/recordStore';

const MAX_IMAGE_PAYLOAD_BYTES = 8 * 1024 * 1024;

function generateAttachmentId(): string {
  return `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
  const isStreaming = useAppSelector((s: RootState) => (s as any).conversation.isStreaming);
  const settings = useAppSelector((s: RootState) => (s as any).settings);
  const agentSettings = useAppSelector((s: RootState) => (s as any).agentSettings);
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
  // M1 Step3: 读取当前对话 record 覆盖到的消息条数，用于在消息流标出「压缩点」分隔线（展示仍完整）
  const conversationId = conversation.id as string | null;
  const [recordCoverageSteps, setRecordCoverageSteps] = useState(0);
  useEffect(() => {
    let cancelled = false;
    if (!conversationId) { setRecordCoverageSteps(0); return; }
    void getRecord(conversationId).then(rec => {
      if (!cancelled) setRecordCoverageSteps(rec?.totalSteps ?? 0);
    });
    return () => { cancelled = true; };
  }, [conversationId, messages.length]);
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentRef[]>([]);
  const [previewAttachment, setPreviewAttachment] = useState<AttachmentRef | null>(null);
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
      (name, args) => toolRegistry.execute(name, args),
    );
    // P1-3: 设置审批回调（弹出确认对话框）
    toolRegistry.setApprovalCallback(async (toolName, args, level) => {
      const msg = `AI 请求执行工具 "${toolName}"（权限: ${level}）\n参数: ${JSON.stringify(args, null, 2).slice(0, 200)}`;
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
  useEffect(() => {
    if (messages.length === 0 || isStreaming) return;
    const timeout = window.setTimeout(() => {
      void saveAutosaveSnapshot({
        id: conversation.id,
        title: conversation.title,
        messages,
        model,
        assistantRuns: conversation.assistantRuns,
        fileSnapshots: conversation.fileSnapshots,
        pendingDiffs: conversation.pendingDiffs,
        timestamp: Date.now(),
      }).catch(() => {
        try {
          localStorage.setItem('synapse_autosave', JSON.stringify({
            messages,
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
          }));
          dispatch(addNotification({ type: 'info', title: '已恢复', message: '已恢复上次对话', duration: 2000 }));
        }
      } catch { /* corrupted — skip */ }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const buildUserContentParts = useCallback((text: string, attachments: AttachmentRef[]): MessageContentPart[] => {
    const parts: MessageContentPart[] = [];
    if (text) parts.push({ type: 'text', text });
    for (const attachment of attachments) {
      if (attachment.status !== 'ready') continue;
      if (attachment.kind === 'image' && attachment.payloadUrl) {
        parts.push({
          type: 'image_url',
          image_url: { url: attachment.payloadUrl, detail: 'auto' },
          attachmentId: attachment.id,
        });
      }
    }
    return parts;
  }, []);

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
  }, [input, pendingAttachments, isStreaming, hasApiKey, hasModel, buildUserContentParts, dispatch]);

  const handleStop = useCallback(() => {
    agentLoopRef.current?.stop();
  }, []);

  // Plan_4_M1 风险 2：编辑/重试/回溯会截断后续消息。若已生成的 record 覆盖到了
  // 被截掉的轮次（record.lastUpdatedRound > 截断后剩余的用户轮次），其稳定前缀就
  // 包含「已不存在的历史」，且水位线会高于实际消息数导致后续增量永久错位。
  // 粗粒度兜底：这种情况直接删 record，让下个压缩点全量重建。record 是加速层，
  // 删了至多多花一次生成，绝不阻塞主对话；失败也只 warn。
  // （精细方案——把 lastUpdatedRound clamp 到新轮次并标记 contentMd 失效——见 Task_4 TODO。）
  const invalidateRecordForTruncation = useCallback((remainingMessages: any[]) => {
    const conversationId = conversation.id;
    if (!conversationId) return;
    const remainingRounds = remainingMessages.filter((m: any) => m.role === 'user').length;
    void (async () => {
      try {
        const record = await getRecord(conversationId);
        if (record && record.lastUpdatedRound > remainingRounds) {
          await deleteRecord(conversationId);
        }
      } catch { /* record 是加速层，失效兜底失败不影响主对话 */ }
    })();
  }, [conversation.id]);

  // Edit user message → truncate after it → re-send
  const handleEdit = useCallback((msgId: string, newContent: string) => {
    // 截断后剩余消息 = 该消息及之前（与 editMessage reducer 的 slice(0, idx+1) 对齐）
    const editIdx = messages.findIndex((m: any) => m.id === msgId);
    if (editIdx >= 0) invalidateRecordForTruncation(messages.slice(0, editIdx + 1));
    dispatch(editMessage({ id: msgId, content: newContent }));
    // Re-send edited message
    if (agentLoopRef.current) {
      setTimeout(() => {
        agentLoopRef.current?.run(newContent, { skipUserMessage: true }).catch((err: any) => {
          dispatch(addNotification({ type: 'error', title: 'AI 请求失败', message: err.message }));
        });
      }, 100);
    }
  }, [dispatch, messages, invalidateRecordForTruncation]);

  // Retry: delete last AI message → re-send last user message
  const handleRetry = useCallback((msgId: string) => {
    // truncateAt 保留到 msgId，随后 deleteMessage(msgId) 再删掉这条 AI 消息。
    const retryIdx = messages.findIndex((m: any) => m.id === msgId);
    if (retryIdx >= 0) invalidateRecordForTruncation(messages.slice(0, retryIdx));
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
  }, [messages, dispatch, invalidateRecordForTruncation]);

  // Delete single message
  const handleDelete = useCallback((msgId: string) => {
    dispatch(deleteMessage(msgId));
  }, [dispatch]);

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
      if (targetIndex >= 0) invalidateRecordForTruncation(messages.slice(0, targetIndex + 1));
      dispatch(truncateAt(msgId));
    })();
  }, [conversation.fileSnapshots, dispatch, messages, invalidateRecordForTruncation]);

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
  const effectiveContextWindow = currentCapabilities?.contextWindow ?? MAX_CONTEXT_TOKENS;
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
          const dataUrl = await readAsDataUrl(file);
          nextAttachments.push({
            ...base,
            previewUrl: dataUrl,
            payloadUrl: dataUrl,
          });
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
    setPendingAttachments(prev => prev.filter(att => att.id !== id));
    setPreviewAttachment(prev => prev?.id === id ? null : prev);
  }, []);

  return (
    <div className="agent-panel glass-panel">
      <div className="agent-header">
        <div className="agent-tabs">
          <button className={`agent-tab ${activeAgentTab === 'chat' ? 'active' : ''}`} onClick={() => setActiveAgentTab('chat')}>💬 Chat</button>
          <button className={`agent-tab ${activeAgentTab === 'plan' ? 'active' : ''}`} onClick={() => setActiveAgentTab('plan')}>📋 Plan</button>
          <button className={`agent-tab ${activeAgentTab === 'context' ? 'active' : ''}`} onClick={() => setActiveAgentTab('context')}>📖 Context</button>
          <button
            className="mode-btn"
            onClick={() => {
              if (messages.length > 0) {
                void saveConversationSnapshot({
                  id: conversation.id,
                  title: conversation.title,
                  messages,
                  model,
                  assistantRuns: conversation.assistantRuns,
                  fileSnapshots: conversation.fileSnapshots,
                  pendingDiffs: conversation.pendingDiffs,
                  timestamp: Date.now(),
                }).then((summary) => {
                  if (summary) dispatch(updateConversation(summary));
                });
              }
              dispatch(clearConversation());
              dispatch(setSelectedId(null));
              void clearAutosaveSnapshot();
              dispatch(addNotification({ type: 'info', title: '新对话', message: '已创建新对话' }));
            }}
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
                    {recordCoverageSteps > 0 && idx === recordCoverageSteps && (
                      <div
                        style={{ textAlign: 'center', fontSize: 11, color: 'var(--syn-text-muted)', padding: '6px 12px', margin: '6px 0', borderTop: '1px dashed rgba(255,255,255,0.12)', opacity: 0.75 }}
                        title="此线以上的历史已压缩为 record 摘要；发送给 AI 时用摘要代替原文，这里仍显示完整对话"
                      >
                        ⌁ 以上 {recordCoverageSteps} 条已压缩为 record 摘要，AI 看摘要 + 最近对话 ⌁
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
                    attachments={(msg as any).attachments}
                    toolCalls={(msg as any).toolCalls}
                    diffs={(msg as any).diffs}
                    onReviewChanges={openReviewChanges}
                    onOpenDiff={openDiffTarget}
                    onUndoToMessage={handleUndoToMessage}
                    onEdit={handleEdit}
                    onRetry={handleRetry}
                    onDelete={handleDelete}
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
            placeholder={!hasApiKey ? "请先配置 API Key..." : !hasModel ? "请先选择模型..." : "输入消息... (Ctrl+Enter 发送)"}
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

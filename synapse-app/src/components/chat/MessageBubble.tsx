import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Copy, Check, User, Bot, Wrench, MessageSquare, Pencil, RefreshCw, Trash2, FilePlus, FilePenLine, FileX2, ListChecks, Undo2, GitBranch, ChevronDown, ChevronRight } from 'lucide-react';
import { memo, useDeferredValue, useState, useCallback, useEffect, useRef } from 'react';
import { ToolCallCard } from './ToolCallCard';
import { WorkflowCard } from './WorkflowCard';
import { ContextMenu, type MenuItem } from '@/components/ui/ContextMenu';
import { useResolvedTheme } from '@/hooks/useResolvedTheme';
import { RichTextInput } from '@/components/chat/RichTextInput';
import { useAtMention } from '@/components/chat/useAtMention';
import { useAttachments } from '@/hooks/useAttachments';
import type { RichTextInputHandle, ExtractedToken } from '@/services/inputCommands/richInput/types';
import { buildRichParts } from '@/services/inputCommands/richInput/rebuild';
import type { AttachmentRef } from '@/store/slices/conversation';

interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
  status: 'pending' | 'running' | 'success' | 'error';
  result?: string;
}

interface FileDiffInfo {
  id: string;
  path: string;
  changeType: 'created' | 'edited' | 'deleted';
  additions: number;
  deletions: number;
  status: 'pending' | 'accepted' | 'rejected' | 'mixed' | 'superseded';
}

interface ThinkingInfo {
  content: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  collapsed?: boolean;
  status: 'pending' | 'streaming' | 'complete' | 'error';
}

interface AttachmentInfo {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  kind: 'image' | 'document' | 'text' | 'archive' | 'other';
  previewUrl?: string;
  // ★ M4-3-S3：打开已发附件需要这两个字段——sha256 用于按内容寻址 platform.attachment.get 解析 blob，
  //   payloadUrl 是内存态即时可用 URL（http/blob/object，非 data:）。运行时由 AttachmentRef 透传齐全。
  payloadUrl?: string;
  sha256?: string;
  status: 'pending' | 'ready' | 'error' | 'sent';
  error?: string;
}

interface MessageProps {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  timestamp?: number;
  model?: string;
  isStreaming?: boolean;
  streamState?: 'idle' | 'pending' | 'streaming' | 'complete' | 'error' | 'aborted';
  streamMode?: 'real' | 'pseudo' | 'off';
  fallbackReason?: string;
  showStreamCursor?: boolean;
  showGeneratingPlaceholder?: boolean;
  durationMs?: number;
  // ★ M4-8-S3：重连进度【瞬态】——退避重试期间显示「reconnect i/N」，收到实质数据/本轮收尾即清。
  reconnect?: { attempt: number; max: number };
  // ★ M4-8-S4：端到端总计时（ms）——只挂在 agent loop 最终完成消息那一条上，渲染端到端徽标。
  endToEndMs?: number;
  thinking?: ThinkingInfo;
  attachments?: AttachmentInfo[];
  /** ★ M6 收尾 D1：富文本 atomic token 持久化锚点，编辑回填时供 buildRichParts 重组无损还原 @ 高亮块。 */
  richTokens?: ExtractedToken[];
  toolCalls?: ToolCallInfo[];
  diffs?: FileDiffInfo[];
  // ★ M3-3a：@MultiAI 工作流汇总消息关联的运行实例 id；有则在消息体渲染实时四色 <WorkflowCard/>，
  //   纯文本 content 作为可折叠 fallback。
  workflowRunId?: string;
  onReviewChanges?: () => void;
  onOpenDiff?: (diff: FileDiffInfo) => void;
  // ★ M4-3-S3：点击已发附件——图片走预览模态、文档走编辑器 attachment tab（由 AgentPanel 实装）。
  onOpenAttachment?: (att: AttachmentInfo) => void;
  onUndoToMessage?: (id: string) => void;
  onEdit?: (id: string, newContent: string, attachments?: AttachmentRef[], richTokens?: ExtractedToken[]) => void;
  onRetry?: (id: string) => void;
  onDelete?: (id: string) => void;
  // M2-3 对话分支：从该消息处「从此分支」，把该消息及之前另存为新对话（源对话不变）。
  onBranch?: (id: string) => void;
}

// ★ M7 P0-3：判断某个 mermaid 代码块在 content 里是否【已闭合】（后面有结束的 fence），用于「该渲染就渲染」。
//   用正则提取所有已闭合 ```mermaid...``` 的代码体集合做成员判定（trim 比对，规避代码体含 ``` 字面量干扰，
//   不用纯数 fence 偶数法）。流式末尾正在写的未闭合块不会被匹配到 → 返回 false → 显加载占位。
function isMermaidFenceClosed(content: string, blockCode: string): boolean {
  const target = (blockCode ?? '').trim();
  if (!target) return false;
  const re = /```[ \t]*mermaid[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if ((m[1] ?? '').trim() === target) return true;
  }
  return false;
}

// Mermaid renderer component
// ★ M7 P0-3：pending = 该 mermaid 块是「正在流式书写的未闭合块」（半截代码）。只对它显加载占位、不喂 mermaid；
//   已闭合的块即使整条消息还在流式也立即渲染（该渲染就渲染，由上游 isFenceClosed 判定后传 pending=false）。
function MermaidBlock({ code, pending }: { code: string; pending?: boolean }) {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');
  // ★ 浅色适配：mermaid 图表主题跟随 app 主题（之前写死 dark，浅色模式下图表深色突兀）。
  const resolvedTheme = useResolvedTheme();

  useEffect(() => {
    if (pending) return; // 未闭合块不渲染（半截代码喂 mermaid 会 throw）；闭合后 pending=false，effect 重跑渲染。
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        const DOMPurify = (await import('dompurify')).default;
        const isLight = resolvedTheme === 'light';
        mermaid.initialize({
          startOnLoad: false,
          theme: isLight ? 'default' : 'dark',
          securityLevel: 'strict', // P1-2: 防止 SVG 注入
          // ★ M6 验收：节点文字用 SVG <text> 而非默认 foreignObject(HTML)——后者会被下面 DOMPurify 的纯 svg
          //   profile 清掉，导致「只剩框、没文字」。htmlLabels:false 让 DOMPurify svg profile 能完整保留文字。
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          themeVariables: isLight
            ? { primaryColor: '#7c3aed', primaryTextColor: '#111827', lineColor: '#64748b', secondaryColor: '#eef1f7', tertiaryColor: '#f6f7fb' }
            : { primaryColor: '#8b5cf6', primaryTextColor: '#e2e8f0', lineColor: '#64748b', secondaryColor: '#1e293b', tertiaryColor: '#0f172a' },
        });
        // ★ P0-3 加固：先 parse 预校验（suppressErrors 不抛）——半截/无效代码 parse 返回 false 时静默等下一帧、
        //   保留旧 svg，避免「渲染失败红框」闪烁（即便 isFenceClosed 判定偶有误判也不炸）。
        const valid = await mermaid.parse(code, { suppressErrors: true });
        if (!valid) { if (!cancelled) setError(''); return; }
        // 校验通过才清 error + 渲染（成功路径清残留 error，否则成功后仍卡红框，error 判定优先于 svg）。
        if (!cancelled) setError('');
        const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const { svg: rendered } = await mermaid.render(id, code);
        // ★ 兜底：仍允许 foreignObject（某些图类型即便 htmlLabels:false 也可能用），html profile 保留其内文字。
        if (!cancelled) setSvg(DOMPurify.sanitize(rendered, { USE_PROFILES: { svg: true, html: true }, ADD_TAGS: ['foreignObject'] }));
      } catch (e: any) {
        if (!cancelled) setError(e.message || 'Mermaid 渲染失败');
      }
    })();
    return () => { cancelled = true; };
  }, [code, resolvedTheme, pending]);

  // 未闭合块（正在书写）显示源码占位，不喂半截代码给 mermaid。
  if (pending) {
    return <pre className="mermaid-loading">{code}</pre>;
  }

  if (error) {
    return (
      <div className="mermaid-error">
        <span>⚠️ 图表渲染失败</span>
        <pre>{code}</pre>
      </div>
    );
  }

  if (!svg) {
    return <div className="mermaid-loading">加载图表...</div>;
  }

  return (
    <div
      className="mermaid-container"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function changeIcon(type: FileDiffInfo['changeType']) {
  if (type === 'created') return FilePlus;
  if (type === 'deleted') return FileX2;
  return FilePenLine;
}

function changeLabel(type: FileDiffInfo['changeType']) {
  if (type === 'created') return 'Created';
  if (type === 'deleted') return 'Deleted';
  return 'Edited';
}

// ★ M4-8-S4：带空格「X m Y s」+ 补 hour 位（≥1h 显示「H h M m S s」），支持「26 m 39 s」「1 h 5 m 0 s」量级。
function formatDuration(ms: number): string {
  if (ms < 1000) return '<1 s';
  const totalSeconds = Math.round(ms / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours >= 1) return `${hours} h ${minutes} m ${seconds} s`;
  if (totalMinutes >= 1) return `${minutes} m ${seconds} s`;
  return `${seconds} s`;
}

function formatBytes(bytes?: number): string {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function MessageBubbleImpl({ id, role, content, timestamp, model, isStreaming, streamState, streamMode, fallbackReason, showStreamCursor = true, showGeneratingPlaceholder = true, durationMs, reconnect, endToEndMs, thinking, attachments, richTokens, toolCalls, diffs, workflowRunId, onReviewChanges, onOpenDiff, onOpenAttachment, onUndoToMessage, onEdit, onRetry, onDelete, onBranch }: MessageProps) {
  const [copied, setCopied] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  // ★ C6：编辑框改用 RichTextInput（DOM 唯一真值，与底部输入框完全一致），不再用 editContent 受控字符串。
  const editRichRef = useRef<RichTextInputHandle>(null);
  const [thinkingOpen, setThinkingOpen] = useState(!thinking?.collapsed);
  // ★ M3-3a：工作流卡片消息默认折叠纯文本汇总（卡片是主视图，文本汇总作为可展开 fallback）。
  const [workflowSummaryOpen, setWorkflowSummaryOpen] = useState(false);
  // ★ M5-1 压缩归一：原 role==='system' 压缩摘要卡片的折叠 state 已删除（不再渲染 system 摘要卡片）。
  const [now, setNow] = useState(() => Date.now());
  // ★ C6：editRef(textarea) 移除，改 editRichRef(RichTextInput)。
  const live = isStreaming || streamState === 'pending' || streamState === 'streaming';
  // ★ M7 性能 D1：markdown 渲染用 deferredContent（滞后一拍的低优先级值）——把长尾 markdown 解析标记为
  //   可中断渲染，让输入/点按钮等紧急交互能插队优先，缓解流式期界面卡顿（React 19）。
  const deferredContent = useDeferredValue(content);
  const elapsedMs = durationMs ?? (timestamp ? now - timestamp : 0);
  const streamLabel = streamMode === 'pseudo'
    ? 'Pseudo'
    : streamMode === 'real'
      ? 'Streaming'
      : streamMode === 'off'
        ? 'Complete'
        : 'Thought';

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 300);
    return () => window.clearInterval(timer);
  }, [live]);

  useEffect(() => {
    if (thinking?.collapsed !== undefined) setThinkingOpen(!thinking.collapsed);
  }, [thinking?.collapsed]);

  const handleStartEdit = useCallback(() => {
    setIsEditing(true);
    // setContent + focus 在下方 effect（RichTextInput 挂载后）执行。
  }, []);

  // ★ C6 附件：编辑框复用底部同款附件链路（useAttachments hook，与编辑框 @ 菜单 useAtMention 同构）。
  const editAtt = useAttachments();
  const editFileInputRef = useRef<HTMLInputElement>(null);
  const editImageInputRef = useRef<HTMLInputElement>(null);

  const handleSubmitEdit = useCallback(() => {
    // ★ D1：同时取最新 tokens——用户编辑时可能增删了 atomic 块，必须用 extract 后的最新集合（不能复用进编辑前的旧 richTokens）。
    const extracted = editRichRef.current?.extract();
    const text = (extracted?.plainText ?? '').trim();
    const newTokens = extracted?.tokens ?? [];
    const readyAtts = editAtt.ready();
    // 纯空（无文本无附件）→ 取消 + release 新上传草稿；否则带文本+附件+richTokens 提交。
    if (!text && readyAtts.length === 0) { setIsEditing(false); editAtt.releaseDrafts(); return; }
    onEdit?.(id, text, readyAtts, newTokens.length > 0 ? newTokens : undefined);
    setIsEditing(false);
    editAtt.markCommitted(); // 新上传草稿引用已随消息转移走，清记录不 release（refCount 守恒路径 E）。
  }, [id, content, onEdit, editAtt]);

  const handleCancelEdit = useCallback(() => {
    setIsEditing(false);
    editAtt.releaseDrafts(); // 取消：release 本次新上传草稿，原消息引用不动（路径 D）。
  }, [editAtt]);

  // ★ C6：编辑框 = RichTextInput + 完整两级 @ 菜单（与底部输入框同一套 useAtMention）。Enter 保存、Shift+Enter 换行、Esc 取消。
  const { menuElement: editMenuElement, handleEditorKeyDown: editKeyDown, refreshMenu: editRefreshMenu } = useAtMention({
    richRef: editRichRef,
    onSubmit: handleSubmitEdit,
    submitOnPlainEnter: true,
  });

  // 进入编辑：RichTextInput 挂载后回填 + 聚焦 + 还原原消息附件成可编辑草稿。
  // ★ D1：用 buildRichParts(content, richTokens) 重组——有 richTokens 时无损还原 atomic 块，旧消息无 richTokens 自动降级纯文本。
  useEffect(() => {
    if (!isEditing) return;
    editRichRef.current?.setContent(buildRichParts(content, richTokens));
    editRichRef.current?.focus();
    editAtt.restoreFrom(attachments as AttachmentRef[] | undefined);
    // richTokens/attachments/editAtt 故意不入依赖：进编辑那一刻快照即可，避免外部刷新覆盖用户编辑（与附件同口径）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, content]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const messageMenuItems: MenuItem[] = [
    {
      label: '复制内容',
      icon: <Copy size={14} />,
      shortcut: 'Ctrl+C',
      onClick: handleCopy,
    },
    {
      label: '复制为 Markdown',
      icon: <Copy size={14} />,
      onClick: () => navigator.clipboard.writeText(`**${role === 'user' ? '用户' : 'AI'}**: ${content}`),
    },
    { label: '', onClick: () => { }, separator: true },
    {
      label: '引用回复',
      icon: <MessageSquare size={14} />,
      onClick: () => console.log('引用:', content.slice(0, 50)),
    },
    // Stage 6: 按角色添加操作
    ...(role === 'user' ? [{
      label: '编辑消息',
      icon: <Pencil size={14} />,
      shortcut: 'E',
      onClick: handleStartEdit,
    }] : []),
    // ★ Plan_5 M5-4 重试入口（规范 §5）：重试挂在 user 消息上（不再挂 AI 消息）。
    //   点某条 user 的「重新生成」= 回溯到该 user 所在轮（截断该 user 段之后全部，含本轮 model 段所有
    //   assistant/tool 中间 step）+ record 砍批 + 自动重发该 user（不填输入框）。接线见 AgentPanel.handleRetry。
    ...(role === 'user' && onRetry ? [{
      label: '重新生成回答',
      icon: <RefreshCw size={14} />,
      shortcut: 'R',
      onClick: () => onRetry(id),
    }] : []),
    ...(onBranch ? [{
      label: '从此分支为新对话',
      icon: <GitBranch size={14} />,
      onClick: () => onBranch(id),
    }] : []),
    { label: '', onClick: () => { }, separator: true },
    {
      label: '删除消息',
      icon: <Trash2 size={14} />,
      onClick: () => {
        if (window.confirm('确定删除这条消息？')) onDelete?.(id);
      },
      danger: true,
    },
  ];

  if (role === 'tool') {
    return (
      <div className="message message-tool">
        <div className="message-avatar tool-avatar">
          <Wrench size={14} />
        </div>
        <div className="message-body">
          <div className="tool-result-card glass-panel">
            <pre className="tool-result-content">{content}</pre>
          </div>
        </div>
      </div>
    );
  }

  // ★ M5-1 压缩归一：原 role==='system' 的「手动压缩摘要卡片」渲染分支已删除。
  //   归一后压缩绝不把摘要物化成 system 消息塞进 store.messages，故正常不再有 system 摘要卡片需要渲染。
  //   压缩点改由 AgentPanel.batchDividerByIdx「已压缩」分隔线呈现，对话原文照常全量显示。
  //   遗留 system 摘要的【治本清理】在对话加载入口（conversationPersistence.stripLegacyCompactMessages）一次性剥除，
  //   归一后 store 恒无 system 消息——这是主防线。
  //
  //   下面这条极简 system 兜底是【第二道防线】（纯防御）：万一某条遗留 compact_* system 摘要因边缘路径仍漏进 store，
  //   绝不让它掉到通用气泡分支被当成 AI 正文铺出（既视觉突兀又误导用户以为 AI 真发了这段）。
  //   渲染成与「已压缩」分隔线同款的极简提示，原文不当正文展示。
  if (role === 'system') {
    return (
      <div
        className="message-compact-divider"
        style={{ textAlign: 'center', fontSize: 11, color: 'var(--syn-text-muted)', padding: '6px 12px', margin: '6px 0', borderTop: '1px dashed rgba(255,255,255,0.12)', opacity: 0.75 }}
        title="此处为历史压缩摘要占位（遗留数据）；发送给 AI 时用 record 摘要代替原文"
      >
        ⌁ 历史已压缩为摘要 ⌁
      </div>
    );
  }

  const isUser = role === 'user';

  return (
    <div className={`message message-${role}`} onContextMenu={handleContextMenu}>
      <div className={`message-avatar ${isUser ? 'user-avatar' : 'assistant-avatar'}`}>
        {isUser ? <User size={16} /> : <Bot size={16} />}
      </div>
      <div className="message-body">
        <div className="message-header">
          <span className="message-role">{isUser ? '你' : 'Synapse AI'}</span>
          {timestamp && (
            <span className="message-time">
              {new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          {model && <span className="message-model">{model}</span>}
          {!isUser && (live || durationMs !== undefined || streamState === 'aborted') && (
            <span
              className={`message-stream-state state-${streamState ?? (live ? 'streaming' : 'complete')} mode-${streamMode ?? 'unknown'}`}
              title={fallbackReason}
            >
              {streamState === 'aborted' ? 'Stopped' : `${streamLabel} for ${formatDuration(elapsedMs)}`}
            </span>
          )}
          {/* ★ M4-8-S3：重连进度——退避重试期间气泡内显示「reconnect i/N」（瞬态，收到数据/收尾即清）。 */}
          {!isUser && reconnect && (
            <span className="message-reconnect-state" title="连接不稳，正在自动重试">
              <RefreshCw size={11} className="reconnect-spin" /> reconnect {reconnect.attempt}/{reconnect.max}
            </span>
          )}
          {/* ★ M4-8-S4：端到端总计时徽标——只挂在 agent loop 最终完成消息那一条（含多轮工具调用全程）。 */}
          {!isUser && endToEndMs !== undefined && (
            <span className="message-e2e-state" title="本轮端到端总耗时（含多轮工具调用）">
              total {formatDuration(endToEndMs)}
            </span>
          )}
          {/* Action buttons */}
          <div className="message-actions">
            {!isUser && (
              <button className="message-action-btn" onClick={handleCopy} title="复制">
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </button>
            )}
            {isUser && !isStreaming && onEdit && (
              <button className="message-action-btn" onClick={handleStartEdit} title="编辑">
                <Pencil size={12} />
              </button>
            )}
            {/* ★ Plan_5 M5-4：重试入口改挂 user 消息（点该 user = 回溯到其所在轮 + 自动重发该 user）。 */}
            {isUser && !isStreaming && onRetry && (
              <button className="message-action-btn" onClick={() => onRetry(id)} title="重新生成回答（回溯到本轮并重发）">
                <RefreshCw size={12} />
              </button>
            )}
            {!isStreaming && onDelete && (
              <button className="message-action-btn danger" onClick={() => onDelete(id)} title="删除">
                <Trash2 size={12} />
              </button>
            )}
            {/* ★ Plan_5 M5-3：回溯入口只挂 user 消息——点该 user = 它及之后全部回溯掉、该 user 回填输入框待改后再发。 */}
            {isUser && !isStreaming && onUndoToMessage && (
              <button className="message-action-btn" onClick={() => onUndoToMessage(id)} title="回溯：清掉这条及之后，这条回到输入框">
                <Undo2 size={12} />
              </button>
            )}
            {!isStreaming && onBranch && (
              <button className="message-action-btn" onClick={() => onBranch(id)} title="从此分支为新对话">
                <GitBranch size={12} />
              </button>
            )}
          </div>
        </div>
        {/* ★ M4-3-S2：思考块移到正文之前（原在正文之后导致「思考显示在回答下方」）。折叠逻辑不变。 */}
        {!isUser && thinking?.content && (
          <div className="thinking-block">
            <button className="thinking-toggle" onClick={() => setThinkingOpen(open => !open)}>
              {thinkingOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span>Thought for {formatDuration(thinking.durationMs ?? elapsedMs)}</span>
            </button>
            {thinkingOpen && (
              <pre className="thinking-content">{thinking.content}</pre>
            )}
          </div>
        )}
        <div className={`message-content ${isStreaming ? 'streaming' : ''}`}>
          {isUser ? (
            isEditing ? (
              <div className="message-edit-area">
                {/* ★ C6：编辑框与底部输入框完全一致——RichTextInput + 两级 @ 菜单（复用 .agent-input 样式）。 */}
                <div className="agent-input-container message-edit-rich">
                  {editMenuElement}
                  <RichTextInput
                    ref={editRichRef}
                    className="agent-input"
                    placeholder="编辑消息... (Enter 保存，Shift+Enter 换行，Esc 取消；@ 引用，/ 命令)"
                    onContentChange={editRefreshMenu}
                    onPasteFiles={(files) => { void editAtt.addFiles(files, 'image'); }}
                    onEditorKeyDown={(e) => {
                      if (editKeyDown(e)) return true;
                      if (e.key === 'Escape') { e.preventDefault(); handleCancelEdit(); return true; }
                      return false;
                    }}
                  />
                </div>
                {/* ★ C6 附件：编辑态附件 tray（复用底部 .attachment-tray/.attachment-chip 样式 + 行为接 editAtt）。 */}
                {editAtt.pending.length > 0 && (
                  <div className="attachment-tray">
                    {editAtt.pending.map(att => (
                      <button key={att.id} className={`attachment-chip status-${att.status} kind-${att.kind}`} title={att.error || `${att.name} · ${formatBytes(att.size)}`}>
                        {att.kind === 'image' && att.previewUrl ? (
                          <img src={att.previewUrl} alt={att.name} />
                        ) : (
                          <span className="attachment-icon">{att.kind === 'document' ? '📄' : att.kind === 'archive' ? '🗜' : '📎'}</span>
                        )}
                        <span className="attachment-meta"><strong>{att.name}</strong><small>{att.error || formatBytes(att.size)}</small></span>
                        <span className="attachment-remove" role="button" tabIndex={0}
                          onClick={(e) => { e.stopPropagation(); editAtt.remove(att.id); }}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); editAtt.remove(att.id); } }}
                          aria-label="移除附件">×</span>
                      </button>
                    ))}
                  </div>
                )}
                <input ref={editFileInputRef} type="file" multiple hidden onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length) void editAtt.addFiles(fs, 'file'); e.target.value = ''; }} />
                <input ref={editImageInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length) void editAtt.addFiles(fs, 'image'); e.target.value = ''; }} />
                <div className="message-edit-actions">
                  <button className="edit-btn attach" onClick={() => editFileInputRef.current?.click()} title="附加文件">📎</button>
                  <button className="edit-btn attach" onClick={() => editImageInputRef.current?.click()} title="附加图片">🖼</button>
                  <button className="edit-btn save" onClick={handleSubmitEdit}>保存并重新发送</button>
                  <button className="edit-btn cancel" onClick={handleCancelEdit}>取消</button>
                </div>
              </div>
            ) : (
              // ★ M6 验收 bug6：已发 user 消息复用 buildRichParts 把 @ 占位还原成只读高亮 chip（与编辑态口径一致）。
              //   只读：不加 contentEditable/data-token（避免被任何编辑逻辑误判）；旧消息无 richTokens 时降级为整段纯文本。
              <p className="message-text">
                {buildRichParts(content, richTokens).map((part, i) =>
                  typeof part === 'string'
                    ? part
                    : (
                      <span key={i} className={`rt-token rt-token-${part.type} rt-token-readonly`}>
                        {'@' + (part.displayLabel ?? part.value)}
                      </span>
                    )
                )}
              </p>
            )
          ) : workflowRunId ? (
            // ★ M3-3a：工作流汇总消息——实时四色卡片为主视图，纯文本汇总折叠为 fallback。
            //   WorkflowCard 在 runId 查不到运行实例时返回 null（重启后运行态已清空），此时仅显示文本汇总。
            <div className="message-workflow">
              <WorkflowCard runId={workflowRunId} />
              {content && (
                <div className="message-workflow-summary">
                  <button
                    className="thinking-toggle"
                    onClick={() => setWorkflowSummaryOpen(open => !open)}
                  >
                    {workflowSummaryOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span>文本汇总</span>
                  </button>
                  {workflowSummaryOpen && (
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkMath]}
                      rehypePlugins={[rehypeKatex]}
                    >
                      {content}
                    </ReactMarkdown>
                  )}
                </div>
              )}
            </div>
          ) : content ? (
            // ★ M6 验收 C2c 调整：流式期照常渲染 markdown（不再降级纯文本），降频靠 agentLoop flush 节流(~200ms)
            //   控制——主人要的是「降低渲染频率」而非「不渲染」。流式期文字带格式、每 ~200ms 刷一批。
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              components={{
                code({ className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || '');
                  const lang = match?.[1];
                  const childStr = String(children).replace(/\n$/, '');

                  // Mermaid diagrams ——★ M7 P0-3「该渲染就渲染」：块已闭合(content 里有结束 fence)即渲染，
                  //   即使整条消息还在流式；只有正在书写的最后那个未闭合块 pending=显加载占位。
                  if (lang === 'mermaid') {
                    const closed = !isStreaming || isMermaidFenceClosed(deferredContent, childStr);
                    return <MermaidBlock code={childStr} pending={!closed} />;
                  }

                  const isBlock = match || (typeof children === 'string' && children.includes('\n'));
                  if (isBlock) {
                    return (
                      <div className="code-block">
                        <div className="code-block-header">
                          <span className="code-lang">{lang || 'code'}</span>
                          <button
                            className="code-copy-btn"
                            onClick={() => navigator.clipboard.writeText(childStr)}
                          >
                            <Copy size={12} /> 复制
                          </button>
                        </div>
                        <pre><code className={className} {...props}>{children}</code></pre>
                      </div>
                    );
                  }
                  return <code className="inline-code" {...props}>{children}</code>;
                },
              }}
            >
              {deferredContent}
            </ReactMarkdown>
          ) : (
            <span className="message-placeholder">{live && showGeneratingPlaceholder ? '思考中...' : live ? '' : '无内容'}</span>
          )}
          {isStreaming && showStreamCursor && <span className="cursor-blink">▊</span>}
        </div>

        {attachments && attachments.length > 0 && (
          <div className="message-attachments">
            {attachments.map(att => {
              // ★ M4-3-S3：可点开判定——非 error 且有解析途径（sha256 内容寻址 / 内存态 payloadUrl / 图片预览）。
              const openable = !!onOpenAttachment && att.status !== 'error'
                && !att.error && !!(att.sha256 || att.payloadUrl || att.previewUrl);
              const handleOpen = () => { if (openable) onOpenAttachment?.(att); };
              return (
                <div
                  key={att.id}
                  className={`message-attachment kind-${att.kind} status-${att.status}${openable ? ' clickable' : ''}`}
                  title={att.error || att.name}
                  role={openable ? 'button' : undefined}
                  tabIndex={openable ? 0 : undefined}
                  onClick={openable ? handleOpen : undefined}
                  onKeyDown={openable ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleOpen(); }
                  } : undefined}
                >
                  {att.kind === 'image' && att.previewUrl ? (
                    <img src={att.previewUrl} alt={att.name} />
                  ) : (
                    <span className="message-attachment-icon">{att.kind === 'document' ? '📄' : att.kind === 'archive' ? '🗜' : '📎'}</span>
                  )}
                  <span className="message-attachment-name">{att.name}</span>
                  <small>{att.error || formatBytes(att.size)}</small>
                </div>
              );
            })}
          </div>
        )}

        {diffs && diffs.length > 0 && (
          <div className="message-file-changes">
            {diffs.map(diff => {
              const Icon = changeIcon(diff.changeType);
              const fileName = diff.path.split(/[\\/]/).pop() || diff.path;
              return (
                <button
                  key={diff.id}
                  className={`file-change-chip status-${diff.status}`}
                  onClick={() => onOpenDiff?.(diff)}
                  title={diff.path}
                >
                  <Icon size={14} />
                  <span>{changeLabel(diff.changeType)}</span>
                  <strong>{fileName}</strong>
                  <span className="diff-add">+{diff.additions}</span>
                  <span className="diff-del">-{diff.deletions}</span>
                </button>
              );
            })}
            <button className="review-changes-btn" onClick={onReviewChanges}>
              <ListChecks size={14} />
              Review Changes
            </button>
          </div>
        )}

        {/* Tool Call Cards */}
        {toolCalls && toolCalls.length > 0 && (
          <div className="tool-calls-container">
            {toolCalls.map((tc) => (
              <ToolCallCard key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          items={messageMenuItems}
          position={contextMenu}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}

// ★ M6 验收 bug4 性能：React.memo 包裹——流式时整个消息列表会重渲，但绝大多数历史气泡 props 引用稳定
//   （content/thinking/toolCalls 等从 Redux 取、回调 useCallback、attachments 由 AgentPanel useMemo 缓存），
//   memo 浅比较命中 → 只重渲「正在生成的那一条」，历史 N 条不再陪跑。这是消掉「30 帧」感受的最大单点。
export const MessageBubble = memo(MessageBubbleImpl);

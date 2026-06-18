import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Copy, Check, User, Bot, Wrench, MessageSquare, Pencil, RefreshCw, Trash2, FilePlus, FilePenLine, FileX2, ListChecks, Undo2, GitBranch, ChevronDown, ChevronRight } from 'lucide-react';
import { useState, useCallback, useEffect, useRef } from 'react';
import { ToolCallCard } from './ToolCallCard';
import { WorkflowCard } from './WorkflowCard';
import { ContextMenu, type MenuItem } from '@/components/ui/ContextMenu';
import { useResolvedTheme } from '@/hooks/useResolvedTheme';

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
  onEdit?: (id: string, newContent: string) => void;
  onRetry?: (id: string) => void;
  onDelete?: (id: string) => void;
  // M2-3 对话分支：从该消息处「从此分支」，把该消息及之前另存为新对话（源对话不变）。
  onBranch?: (id: string) => void;
}

// Mermaid renderer component
function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');
  // ★ 浅色适配：mermaid 图表主题跟随 app 主题（之前写死 dark，浅色模式下图表深色突兀）。
  const resolvedTheme = useResolvedTheme();

  useEffect(() => {
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
          themeVariables: isLight
            ? { primaryColor: '#7c3aed', primaryTextColor: '#111827', lineColor: '#64748b', secondaryColor: '#eef1f7', tertiaryColor: '#f6f7fb' }
            : { primaryColor: '#8b5cf6', primaryTextColor: '#e2e8f0', lineColor: '#64748b', secondaryColor: '#1e293b', tertiaryColor: '#0f172a' },
        });
        const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const { svg: rendered } = await mermaid.render(id, code);
        if (!cancelled) setSvg(DOMPurify.sanitize(rendered, { USE_PROFILES: { svg: true } }));
      } catch (e: any) {
        if (!cancelled) setError(e.message || 'Mermaid 渲染失败');
      }
    })();
    return () => { cancelled = true; };
  }, [code, resolvedTheme]);

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

export function MessageBubble({ id, role, content, timestamp, model, isStreaming, streamState, streamMode, fallbackReason, showStreamCursor = true, showGeneratingPlaceholder = true, durationMs, reconnect, endToEndMs, thinking, attachments, toolCalls, diffs, workflowRunId, onReviewChanges, onOpenDiff, onOpenAttachment, onUndoToMessage, onEdit, onRetry, onDelete, onBranch }: MessageProps) {
  const [copied, setCopied] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(content);
  const [thinkingOpen, setThinkingOpen] = useState(!thinking?.collapsed);
  // ★ M3-3a：工作流卡片消息默认折叠纯文本汇总（卡片是主视图，文本汇总作为可展开 fallback）。
  const [workflowSummaryOpen, setWorkflowSummaryOpen] = useState(false);
  // ★ M5-1 压缩归一：原 role==='system' 压缩摘要卡片的折叠 state 已删除（不再渲染 system 摘要卡片）。
  const [now, setNow] = useState(() => Date.now());
  const editRef = useRef<HTMLTextAreaElement>(null);
  const live = isStreaming || streamState === 'pending' || streamState === 'streaming';
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
    setEditContent(content);
    setIsEditing(true);
    setTimeout(() => editRef.current?.focus(), 50);
  }, [content]);

  const handleSubmitEdit = useCallback(() => {
    if (editContent.trim() && editContent !== content) {
      onEdit?.(id, editContent.trim());
    }
    setIsEditing(false);
  }, [id, editContent, content, onEdit]);

  const handleCancelEdit = useCallback(() => {
    setIsEditing(false);
    setEditContent(content);
  }, [content]);

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
                <textarea
                  ref={editRef}
                  className="message-edit-input"
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmitEdit(); }
                    if (e.key === 'Escape') handleCancelEdit();
                  }}
                  rows={Math.min(editContent.split('\n').length + 1, 8)}
                />
                <div className="message-edit-actions">
                  <button className="edit-btn save" onClick={handleSubmitEdit}>保存并重新发送</button>
                  <button className="edit-btn cancel" onClick={handleCancelEdit}>取消</button>
                </div>
              </div>
            ) : (
              <p>{content}</p>
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
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              components={{
                code({ className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || '');
                  const lang = match?.[1];
                  const childStr = String(children).replace(/\n$/, '');

                  // Mermaid diagrams
                  if (lang === 'mermaid') {
                    return <MermaidBlock code={childStr} />;
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
              {content}
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

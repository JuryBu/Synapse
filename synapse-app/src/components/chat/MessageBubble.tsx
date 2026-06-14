import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Copy, Check, User, Bot, Wrench, MessageSquare, Pencil, RefreshCw, Trash2, FilePlus, FilePenLine, FileX2, ListChecks, Undo2, ChevronDown, ChevronRight } from 'lucide-react';
import { useState, useCallback, useEffect, useRef } from 'react';
import { ToolCallCard } from './ToolCallCard';
import { ContextMenu, type MenuItem } from '@/components/ui/ContextMenu';

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
  thinking?: ThinkingInfo;
  attachments?: AttachmentInfo[];
  toolCalls?: ToolCallInfo[];
  diffs?: FileDiffInfo[];
  onReviewChanges?: () => void;
  onOpenDiff?: (diff: FileDiffInfo) => void;
  onUndoToMessage?: (id: string) => void;
  onEdit?: (id: string, newContent: string) => void;
  onRetry?: (id: string) => void;
  onDelete?: (id: string) => void;
}

// Mermaid renderer component
function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        const DOMPurify = (await import('dompurify')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          securityLevel: 'strict', // P1-2: 防止 SVG 注入
          themeVariables: {
            primaryColor: '#8b5cf6',
            primaryTextColor: '#e2e8f0',
            lineColor: '#64748b',
            secondaryColor: '#1e293b',
            tertiaryColor: '#0f172a',
          }
        });
        const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const { svg: rendered } = await mermaid.render(id, code);
        if (!cancelled) setSvg(DOMPurify.sanitize(rendered, { USE_PROFILES: { svg: true } }));
      } catch (e: any) {
        if (!cancelled) setError(e.message || 'Mermaid 渲染失败');
      }
    })();
    return () => { cancelled = true; };
  }, [code]);

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

function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function formatBytes(bytes?: number): string {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function MessageBubble({ id, role, content, timestamp, model, isStreaming, streamState, streamMode, fallbackReason, showStreamCursor = true, showGeneratingPlaceholder = true, durationMs, thinking, attachments, toolCalls, diffs, onReviewChanges, onOpenDiff, onUndoToMessage, onEdit, onRetry, onDelete }: MessageProps) {
  const [copied, setCopied] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(content);
  const [thinkingOpen, setThinkingOpen] = useState(!thinking?.collapsed);
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
    ...(role === 'assistant' ? [{
      label: '重新生成',
      icon: <RefreshCw size={14} />,
      shortcut: 'R',
      onClick: () => onRetry?.(id),
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
            {!isUser && !isStreaming && onRetry && (
              <button className="message-action-btn" onClick={() => onRetry(id)} title="重新生成">
                <RefreshCw size={12} />
              </button>
            )}
            {!isStreaming && onDelete && (
              <button className="message-action-btn danger" onClick={() => onDelete(id)} title="删除">
                <Trash2 size={12} />
              </button>
            )}
            {!isStreaming && onUndoToMessage && (
              <button className="message-action-btn" onClick={() => onUndoToMessage(id)} title="回溯到此消息">
                <Undo2 size={12} />
              </button>
            )}
          </div>
        </div>
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
            {attachments.map(att => (
              <div key={att.id} className={`message-attachment kind-${att.kind} status-${att.status}`} title={att.error || att.name}>
                {att.kind === 'image' && att.previewUrl ? (
                  <img src={att.previewUrl} alt={att.name} />
                ) : (
                  <span className="message-attachment-icon">{att.kind === 'document' ? '📄' : att.kind === 'archive' ? '🗜' : '📎'}</span>
                )}
                <span className="message-attachment-name">{att.name}</span>
                <small>{att.error || formatBytes(att.size)}</small>
              </div>
            ))}
          </div>
        )}

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

import { useState, useCallback } from 'react';
import { ChevronRight, ChevronDown, Wrench, Check, X, Loader2, Copy, Clock } from 'lucide-react';

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
  status: 'pending' | 'running' | 'success' | 'error';
  result?: string;
  executionTime?: number; // ms
}

interface ToolCallCardProps {
  toolCall: ToolCall;
}

const MAX_RESULT_PREVIEW = 500;

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [resultExpanded, setResultExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  let parsedArgs: Record<string, any> = {};
  try {
    parsedArgs = JSON.parse(toolCall.arguments);
  } catch { /* ignore */ }

  const handleCopyResult = useCallback(() => {
    if (toolCall.result) {
      navigator.clipboard.writeText(toolCall.result);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [toolCall.result]);

  // ★ FIX-13 兜底：历史对话里旧 toolCall 已落库为 pending（工具早执行完但当时没回写），或任何漏回写边界——
  //   只要 status 仍为 pending/running 却已有 result（说明实际已完成），就视作 success，避免「执行完还在转圈」。
  //   新执行路径已由 agentLoop 正确回写 success/error，本兜底只覆盖历史数据与边界。
  const effectiveStatus = (toolCall.status === 'pending' || toolCall.status === 'running') && toolCall.result
    ? 'success'
    : toolCall.status;

  const statusIcon = {
    pending: <Loader2 size={14} className="tool-status-icon spinning" />,
    running: <Loader2 size={14} className="tool-status-icon spinning" />,
    success: <Check size={14} className="tool-status-icon success" />,
    error: <X size={14} className="tool-status-icon error" />,
  }[effectiveStatus];

  const statusColor = {
    pending: 'var(--syn-text-muted)',
    running: 'var(--syn-accent)',
    success: '#22c55e',
    error: '#ef4444',
  }[effectiveStatus];

  const resultText = toolCall.result || '';
  const isLongResult = resultText.length > MAX_RESULT_PREVIEW;
  const displayResult = resultExpanded ? resultText : resultText.slice(0, MAX_RESULT_PREVIEW);

  return (
    <div className="tool-call-card" style={{ borderLeftColor: statusColor }}>
      <button className="tool-call-header" onClick={() => setExpanded(!expanded)}>
        <span className="tool-call-chevron">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <Wrench size={14} className="tool-call-icon" />
        <span className="tool-call-name">{toolCall.name}</span>
        <span className="tool-call-args-preview">
          {Object.entries(parsedArgs).slice(0, 2).map(([k, v]) => 
            `${k}=${typeof v === 'string' ? v.slice(0, 20) : v}`
          ).join(', ')}
        </span>
        <span className="tool-call-status-group">
          {toolCall.executionTime !== undefined && (
            <span className="tool-call-time">
              <Clock size={10} />
              {toolCall.executionTime < 1000
                ? `${toolCall.executionTime}ms`
                : `${(toolCall.executionTime / 1000).toFixed(1)}s`}
            </span>
          )}
          {statusIcon}
        </span>
      </button>
      
      {expanded && (
        <div className="tool-call-body">
          <div className="tool-call-section">
            <div className="tool-call-label">参数</div>
            <pre className="tool-call-code">
              {JSON.stringify(parsedArgs, null, 2)}
            </pre>
          </div>
          {toolCall.result && (
            <div className="tool-call-section">
              <div className="tool-call-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>结果</span>
                <button className="tool-copy-btn" onClick={handleCopyResult} title="复制结果">
                  {copied ? <Check size={10} /> : <Copy size={10} />}
                </button>
              </div>
              <pre className="tool-call-code tool-call-result">
                {displayResult}
                {isLongResult && !resultExpanded && '...'}
              </pre>
              {isLongResult && (
                <button className="tool-expand-btn" onClick={() => setResultExpanded(!resultExpanded)}>
                  {resultExpanded ? '收起' : `展开全部 (${resultText.length} 字符)`}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

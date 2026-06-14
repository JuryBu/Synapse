import { useMemo } from 'react';
import { isElectron } from '@platform/index';
import { useAppSelector } from '@/store/hooks';
import { Wifi, Zap } from 'lucide-react';
import { countConversationTokens } from '@/services/systemPrompt';

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function StatusBar() {
  const messages = useAppSelector((s) => s.conversation.messages);
  const model = useAppSelector((s) => s.agentSettings.currentModel);
  const isStreaming = useAppSelector((s) => s.conversation.isStreaming);
  const apiTokenCount = useAppSelector((s) => s.conversation.tokenCount);
  const tokenUsage = useAppSelector((s) => s.conversation.tokenUsage);
  const apiKey = useAppSelector((s) => s.settings.apiKeys?.openai);
  const connectionStatus = useAppSelector((s) => s.agentSettings.connectionStatus);

  const estimatedTokenCount = useMemo(() => {
    return countConversationTokens(messages.map(m => ({ role: m.role, content: m.content })));
  }, [messages]);
  const tokenCount = apiTokenCount || estimatedTokenCount;

  // Model context window sizes (rough)
  const contextWindow = useMemo(() => {
    const currentModel = model || '';
    if (currentModel.includes('gpt-4')) return 128000;
    if (currentModel.includes('gpt-3.5')) return 16000;
    if (currentModel.includes('deepseek')) return 64000;
    if (currentModel.includes('claude')) return 200000;
    return 128000;
  }, [model]);

  const usage = tokenCount / contextWindow;
  const usageColor = usage > 0.8 ? 'var(--syn-error)' : usage > 0.5 ? 'var(--syn-warning)' : 'var(--syn-success)';
  const hasApiKey = !!apiKey;
  const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;

  const connectionLabel = !isOnline
    ? '离线'
    : !hasApiKey
      ? '未配置 API'
      : connectionStatus === 'checking'
        ? '检测中…'
        : connectionStatus === 'failed'
          ? '连接失败'
          : '已配置';
  const connectionColor = !isOnline
    ? 'var(--syn-error)'
    : !hasApiKey
      ? 'var(--syn-text-muted)'
      : connectionStatus === 'failed'
        ? 'var(--syn-error)'
        : connectionStatus === 'checking'
          ? 'var(--syn-warning)'
          : 'var(--syn-success)';

  return (
    <div className="status-bar glass-panel">
      <div className="status-bar-left">
        <span className="status-item">
          {isElectron ? '🖥 Electron' : '🌐 Web'}
        </span>
        <span className="status-item">
          <span>{model || '未选择模型'}</span>
        </span>
        {isStreaming && (
          <span className="status-item status-streaming">
            <Zap size={12} style={{ color: 'var(--syn-primary)' }} />
            <span>生成中...</span>
          </span>
        )}
      </div>
      <div className="status-bar-right">
        <span
          className="status-item"
          title={tokenUsage
            ? `API 用量: prompt ${tokenUsage.promptTokens}, completion ${tokenUsage.completionTokens}, total ${tokenUsage.totalTokens}`
            : `估算已用 ${tokenCount} / 上下文窗口 ${formatTokens(contextWindow)}`}
        >
          <span style={{ color: usageColor }}>●</span>
          Token: {formatTokens(tokenCount)} / {formatTokens(contextWindow)}
        </span>
        <span className="status-item">
          <Wifi size={12} style={{ color: connectionColor }} />
          <span>{connectionLabel}</span>
        </span>
        <span className="status-item status-version">Synapse v0.1.0</span>
      </div>
    </div>
  );
}

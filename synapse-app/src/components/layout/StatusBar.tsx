import { useMemo } from 'react';
import { isElectron } from '@platform/index';
import { useAppSelector } from '@/store/hooks';
import { Wifi, Zap } from 'lucide-react';
import { countConversationTokensExact } from '@/services/tokenizer';
import { getModelContextWindow } from '@/store/selectors/modelSelectors';
import { CompressionRing } from './CompressionRing';

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function StatusBar() {
  const messages = useAppSelector((s) => s.conversation.messages);
  const model = useAppSelector((s) => s.agentSettings.currentModel);
  const isStreaming = useAppSelector((s) => s.conversation.isStreaming);
  const tokenUsage = useAppSelector((s) => s.conversation.tokenUsage);
  const apiKey = useAppSelector((s) => s.settings.apiKeys?.openai);
  const connectionStatus = useAppSelector((s) => s.agentSettings.connectionStatus);
  // M4-1-S3：上下文窗口统一走 selector（capabilities.contextWindow ?? option.contextWindow ?? MAX_CONTEXT_TOKENS），
  // 替代此前「模型名 includes('gpt-4') → 128000」硬编码映射（机制错：换模型/真有 context 字段时会偏）。
  const contextWindow = useAppSelector(getModelContextWindow);

  // ★ M6 验收 bug7：本地 token 计数——gpt 系模型用 gpt-tokenizer o200k_base 精确 encode，非 gpt 字符估算（exact 标志）。
  //   useMemo 缓存（仅 messages/model 变时重算），避免流式每帧 encode 整对话。
  const localToken = useMemo(() => {
    return countConversationTokensExact(messages.map(m => ({ role: m.role, content: m.content })), model);
  }, [messages, model]);
  // M4-1-S3（openQuestions 4 决议）：「已用 token」与「上下文窗口」分母同口径（纯输入侧）。
  //   有 API 实测时优先 tokenUsage.promptTokens（纯输入，恒精确）；无实测时回退本地 localToken（gpt 系精确 / 其它估算）。
  const hasApiUsage = !!tokenUsage;
  const tokenCount = hasApiUsage ? tokenUsage!.promptTokens : localToken.count;
  // 当前 token 数是否精确：API 实测恒精确；否则取决于本地分词器（gpt 系精确 / 非 gpt 估算）。
  const tokenExact = hasApiUsage ? true : localToken.exact;

  const usage = tokenCount / contextWindow;
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
          title={hasApiUsage
            ? `精确·API 实测已用(prompt) ${tokenUsage!.promptTokens} / 上下文窗口 ${formatTokens(contextWindow)}`
              + `（completion ${tokenUsage!.completionTokens}, total ${tokenUsage!.totalTokens}）`
            : `${tokenExact ? '精确·分词器' : '≈估算·非 gpt 模型'} 已用 ${tokenCount} / 上下文窗口 ${formatTokens(contextWindow)}`}
        >
          {/* ★ M5-BPC-6：StatusBar token 区同步 CompressionRing（inline + showDot 保留健康度状态点）。 */}
          {/* ★ M6 验收 bug7：exact 透传给 CompressionRing，估算态（非 gpt 模型）token 前缀 ≈。 */}
          <CompressionRing
            variant="inline"
            tokenCount={tokenCount}
            effectiveContextWindow={contextWindow}
            tokenRatio={usage}
            showDot
            exact={tokenExact}
          />
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

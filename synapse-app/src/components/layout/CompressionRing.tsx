/**
 * CompressionRing —— Plan_5 M5-BPC PhaseC（BPC-6）后台预压缩状态环。
 *
 * 定位：把 footer / context tab / StatusBar 三处原本各自写死的「Token: x/y (z%)」纯文本，统一收敛成一个
 *   订阅 bpc slice 的状态组件。idle 时维持原样（红黄灰分级 token%），BPC 后台活跃时切成「状态环 + 文案
 *   [+ 操作按钮]」，让用户看得见后台预压缩在跑、可中止、熔断了能重启。
 *
 * 数据流（决策②单向桥）：bpcScheduler 状态机迁移 → dispatch bpc slice → 本组件 useAppSelector 订阅渲染；
 *   仅中止 / 重启两个按钮反向调 bpcScheduler.abort() / restart()（其余纯订阅，不直接读 scheduler 内存）。
 *
 * variant：
 *   - 'full'（footer 主入口）：活跃态显环 + 文案 + 暗色 token + 中止×/重启↻ 按钮；idle/活跃均可点击打开
 *     本对话 BPC/硬压缩 override 浮层（onConfigClick，CC 式「每对话可调」）。
 *   - 'inline'（context tab / StatusBar）：活跃态显环 + 文案（无按钮、不可点，省空间）。
 * showDot：StatusBar 专用——idle 态在 token 文本前置一个健康度状态点（保留 StatusBar 原 ● 语义）。
 */

import { useEffect, useState } from 'react';
import { useAppSelector } from '@/store/hooks';
import type { RootState } from '@/store';
import { bpcScheduler } from '@/services/bpcScheduler';
import { X, RotateCw } from 'lucide-react';

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

interface Props {
  tokenCount: number;
  effectiveContextWindow: number;
  tokenRatio: number;
  variant?: 'full' | 'inline';
  /** StatusBar 用：idle 态前置健康度状态点（绿/黄/红），保留 StatusBar 原 ● 语义。 */
  showDot?: boolean;
  /** ★ 验收新增：full（footer）点击打开本对话 BPC/硬压缩 override 浮层（CC 式每对话可调）。仅 full variant 生效。 */
  onConfigClick?: () => void;
}

export function CompressionRing({
  tokenCount,
  effectiveContextWindow,
  tokenRatio,
  variant = 'full',
  showDot = false,
  onConfigClick,
}: Props) {
  const bpc = useAppSelector((s: RootState) => s.bpc);
  const [, tick] = useState(0);

  // cooldown 倒计时：仅冷却态每 30s 刷新一次「冷却中 Nm」显示（惰性，不冷却时不开定时器）。
  useEffect(() => {
    if (bpc.state !== 'cooldown' || !bpc.cooldownUntil) return;
    const t = setInterval(() => tick(n => n + 1), 30000);
    return () => clearInterval(t);
  }, [bpc.state, bpc.cooldownUntil]);

  const isFull = variant === 'full';
  const clickable = isFull && !!onConfigClick;
  const pct = Math.round(tokenRatio * 100);
  const tokenText = `Token: ${fmt(tokenCount)} / ${fmt(effectiveContextWindow)} (${pct}%)`;
  // 文本分级（footer/context）：低水位灰；圆点分级（StatusBar）：低水位绿（保留健康语义）。
  const textColor = tokenRatio > 0.8 ? 'var(--syn-error)' : tokenRatio > 0.5 ? 'var(--syn-warning)' : 'var(--syn-text-muted)';
  const dotColor = tokenRatio > 0.8 ? 'var(--syn-error)' : tokenRatio > 0.5 ? 'var(--syn-warning)' : 'var(--syn-success)';

  // ── idle / aborted（瞬态）→ 常规 token 文本（full 可点击打开本对话 override 浮层） ──
  if (bpc.state === 'idle' || bpc.state === 'aborted') {
    if (showDot) {
      return (
        <span className="token-counter">
          <span className="cr-dot-static" style={{ background: dotColor }} />
          {tokenText}
        </span>
      );
    }
    return (
      <span
        className={`token-counter${clickable ? ' cr-clickable' : ''}`}
        style={{ color: textColor }}
        onClick={clickable ? onConfigClick : undefined}
        title={clickable ? '点击调整本对话 BPC / 硬压缩阈值（留空=用全局默认）' : undefined}
        role={clickable ? 'button' : undefined}
      >
        {tokenText}
      </span>
    );
  }

  // ── 活跃态映射 ──
  let label = '';
  let spinning = false;
  let tone = 'var(--syn-text-muted)';
  let showAbort = false;
  let showRestart = false;

  switch (bpc.state) {
    case 'snapshotting':
      label = '准备压缩…'; spinning = true; tone = 'var(--syn-accent)'; showAbort = isFull; break;
    case 'generating':
      label = '后台压缩中'; spinning = true; tone = 'var(--syn-accent)'; showAbort = isFull; break;
    case 'ready':
      label = '压缩就绪'; tone = 'var(--syn-success)'; break;
    case 'replacing':
      label = '替换中…'; spinning = true; tone = 'var(--syn-accent)'; break;
    case 'cooldown': {
      const remain = (bpc.cooldownUntil ?? 0) - Date.now();
      label = `冷却中 ${Math.max(0, Math.ceil(remain / 60000))}m`; tone = 'var(--syn-text-muted)'; break;
    }
    case 'circuit-broken':
      label = 'BPC 已停'; tone = 'var(--syn-error)'; showRestart = isFull; break;
    default:
      label = '';
  }

  return (
    <span
      className={`compression-ring ${isFull ? 'cr-full' : 'cr-inline'}${clickable ? ' cr-clickable' : ''}`}
      style={{ color: tone }}
      title={`${tokenText}｜后台预压缩：${label}${clickable ? '（点击调本对话阈值）' : ''}`}
      onClick={clickable ? onConfigClick : undefined}
      role={clickable ? 'button' : undefined}
    >
      <span className={`cr-ring ${spinning ? 'cr-spin' : ''}`} style={{ borderTopColor: tone }} />
      <span className="cr-label">{label}</span>
      {isFull && <span className="cr-token-dim">{tokenText}</span>}
      {showAbort && (
        <button type="button" className="cr-btn" title="中止后台压缩（进入冷却期）" onClick={(e) => { e.stopPropagation(); bpcScheduler.abort(); }}>
          <X size={12} />
        </button>
      )}
      {showRestart && (
        <button type="button" className="cr-btn" title="重启后台预压缩" onClick={(e) => { e.stopPropagation(); bpcScheduler.restart(); }}>
          <RotateCw size={12} />
        </button>
      )}
    </span>
  );
}

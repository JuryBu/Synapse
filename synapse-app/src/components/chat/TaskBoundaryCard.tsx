/**
 * ★ task_boundary 展示卡片（Plan_5 §10）。
 *
 * 把一个【任务边界 TaskBoundary】渲染成对话流里的卡片（仿 WorkflowCard 的状态色 + 可展开收叠范式）：
 *   ① 顶部行：状态色圆点（active 脉冲）+ headline 大标题（粗体）+ 右侧「历史」按钮（lucide History）。
 *   ② headline 下方：summary 概括（次要色，一行）。
 *   ③ 可展开收叠的 steps 进度区（默认收叠；标题「进度 N 步」，展开后每步：序号 + text + 相对时间）。
 *   ④ 状态色：active → 主色 --syn-primary（脉冲）/ done → 绿 #22c55e / aborted → 红 #ef4444。
 *
 * ★ 历史变迁浮层（比 Antigravity 多做的「历史标题概括变迁」时间线）：点「历史」按钮 → createPortal 到
 *   body 的 glass-panel 浮层（仿 ContextMenu），列 boundary.history 倒序时间线，每条 headline（粗）+
 *   summary（次要）+ 相对时间。点浮层外 / Esc 关闭。
 *
 * 纯展示组件：只吃 props.boundary，不订阅 store、不 dispatch（接入由主线负责）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { History, ChevronDown, ChevronRight, Clock } from 'lucide-react';
import type { TaskBoundary } from '@/store/slices/conversation';

interface TaskBoundaryCardProps {
  boundary: TaskBoundary;
}

/** 状态 → 强调色 + 文案（active 主色 / done 绿 / aborted 红）。 */
function statusMeta(status: TaskBoundary['status']): { color: string; label: string } {
  switch (status) {
    case 'active': return { color: 'var(--syn-primary)', label: '进行中' };
    case 'done': return { color: '#22c55e', label: '已完成' };
    case 'aborted': return { color: '#ef4444', label: '已中止' };
    default: return { color: 'var(--syn-text-muted)', label: status };
  }
}

/**
 * 相对时间（内联小函数，不引第三方）：刚刚 / N 分钟前 / N 小时前 / 具体日期时间。
 *   超过 24 小时退化为「M月D日 HH:mm」绝对时间（跨天后相对值无意义）。
 */
function relativeTime(timestamp: number, now: number): string {
  const diff = Math.max(0, now - timestamp);
  const sec = Math.floor(diff / 1000);
  if (sec < 30) return '刚刚';
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

/** 历史变迁浮层：createPortal 到 body 的 glass-panel，倒序时间线，点外 / Esc 关闭。 */
function HistoryOverlay({ history, now, onClose }: {
  history: TaskBoundary['history'];
  now: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (ref.current && !ref.current.contains(e.target as Node)) onClose();
  }, [onClose]);

  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => {
    // mousedown 捕获「点外关闭」；keydown 捕获 Esc。
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [handleClickOutside, handleKey]);

  // 倒序（最新在上），不可变拷贝后 reverse 避免污染 props。
  const ordered = [...history].reverse();

  return createPortal(
    <div className="task-boundary-history-backdrop">
      <div ref={ref} className="task-boundary-history-overlay glass-panel" role="dialog" aria-label="标题变迁历史">
        <div className="tb-history-header">
          <History size={14} />
          <span className="tb-history-title">标题变迁历史</span>
          <span className="tb-history-count">{history.length} 次</span>
        </div>
        {ordered.length === 0 ? (
          <div className="tb-history-empty">暂无历史记录</div>
        ) : (
          <div className="tb-history-list">
            {ordered.map((entry, i) => (
              <div key={`${entry.timestamp}-${i}`} className="tb-history-entry">
                <span className="tb-history-dot" />
                <div className="tb-history-entry-main">
                  <div className="tb-history-entry-headline">{entry.headline}</div>
                  {entry.summary && <div className="tb-history-entry-summary">{entry.summary}</div>}
                  <div className="tb-history-entry-time">{relativeTime(entry.timestamp, now)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function TaskBoundaryCard({ boundary }: TaskBoundaryCardProps) {
  const [stepsOpen, setStepsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  // ★ active 边界按秒滴答刷新相对时间（与 WorkflowCard 同款；非 active 不开 timer 省开销）。
  //   Date.now() 不在 render 期直接调用（React 纯函数规则），走 state + 定时器。
  const isActive = boundary.status === 'active';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isActive && !historyOpen) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isActive, historyOpen]);

  const meta = statusMeta(boundary.status);
  const stepCount = boundary.steps.length;
  // history 只有 1 条时按钮仍可点（展示初始项）；0 条才禁用。
  const historyDisabled = boundary.history.length === 0;

  return (
    <div className="task-boundary-card" style={{ borderLeftColor: meta.color }}>
      <div className="tb-card-header">
        <span
          className={`tb-card-dot${isActive ? ' pulsing' : ''}`}
          style={{ background: meta.color }}
        />
        <span className="tb-card-headline" title={boundary.headline}>{boundary.headline}</span>
        <span className="tb-card-status" style={{ color: meta.color, borderColor: meta.color }}>
          {meta.label}
        </span>
        <button
          type="button"
          className="tb-card-history-btn"
          onClick={() => setHistoryOpen(true)}
          disabled={historyDisabled}
          title={historyDisabled ? '暂无历史记录' : '查看标题变迁历史'}
        >
          <History size={14} />
          <span>历史</span>
        </button>
      </div>

      {boundary.summary && (
        <div className="tb-card-summary" title={boundary.summary}>{boundary.summary}</div>
      )}

      {stepCount > 0 && (
        <div className="tb-card-steps">
          <button
            type="button"
            className="tb-card-steps-toggle"
            onClick={() => setStepsOpen(o => !o)}
            aria-expanded={stepsOpen}
          >
            {stepsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>进度 {stepCount} 步</span>
          </button>
          {stepsOpen && (
            <ol className="tb-card-steps-list">
              {boundary.steps.map((step, i) => (
                <li key={step.id} className="tb-card-step">
                  <span className="tb-card-step-num">{i + 1}</span>
                  <span className="tb-card-step-text">{step.text}</span>
                  <span className="tb-card-step-time">
                    <Clock size={10} />
                    {relativeTime(step.timestamp, now)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {historyOpen && (
        <HistoryOverlay
          history={boundary.history}
          now={now}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
  );
}

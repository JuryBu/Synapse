/**
 * ★ task_boundary 展示卡片（Plan_5 §10 + M7 第四轮「卡片吞消息」返工）。
 *
 * 仿 Antigravity（反重力）任务卡范式——把【一个任务边界期间的过程】整齐收进一张可折叠卡片，
 * 而非「小卡片 + 消息散落在外」。卡片结构（自上而下）：
 *   ① 头部：状态色圆点（active 脉冲）+ headline 大标题 + 状态徽标 + 「历史」按钮。
 *   ② summary 概括。
 *   ③ 「已编辑文件」区：本边界期间编辑/创建的文件 chips（来自区间消息的 diffs/artifacts），点击直接打开。
 *   ④ 「进度更新」区：steps 进度列表（可折叠，默认展开作概览）。
 *   ⑤ 「完整过程」区：本边界区间内的过程消息（children = MessageBubble 们），可折叠——
 *      active 默认展开（实时看 AI 在干嘛），done/aborted 默认收起（干净，点开看细节）。
 *   ⑥ 历史变迁浮层（比 Antigravity 多做）：点「历史」→ createPortal 列 headline/summary 变迁时间线。
 *
 * 纯展示组件：吃 props（boundary / files / children），不订阅 store；文件点击经 onOpenFile 回调上抛。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { History, ChevronDown, ChevronRight, Clock, FileText, FilePlus, FileMinus } from 'lucide-react';
import type { TaskBoundary } from '@/store/slices/conversation';

/** 卡片聚合展示的「已编辑文件」（由 AgentPanel 从区间消息的 diffs / artifacts 聚合后传入）。 */
export interface BoundaryFile {
  key: string;                                        // 去重键（diff:path / artifact:path）
  path: string;
  label: string;                                      // 显示名（basename）
  kind: 'diff' | 'artifact';
  changeType?: 'created' | 'edited' | 'deleted';
  additions?: number;
  deletions?: number;
  ref: unknown;                                       // 原始 diff/artifact 对象，点击回传给 onOpenFile
}

interface TaskBoundaryCardProps {
  boundary: TaskBoundary;
  files?: BoundaryFile[];
  onOpenFile?: (file: BoundaryFile) => void;
  children?: ReactNode;                               // 区间内的过程消息（MessageBubble 们）
  childCount?: number;                                // 过程消息条数（折叠态显示「展开完整过程 (N条)」）
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

/** 文件 chip 图标：artifact / created / deleted / edited 各异。 */
function fileIcon(f: BoundaryFile) {
  if (f.kind === 'artifact') return <FileText size={12} />;
  if (f.changeType === 'created') return <FilePlus size={12} />;
  if (f.changeType === 'deleted') return <FileMinus size={12} />;
  return <FileText size={12} />;
}

/**
 * 相对时间：刚刚 / N 分钟前 / N 小时前 / 超 24h 退化绝对时间「M月D日 HH:mm」。
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
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [handleClickOutside, handleKey]);

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

export function TaskBoundaryCard({ boundary, files = [], onOpenFile, children, childCount = 0 }: TaskBoundaryCardProps) {
  const isActive = boundary.status === 'active';
  // ★ 过程消息：active 默认展开（实时看 AI 在做什么）；done/aborted 默认收起（卡片干净，点开看细节）。
  const [bodyOpen, setBodyOpen] = useState(isActive);
  const [stepsOpen, setStepsOpen] = useState(true);     // 进度步骤默认展开作概览
  const [historyOpen, setHistoryOpen] = useState(false);

  // ★ active 边界 / 历史浮层开启时按秒滴答刷新相对时间（非 active 不开 timer 省开销）。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isActive && !historyOpen) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isActive, historyOpen]);

  // ★ active → done/aborted 翻转时自动收起过程消息（收口即归整，呼应反重力「完成后折叠成一卡」）。
  const prevActiveRef = useRef(isActive);
  useEffect(() => {
    if (prevActiveRef.current && !isActive) setBodyOpen(false);
    prevActiveRef.current = isActive;
  }, [isActive]);

  const meta = statusMeta(boundary.status);
  const stepCount = boundary.steps.length;
  const historyDisabled = boundary.history.length === 0;
  const hasBody = childCount > 0 && !!children;

  return (
    <div className="task-boundary-card" style={{ borderLeftColor: meta.color }}>
      <div className="tb-card-header">
        <span className={`tb-card-dot${isActive ? ' pulsing' : ''}`} style={{ background: meta.color }} />
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

      {files.length > 0 && (
        <div className="tb-card-files">
          <div className="tb-card-section-label">
            <FileText size={12} />
            <span>已编辑文件</span>
            <span className="tb-card-count">{files.length}</span>
          </div>
          <div className="tb-card-file-chips">
            {files.map(f => (
              <button
                key={f.key}
                type="button"
                className="tb-card-file-chip"
                onClick={() => onOpenFile?.(f)}
                title={f.path}
              >
                {fileIcon(f)}
                <span className="tb-card-file-name">{f.label}</span>
                {f.kind === 'diff' && (!!f.additions || !!f.deletions) && (
                  <span className="tb-card-file-stat">
                    {f.additions ? <span className="tb-add">+{f.additions}</span> : null}
                    {f.deletions ? <span className="tb-del">-{f.deletions}</span> : null}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {stepCount > 0 && (
        <div className="tb-card-steps">
          <button
            type="button"
            className="tb-card-section-label tb-card-steps-toggle"
            onClick={() => setStepsOpen(o => !o)}
            aria-expanded={stepsOpen}
          >
            {stepsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>进度更新</span>
            <span className="tb-card-count">{stepCount}</span>
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

      {hasBody && (
        <div className="tb-card-body">
          <button
            type="button"
            className="tb-card-body-toggle"
            onClick={() => setBodyOpen(o => !o)}
            aria-expanded={bodyOpen}
          >
            {bodyOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>{bodyOpen ? '收起过程' : '展开完整过程'}</span>
            <span className="tb-card-count">{childCount} 条</span>
          </button>
          {bodyOpen && <div className="tb-card-body-messages">{children}</div>}
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

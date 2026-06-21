/**
 * BpcOverridePopover —— Plan_5 M5-BPC PhaseC 验收补：footer 压缩环点击弹出的【本对话】BPC/硬压缩阈值浮层。
 *
 * CC 式「每个对话可单独调 BPC/硬压缩」入口：读 conversation.bpcThresholdOverride / compactThresholdOverride
 * （本对话覆盖，留空=跟随 agentSettings.bpc 全局默认），滑杆即时 dispatch 覆盖；「恢复全局」清覆盖回 undefined。
 * scheduler.effectiveBpcThreshold / agentLoop.resolveCompactThreshold 已是「本对话覆盖 ?? 全局」口径，本浮层只填 UI。
 */

import { useEffect, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import type { RootState } from '@/store';
import { setBpcThresholdOverride, setCompactThresholdOverride } from '@/store/slices/conversation';
import { DEFAULT_BPC_CONFIG } from '@/store/slices/agentSettings';
import { RotateCcw, X } from 'lucide-react';

interface Props {
  onClose: () => void;
}

export function BpcOverridePopover({ onClose }: Props) {
  const dispatch = useAppDispatch();
  const ref = useRef<HTMLDivElement>(null);
  const bpcCfg = useAppSelector((s: RootState) => s.agentSettings.bpc);
  const bpcOverride = useAppSelector((s: RootState) => s.conversation.bpcThresholdOverride);
  const compactOverride = useAppSelector((s: RootState) => s.conversation.compactThresholdOverride);

  // 点击浮层外 / Esc 关闭（与 model-dropdown 等浮层一致）。
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const globalBpc = bpcCfg?.bpcThreshold ?? DEFAULT_BPC_CONFIG.bpcThreshold;
  const globalCompact = bpcCfg?.compactThreshold ?? DEFAULT_BPC_CONFIG.compactThreshold;
  const bpcVal = bpcOverride ?? globalBpc;
  const compactVal = compactOverride ?? globalCompact;
  const hasOverride = bpcOverride !== undefined || compactOverride !== undefined;

  return (
    <div ref={ref} className="bpc-override-popover glass-panel">
      <div className="bpc-pop-header">
        <span>本对话 · 压缩阈值</span>
        <button type="button" className="bpc-pop-close" title="关闭" onClick={onClose}><X size={14} /></button>
      </div>
      <div className="bpc-pop-row">
        <label>预压触发水位　{bpcOverride !== undefined ? `${Math.round(bpcVal * 100)}%` : `跟随全局 ${Math.round(globalBpc * 100)}%`}</label>
        <input type="range" min="40" max="90" step="1" value={Math.round(bpcVal * 100)}
          onChange={e => dispatch(setBpcThresholdOverride(Number(e.target.value) / 100))} />
      </div>
      <div className="bpc-pop-row">
        <label>硬压缩水位　{compactOverride !== undefined ? `${Math.round(compactVal * 100)}%` : `跟随全局 ${Math.round(globalCompact * 100)}%`}</label>
        <input type="range" min="50" max="95" step="1" value={Math.round(compactVal * 100)}
          onChange={e => dispatch(setCompactThresholdOverride(Number(e.target.value) / 100))} />
      </div>
      <div className="bpc-pop-footer">
        <span className="bpc-pop-hint">仅本对话生效，留空跟随全局</span>
        <button type="button" className="bpc-pop-reset" disabled={!hasOverride}
          onClick={() => { dispatch(setBpcThresholdOverride(undefined)); dispatch(setCompactThresholdOverride(undefined)); }}>
          <RotateCcw size={12} /> 恢复全局
        </button>
      </div>
    </div>
  );
}

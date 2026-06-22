/**
 * ApprovalDialog —— 危险工具审批浮层（替代原生 window.confirm）。
 *
 * 诊断(workflow w0b0hdiwc #4)：run_command / enter_worktree 等工具的审批此前用浏览器原生
 * window.confirm——样式与 app 玻璃拟态不一致、无动画、参数被截断 200 字、同步阻塞。
 * 底层审批机制(toolRegistry.setApprovalCallback)本就是 Promise 化的，这里只替换 UI 端：
 * createPortal 到 body + glass-panel + 进出场动画 + Esc 拒绝 / Enter 同意 / 点遮罩拒绝。
 *
 * 受控组件：request 为 null = 关闭；非 null = 展示该审批请求。父组件(AgentPanel)用一个
 * pending resolve ref 把用户的同意/拒绝回填给 Promise。
 */
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ShieldAlert } from 'lucide-react';

export interface ApprovalRequest {
  toolName: string;
  /** 权限级别：read / write / command / dangerous（来自工具注册的 approvalLevel）。 */
  level: string;
  /** 参数 JSON 文本（完整，不截断；UI 里可滚动）。 */
  argsText: string;
  /** 发起方文案：'AI' 或 '子代理「角色」'。 */
  originLabel: string;
  /** 可选的定制说明（如 enter_worktree 解释会建工作树目录+分支）。有则替代参数代码块展示。 */
  message?: string;
}

interface Props {
  request: ApprovalRequest | null;
  onApprove: () => void;
  onReject: () => void;
}

const LEVEL_META: Record<string, { label: string; cls: string }> = {
  read: { label: '读取', cls: 'read' },
  write: { label: '写入', cls: 'write' },
  command: { label: '命令', cls: 'danger' },
  dangerous: { label: '危险', cls: 'danger' },
};

export function ApprovalDialog({ request, onApprove, onReject }: Props) {
  // Esc = 拒绝，Enter = 同意（仅在弹窗打开时绑定）。
  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onReject(); }
      else if (e.key === 'Enter') { e.preventDefault(); onApprove(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, onApprove, onReject]);

  if (!request) return null;
  const lv = LEVEL_META[request.level] || { label: request.level, cls: 'write' };

  return createPortal(
    <div
      className="approval-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onReject(); }}
    >
      <div className="approval-dialog glass-panel" role="dialog" aria-modal="true">
        <div className="approval-header">
          <ShieldAlert size={18} className="approval-icon" />
          <span className="approval-title">{request.originLabel}请求执行工具</span>
          <span className={`approval-badge ${lv.cls}`}>{lv.label}</span>
        </div>
        <div className="approval-tool">{request.toolName}</div>
        {request.message
          ? <div className="approval-message">{request.message}</div>
          : <pre className="approval-args">{request.argsText}</pre>}
        <div className="approval-actions">
          <button type="button" className="approval-btn reject" onClick={onReject}>拒绝 (Esc)</button>
          <button type="button" className="approval-btn approve" onClick={onApprove} autoFocus>同意 (Enter)</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

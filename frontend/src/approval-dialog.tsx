import { useEffect, useState, type ReactElement } from 'react';
import { explainApproval, secondsLeft } from './approval-model';

export interface ApprovalDialogRequest {
  approval_id: string;
  tool_name: string;
  summary: string;
  input: unknown;
}

/** The backend auto-denies after this long (ApprovalBroker default). The countdown mirrors it. */
export const APPROVAL_TIMEOUT_MS = 120_000;

interface ApprovalDialogProps {
  request: ApprovalDialogRequest;
  onRespond: (approved: boolean) => void;
  now?: () => number;
}

/** Asks the user to approve one irreversible or external action. Declining is the default focus. */
export function ApprovalDialog({ request, onRespond, now = Date.now }: ApprovalDialogProps): ReactElement {
  const [deadline] = useState(() => now() + APPROVAL_TIMEOUT_MS);
  const [remaining, setRemaining] = useState(() => secondsLeft(deadline, now()));
  const explanation = explainApproval(request.tool_name, request.input);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const left = secondsLeft(deadline, now());
      setRemaining(left);
      if (left === 0) window.clearInterval(timer);
    }, 500);
    return () => window.clearInterval(timer);
  }, [deadline, now]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onRespond(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onRespond]);

  const detail = JSON.stringify(request.input, null, 2);
  return (
    <div className="approval-backdrop">
      <div role="alertdialog" aria-modal="true" aria-labelledby="approval-title" aria-describedby="approval-effect" className={`approval-dialog approval-${explanation.risk}`}>
        <div className="approval-head">
          <span className="approval-badge">{explanation.risk === 'high' ? '高风险' : '需注意'}</span>
          <span className="approval-countdown">{remaining} 秒后自动拒绝</span>
        </div>
        <h3 id="approval-title">{explanation.title}</h3>
        <p id="approval-effect" className="approval-effect">{explanation.effect}</p>
        <dl className="approval-facts">
          <dt>工具</dt><dd>{request.tool_name}</dd>
          <dt>可撤销</dt><dd>{explanation.reversible ? '可以（部分）' : '否'}</dd>
        </dl>
        <details className="approval-details">
          <summary>查看参数</summary>
          <pre>{detail}</pre>
        </details>
        <div className="approval-actions">
          <button type="button" className="approval-deny" autoFocus onClick={() => onRespond(false)}>拒绝（Esc）</button>
          <button type="button" className="approval-approve" onClick={() => onRespond(true)}>同意执行</button>
        </div>
      </div>
    </div>
  );
}

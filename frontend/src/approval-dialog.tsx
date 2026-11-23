import { useEffect, useState, type ReactElement } from 'react';
import { explainApproval, secondsLeft, type ApprovalRisk } from './approval-model';

export interface ApprovalDialogRequest {
  approval_id: string;
  tool_name: string;
  summary: string;
  input: unknown;
}

/** The backend auto-denies after this long (ApprovalBroker default). The countdown mirrors it. */
export const APPROVAL_TIMEOUT_MS = 120_000;

/** Hunk list the backend attaches to file-edit approvals. Empty or absent for other tools. */
interface ReviewHunk { id: number; removed: string[]; added: string[] }

function readHunks(input: unknown): ReviewHunk[] {
  const review = (input as { review?: { hunks?: unknown } } | null)?.review;
  if (!review || !Array.isArray(review.hunks)) return [];
  return review.hunks.filter((hunk): hunk is ReviewHunk => typeof hunk?.id === 'number' && Array.isArray(hunk.removed) && Array.isArray(hunk.added));
}

interface ApprovalDialogProps {
  request: ApprovalDialogRequest;
  /** `acceptedHunks` is set only for file edits: the hunk ids the operator kept. */
  onRespond: (approved: boolean, acceptedHunks?: number[]) => void;
  now?: () => number;
  /** Total queued requests, including this one. Batch controls appear when it is above 1. */
  pendingCount?: number;
  onRespondAll?: (approved: boolean) => void;
  /** Highest risk across the whole queue, used for the badge when batching. */
  queueRisk?: ApprovalRisk;
}

/** Asks the user to approve one irreversible or external action. Declining is the default focus. */
export function ApprovalDialog({ request, onRespond, now = Date.now, pendingCount = 1, onRespondAll, queueRisk }: ApprovalDialogProps): ReactElement {
  const [deadline] = useState(() => now() + APPROVAL_TIMEOUT_MS);
  const [remaining, setRemaining] = useState(() => secondsLeft(deadline, now()));
  const explanation = explainApproval(request.tool_name, request.input);
  const hunks = readHunks(request.input);
  const [chosen, setChosen] = useState<number[]>(() => hunks.map((hunk) => hunk.id));
  const batching = pendingCount > 1 && onRespondAll !== undefined;
  const risk = batching && queueRisk ? queueRisk : explanation.risk;

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
      <div role="alertdialog" aria-modal="true" aria-labelledby="approval-title" aria-describedby="approval-effect" className={`approval-dialog approval-${risk}`}>
        <div className="approval-head">
          <span className="approval-badge">{risk === 'high' ? '高风险' : '需注意'}</span>
          <span className="approval-countdown">{remaining} 秒后自动拒绝</span>
        </div>
        {batching && (
          <p className="approval-batch-note">队列中还有 {pendingCount} 条待审批，可一次全部处理。</p>
        )}
        <h3 id="approval-title">{explanation.title}</h3>
        <p id="approval-effect" className="approval-effect">{explanation.effect}</p>
        <dl className="approval-facts">
          <dt>工具</dt><dd>{request.tool_name}</dd>
          <dt>可撤销</dt><dd>{explanation.reversible ? '可以（部分）' : '否'}</dd>
        </dl>
        {hunks.length > 0 && (
          <fieldset className="approval-hunks">
            <legend>改动块（默认全部保留，取消勾选即不写入）</legend>
            {hunks.map((hunk) => (
              <label key={hunk.id} className="approval-hunk">
                <input
                  type="checkbox"
                  checked={chosen.includes(hunk.id)}
                  onChange={(event) => setChosen((current) => event.target.checked ? [...current, hunk.id] : current.filter((id) => id !== hunk.id))}
                />
                <span>第 {hunk.id + 1} 块：删除 {hunk.removed.length} 行，新增 {hunk.added.length} 行</span>
                <pre>{[...hunk.removed.map((line) => `- ${line}`), ...hunk.added.map((line) => `+ ${line}`)].join('\n')}</pre>
              </label>
            ))}
          </fieldset>
        )}
        <details className="approval-details">
          <summary>查看参数</summary>
          <pre>{detail}</pre>
        </details>
        <div className="approval-actions">
          <button type="button" className="approval-deny" autoFocus onClick={() => onRespond(false)}>拒绝（Esc）</button>
          {hunks.length > 0 ? (
            <button type="button" className="approval-approve" disabled={chosen.length === 0} onClick={() => onRespond(chosen.length > 0, [...chosen].sort((a, b) => a - b))}>
              同意所选（{chosen.length}/{hunks.length} 块）
            </button>
          ) : (
            <button type="button" className="approval-approve" onClick={() => onRespond(true)}>同意执行</button>
          )}
        </div>
        {batching && (
          <div className="approval-actions approval-batch-actions">
            <button type="button" className="approval-deny" onClick={() => onRespondAll?.(false)}>全部拒绝（{pendingCount} 条）</button>
            <button type="button" className="approval-approve" onClick={() => onRespondAll?.(true)}>全部同意（{pendingCount} 条）</button>
          </div>
        )}
      </div>
    </div>
  );
}

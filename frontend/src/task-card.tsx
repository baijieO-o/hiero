import type { ReactElement } from 'react';
import { BUDGET_LIMITS, clampBudget, isExecutableCriterion, parseCriteria, type TaskCardBudget } from './task-card-model';

export interface TaskCardSummary {
  goal: string;
  workspace: string;
  model: string;
  permissionLabel: string;
  contextMode: string;
}

interface TaskCardProps {
  summary: TaskCardSummary;
  criteria: string;
  budget: TaskCardBudget;
  onCriteriaChange: (value: string) => void;
  onBudgetChange: (value: TaskCardBudget) => void;
  onConfirmedChange: (confirmed: boolean) => void;
  confirmed: boolean;
  disabled?: boolean;
}

/** Shows what the task will do before it starts. The user edits criteria and budget and must confirm. */
export function TaskCard({ summary, criteria, budget, onCriteriaChange, onBudgetChange, onConfirmedChange, confirmed, disabled }: TaskCardProps): ReactElement {
  const executable = parseCriteria(criteria).filter(isExecutableCriterion).length;
  const setBudget = (patch: Partial<TaskCardBudget>) => onBudgetChange({ ...budget, ...patch });
  const commitBudget = () => onBudgetChange(clampBudget(budget));
  return (
    <div className="task-card">
      <div className="task-card-title">任务卡（启动前确认）</div>
      <dl className="task-card-summary">
        <dt>目标</dt><dd>{summary.goal || '未填写'}</dd>
        <dt>工作区</dt><dd>{summary.workspace || '未填写'}</dd>
        <dt>模型</dt><dd>{summary.model}</dd>
        <dt>权限</dt><dd>{summary.permissionLabel}</dd>
        <dt>上下文</dt><dd>{summary.contextMode}</dd>
      </dl>
      <label className="field-label" htmlFor="task-card-criteria">成功标准（每行一条）</label>
      <textarea id="task-card-criteria" className="task-card-criteria" value={criteria} disabled={disabled} onChange={(event) => onCriteriaChange(event.target.value)} placeholder={'cmd: npm test\n文档已更新'} />
      <p className="task-card-hint">
        以 <code>cmd:</code> 开头的标准会在沙箱中执行并判定通过或失败（{executable} 条）。其余标准只作为记录，验证时显示为“跳过”，不会自动判定。
      </p>
      <div className="field-grid">
        <label className="chat-option">
          <span>最大 token</span>
          <input type="number" min={BUDGET_LIMITS.maxTokens.min} max={BUDGET_LIMITS.maxTokens.max} value={budget.maxTokens} disabled={disabled} onChange={(event) => setBudget({ maxTokens: Number(event.target.value) })} onBlur={commitBudget} />
        </label>
        <label className="chat-option">
          <span>最长时间（秒）</span>
          <input type="number" min={BUDGET_LIMITS.maxTimeSeconds.min} max={BUDGET_LIMITS.maxTimeSeconds.max} value={budget.maxTimeSeconds} disabled={disabled} onChange={(event) => setBudget({ maxTimeSeconds: Number(event.target.value) })} onBlur={commitBudget} />
        </label>
      </div>
      <p className="task-card-hint">超出 token 预算会转为交接文档；超出时间预算会停止并报告。</p>
      <label className="task-card-confirm">
        <input type="checkbox" checked={confirmed} disabled={disabled} onChange={(event) => onConfirmedChange(event.target.checked)} />
        <span>我已确认以上目标、权限和预算</span>
      </label>
    </div>
  );
}

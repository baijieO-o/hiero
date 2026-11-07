export const DEFAULT_BUDGET = { maxTokens: 4000, maxTimeSeconds: 120 } as const;
export const BUDGET_LIMITS = { maxTokens: { min: 100, max: 200_000 }, maxTimeSeconds: { min: 10, max: 3600 } } as const;

export interface TaskCardBudget {
  maxTokens: number;
  maxTimeSeconds: number;
}

export interface TaskCardDraft {
  goal: string;
  criteria: string;
  budget: TaskCardBudget;
}

/** Trims lines and drops empty ones. Each remaining line is one acceptance criterion. */
export function parseCriteria(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** Clamps a budget value into the allowed range. Non-finite input falls back to the default. */
export function clampBudget(budget: TaskCardBudget): TaskCardBudget {
  const clamp = (value: number, range: { min: number; max: number }, fallback: number) => {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(range.max, Math.max(range.min, Math.round(value)));
  };
  return {
    maxTokens: clamp(budget.maxTokens, BUDGET_LIMITS.maxTokens, DEFAULT_BUDGET.maxTokens),
    maxTimeSeconds: clamp(budget.maxTimeSeconds, BUDGET_LIMITS.maxTimeSeconds, DEFAULT_BUDGET.maxTimeSeconds),
  };
}

/** Converts the card draft into the TaskContract fields the runtime accepts. */
export function toContractFields(draft: TaskCardDraft): { acceptance_criteria: string[]; budget_envelope: { max_tokens: number; max_time_ms: number } } {
  const budget = clampBudget(draft.budget);
  return {
    acceptance_criteria: parseCriteria(draft.criteria),
    budget_envelope: { max_tokens: budget.maxTokens, max_time_ms: budget.maxTimeSeconds * 1000 },
  };
}

/** Returns a message the user must resolve before launching, or null when the card can launch. */
export function validateTaskCard(draft: TaskCardDraft): string | null {
  if (!draft.goal.trim()) return '请先填写任务目标。';
  return null;
}

/** Criteria with a `cmd:` prefix are executed in the sandbox. Everything else is only recorded and reported as skipped. */
export function isExecutableCriterion(criterion: string): boolean {
  return criterion.startsWith('cmd:');
}

/** Parsing for the update_plan tool. The runtime uses it to validate model calls before publishing the plan to the UI. */

export type PlanStepStatus = 'pending' | 'in_progress' | 'done';
export interface PlanStep { title: string; status: PlanStepStatus }

const PLAN_STEP_STATUSES = new Set<string>(['pending', 'in_progress', 'done']);
const MAX_PLAN_STEPS = 20;
const MAX_TITLE_LENGTH = 200;

/** Returns the steps for a valid update_plan call, or undefined so the model receives an error. */
export function parsePlanArguments(rawArguments: string): PlanStep[] | undefined {
  let parsed: { steps?: unknown };
  try {
    parsed = JSON.parse(rawArguments) as { steps?: unknown };
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0 || parsed.steps.length > MAX_PLAN_STEPS) return undefined;
  const steps: PlanStep[] = [];
  for (const item of parsed.steps as { title?: unknown; status?: unknown }[]) {
    if (typeof item?.title !== 'string' || !item.title.trim()) return undefined;
    if (typeof item.status !== 'string' || !PLAN_STEP_STATUSES.has(item.status)) return undefined;
    steps.push({ title: item.title.trim().slice(0, MAX_TITLE_LENGTH), status: item.status as PlanStepStatus });
  }
  return steps;
}

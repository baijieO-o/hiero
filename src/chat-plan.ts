/** Parsing for the update_plan tool. The runtime uses it to validate model calls before publishing the plan to the UI. */

export type PlanStepStatus = 'pending' | 'in_progress' | 'done';
/** `id` is assigned by the backend and stays stable across model revisions and user edits. */
export interface PlanStep { id: string; title: string; status: PlanStepStatus }
/** A step as sent by the model or the user, before the backend assigns an id. */
export interface PlanStepInput { title: string; status: PlanStepStatus }

const PLAN_STEP_STATUSES = new Set<string>(['pending', 'in_progress', 'done']);
const MAX_PLAN_STEPS = 20;
const MAX_TITLE_LENGTH = 200;

/** Returns the steps for a valid update_plan call, or undefined so the model receives an error. */
export function parsePlanArguments(rawArguments: string): PlanStepInput[] | undefined {
  let parsed: { steps?: unknown };
  try {
    parsed = JSON.parse(rawArguments) as { steps?: unknown };
  } catch {
    return undefined;
  }
  return parsePlanSteps(parsed.steps);
}

/** Validates a list of steps, from the model or from a user edit. Returns undefined when the list is not usable. */
export function parsePlanSteps(raw: unknown): PlanStepInput[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PLAN_STEPS) return undefined;
  const steps: PlanStepInput[] = [];
  for (const item of raw as { title?: unknown; status?: unknown }[]) {
    if (typeof item?.title !== 'string' || !item.title.trim()) return undefined;
    if (typeof item.status !== 'string' || !PLAN_STEP_STATUSES.has(item.status)) return undefined;
    steps.push({ title: item.title.trim().slice(0, MAX_TITLE_LENGTH), status: item.status as PlanStepStatus });
  }
  return steps;
}

/**
 * Keeps the ids of the previous plan. A step whose title matches a previous step (in order, each previous step used once)
 * keeps that id. Other steps get a new id from `nextId`, so ids are never reused within a run.
 */
export class PlanIdAllocator {
  private counter: number;

  constructor(private readonly previous: readonly PlanStep[] = []) {
    this.counter = previous.reduce((max, step) => Math.max(max, Number(step.id.slice(1)) || 0), 0);
  }

  assign(steps: readonly PlanStepInput[]): PlanStep[] {
    const unused = [...this.previous];
    return steps.map((step) => {
      const matchIndex = unused.findIndex((prior) => prior.title === step.title);
      const match = matchIndex >= 0 ? unused.splice(matchIndex, 1)[0] : undefined;
      return { id: match?.id ?? this.nextId(), title: step.title, status: step.status };
    });
  }

  private nextId(): string {
    this.counter += 1;
    return `s${this.counter}`;
  }
}

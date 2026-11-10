import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** A recurring prompt run by the runtime at a fixed interval. */
export interface ScheduledTask {
  id: string;
  /** Human-readable name shown in the UI. */
  name: string;
  /** Prompt sent to the agent each time the task fires. */
  goal: string;
  /** Fixed interval between runs, in minutes. */
  interval_minutes: number;
  enabled: boolean;
  /** ISO timestamp of the last run, if any. */
  last_run_at?: string;
  /** Task-history id of the most recent run, so the report can be found in the task store. */
  last_task_id?: string;
  last_status?: 'completed' | 'failed';
  /** Final report text from the most recent run (or the error message when it failed). */
  last_summary?: string;
  /** ISO timestamp of the next scheduled run. */
  next_run_at: string;
  created_at: string;
}

export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 60 * 24 * 30;

export function defaultSchedulesPath(): string {
  return join(homedir(), '.hiero', 'schedules.json');
}

/** Returns the next run time after `from`, given a fixed interval in minutes. */
export function nextRunAfter(from: Date, intervalMinutes: number): string {
  return new Date(from.getTime() + intervalMinutes * 60_000).toISOString();
}

/** Validates user input and returns the cleaned task fields, or throws with a readable message. */
export function normalizeScheduleInput(input: { name?: unknown; goal?: unknown; interval_minutes?: unknown }): { name: string; goal: string; interval_minutes: number } {
  const goal = typeof input.goal === 'string' ? input.goal.trim() : '';
  if (!goal) throw new Error('定时任务需要一条非空的 prompt。');
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : goal.slice(0, 40);
  const interval = Number(input.interval_minutes);
  if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MINUTES || interval > MAX_INTERVAL_MINUTES) {
    throw new Error(`间隔必须是 ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} 之间的整数分钟。`);
  }
  return { name, goal, interval_minutes: interval };
}

/** Reads schedules from disk. A missing or corrupt file yields an empty list instead of crashing the runtime. */
export function loadSchedules(path: string): ScheduledTask[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isScheduledTask) : [];
  } catch {
    return [];
  }
}

/** Writes schedules atomically: a temp file is renamed over the target so a crash never leaves a half-written file. */
export function saveSchedules(path: string, tasks: ScheduledTask[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(tasks, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}

export function createScheduledTask(input: { name?: unknown; goal?: unknown; interval_minutes?: unknown; run_now?: unknown }, now = new Date()): ScheduledTask {
  const fields = normalizeScheduleInput(input);
  return {
    id: randomUUID(),
    ...fields,
    enabled: true,
    next_run_at: input.run_now === true ? now.toISOString() : nextRunAfter(now, fields.interval_minutes),
    created_at: now.toISOString(),
  };
}

/** Returns tasks whose next run time has arrived and that are enabled. */
export function dueTasks(tasks: ScheduledTask[], now = new Date()): ScheduledTask[] {
  return tasks.filter((task) => task.enabled && Date.parse(task.next_run_at) <= now.getTime());
}

function isScheduledTask(value: unknown): value is ScheduledTask {
  if (typeof value !== 'object' || value === null) return false;
  const task = value as Partial<ScheduledTask>;
  return typeof task.id === 'string' && typeof task.goal === 'string' && typeof task.name === 'string'
    && typeof task.interval_minutes === 'number' && typeof task.enabled === 'boolean' && typeof task.next_run_at === 'string' && typeof task.created_at === 'string';
}

import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

const REFLECTION_FILE = 'reflections.jsonl';
export const REFLECTION_LOAD_LIMIT = 5;
const SUMMARY_LIMIT = 500;

/** A short note about why an attempt failed, kept so later runs in the same workspace can avoid the same mistake. */
export interface Reflection {
  saved_at: string;
  task_id: string;
  attempt: number;
  failure_summary: string;
}

function reflectionPath(workspacePath: string): string {
  return join(workspacePath, '.hiero', REFLECTION_FILE);
}

/** Appends one reflection per failed attempt to `.hiero/reflections.jsonl`. Long summaries are truncated. */
export async function appendReflection(workspacePath: string, taskId: string, attempt: number, failureSummary: string): Promise<void> {
  const summary = failureSummary.trim();
  if (!summary) return;
  const path = reflectionPath(workspacePath);
  await mkdir(join(path, '..'), { recursive: true });
  const record: Reflection = {
    saved_at: new Date().toISOString(),
    task_id: taskId,
    attempt,
    failure_summary: summary.length > SUMMARY_LIMIT ? `${summary.slice(0, SUMMARY_LIMIT)}…` : summary,
  };
  await appendFile(path, JSON.stringify(record) + '\n', 'utf8');
}

/** Returns the most recent reflections, oldest first. Corrupt lines are skipped. */
export async function listReflections(workspacePath: string, limit = REFLECTION_LOAD_LIMIT): Promise<Reflection[]> {
  const raw = (await readFile(reflectionPath(workspacePath), 'utf8').catch(() => '')).replace(/^\uFEFF/, '');
  const reflections: Reflection[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { reflections.push(JSON.parse(line) as Reflection); } catch { /* skip corrupt line */ }
  }
  return reflections.slice(-limit);
}

/** Formats reflections as planner context. Returns an empty string when there is nothing to report. */
export function formatReflectionContext(reflections: readonly Reflection[]): string {
  if (reflections.length === 0) return '';
  const items = reflections.map((item) => `- Task ${item.task_id}, attempt ${item.attempt}: ${item.failure_summary}`).join('\n');
  return `Lessons from earlier failed attempts in this workspace. Avoid repeating these mistakes:\n${items}`;
}

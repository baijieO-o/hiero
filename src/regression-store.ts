import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FailureKind } from './error-parser.js';

const REGRESSION_FILE = 'regressions.jsonl';
export const REGRESSION_LOAD_LIMIT = 10;

/** A failed `cmd:` acceptance check that the planner should avoid repeating. */
export interface RegressionCase {
  saved_at: string;
  task_id: string;
  command: string;
  failure_kind: FailureKind;
  error_summary: string;
}

function regressionPath(workspacePath: string): string {
  return join(workspacePath, '.hiero', REGRESSION_FILE);
}

/** Appends failed verification commands to `.hiero/regressions.jsonl`. Passing checks are ignored. */
export async function appendRegressionCases(workspacePath: string, taskId: string, cases: Array<Omit<RegressionCase, 'saved_at' | 'task_id'>>): Promise<void> {
  if (cases.length === 0) return;
  const path = regressionPath(workspacePath);
  await mkdir(join(path, '..'), { recursive: true });
  const savedAt = new Date().toISOString();
  const lines = cases.map((item) => JSON.stringify({ saved_at: savedAt, task_id: taskId, ...item }) + '\n').join('');
  await appendFile(path, lines, 'utf8');
}

/** Returns the most recent regression cases, oldest first. Corrupt lines are skipped. */
export async function listRegressionCases(workspacePath: string, limit = REGRESSION_LOAD_LIMIT): Promise<RegressionCase[]> {
  const raw = (await readFile(regressionPath(workspacePath), 'utf8').catch(() => '')).replace(/^\uFEFF/, '');
  const cases: RegressionCase[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { cases.push(JSON.parse(line) as RegressionCase); } catch { /* skip corrupt line */ }
  }
  return cases.slice(-limit);
}

/** Formats cases as planner context. Returns an empty string when there is nothing to report. */
export function formatRegressionContext(cases: readonly RegressionCase[]): string {
  if (cases.length === 0) return '';
  const items = cases.map((item) => `- \`${item.command}\` failed as [${item.failure_kind}]: ${item.error_summary}`).join('\n');
  return `Known failing commands from earlier runs in this workspace. Plan changes that make them pass. Never edit the acceptance commands themselves:\n${items}`;
}

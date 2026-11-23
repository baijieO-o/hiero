import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendReflection, formatReflectionContext, listReflections } from '../src/reflection-store.js';

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-reflection-'));
  try { await run(workspace); } finally { await rm(workspace, { recursive: true, force: true }); }
}

test('reflection store persists attempts as JSONL and truncates long summaries', () => withWorkspace(async (workspace) => {
  await appendReflection(workspace, 'task-1', 1, 'first failure');
  await appendReflection(workspace, 'task-1', 2, 'x'.repeat(2000));
  const raw = await readFile(join(workspace, '.hiero', 'reflections.jsonl'), 'utf8');
  assert.equal(raw.trim().split('\n').length, 2);
  const cases = await listReflections(workspace);
  assert.equal(cases[0]?.failure_summary, 'first failure');
  assert.ok((cases[1]?.failure_summary.length ?? 0) <= 501);
  assert.equal(cases[1]?.attempt, 2);
}));

test('reflection store skips empty summaries and corrupt lines', () => withWorkspace(async (workspace) => {
  await appendReflection(workspace, 'task-1', 1, '   ');
  await mkdir(join(workspace, '.hiero'), { recursive: true });
  await writeFile(join(workspace, '.hiero', 'reflections.jsonl'), '{bad json\n' + JSON.stringify({ saved_at: 't', task_id: 'task-2', attempt: 1, failure_summary: 'kept' }) + '\n', 'utf8');
  const cases = await listReflections(workspace);
  assert.deepEqual(cases.map((item) => item.failure_summary), ['kept']);
}));

test('reflection context keeps only the most recent entries and is empty when none exist', () => withWorkspace(async (workspace) => {
  assert.equal(formatReflectionContext(await listReflections(workspace)), '');
  for (let i = 1; i <= 7; i += 1) await appendReflection(workspace, 'task-1', i, `failure ${i}`);
  const context = formatReflectionContext(await listReflections(workspace));
  assert.ok(!context.includes('failure 2'));
  assert.ok(context.includes('failure 3'));
  assert.ok(context.includes('failure 7'));
}));

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRegressionCases, formatRegressionContext, listRegressionCases } from '../src/regression-store.js';

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-regression-'));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test('regression store appends failed commands as JSONL and reads them back oldest first', () => withWorkspace(async (workspace) => {
  await appendRegressionCases(workspace, 'task-1', [{ command: 'npm test', failure_kind: 'test_assertion', error_summary: 'expected 1 got 2' }]);
  await appendRegressionCases(workspace, 'task-2', [{ command: 'npm run build', failure_kind: 'syntax', error_summary: 'Unexpected token' }]);

  const raw = await readFile(join(workspace, '.hiero', 'regressions.jsonl'), 'utf8');
  assert.equal(raw.trim().split('\n').length, 2);

  const cases = await listRegressionCases(workspace);
  assert.deepEqual(cases.map((item) => item.task_id), ['task-1', 'task-2']);
  assert.equal(cases[1]?.failure_kind, 'syntax');
}));

test('regression store skips corrupt lines and keeps only the most recent cases', () => withWorkspace(async (workspace) => {
  await appendRegressionCases(workspace, 'task-1', [{ command: 'a', failure_kind: 'unknown', error_summary: 'x' }]);
  await appendRegressionCases(workspace, 'task-2', [{ command: 'b', failure_kind: 'unknown', error_summary: 'y' }]);
  const path = join(workspace, '.hiero', 'regressions.jsonl');
  const raw = await readFile(path, 'utf8');
  await writeFile(path, `not json\n${raw}`, 'utf8');

  const cases = await listRegressionCases(workspace, 1);
  assert.deepEqual(cases.map((item) => item.command), ['b']);
}));

test('regression store returns no context when nothing was recorded', () => withWorkspace(async (workspace) => {
  assert.deepEqual(await listRegressionCases(workspace), []);
  assert.equal(formatRegressionContext([]), '');
}));

test('regression context names the failing command and forbids editing acceptance commands', () => withWorkspace(async (workspace) => {
  await appendRegressionCases(workspace, 'task-1', [{ command: 'npm test', failure_kind: 'test_assertion', error_summary: 'expected 1' }]);
  const context = formatRegressionContext(await listRegressionCases(workspace));
  assert.match(context, /`npm test` failed as \[test_assertion\]: expected 1/);
  assert.match(context, /Never edit the acceptance commands/);
}));

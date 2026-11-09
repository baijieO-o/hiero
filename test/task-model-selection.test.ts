import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { autoSelectModel, parseTaskModelOverrides, resolveTaskModel } from '../src/task-model-selection.js';
import { HieroRuntime } from '../src/hiero-runtime.js';

test('autoSelectModel prefers cheap models for compaction and strong models for planning', () => {
  const candidates = ['gpt-4.1-mini', 'claude-sonnet-4', 'llama-3-8b'];
  assert.equal(autoSelectModel('compaction', candidates), 'gpt-4.1-mini');
  assert.equal(autoSelectModel('planning', candidates), 'claude-sonnet-4');
});

test('autoSelectModel returns undefined when there are no candidates', () => {
  assert.equal(autoSelectModel('chat', []), undefined);
});

test('resolveTaskModel gives manual overrides priority over auto selection', () => {
  const candidates = ['gpt-4.1-mini', 'claude-sonnet-4'];
  assert.equal(resolveTaskModel('compaction', { compaction: 'claude-sonnet-4' }, candidates), 'claude-sonnet-4');
  assert.equal(resolveTaskModel('compaction', {}, candidates), 'gpt-4.1-mini');
});

test('parseTaskModelOverrides drops invalid JSON, unknown keys and non-string values', () => {
  assert.deepEqual(parseTaskModelOverrides(undefined), {});
  assert.deepEqual(parseTaskModelOverrides('not json'), {});
  assert.deepEqual(parseTaskModelOverrides('["x"]'), {});
  assert.deepEqual(parseTaskModelOverrides('{"planning":"m1","bogus":"m2","chat":5,"execution":"  "}'), { planning: 'm1' });
});

test('saveModelSettings persists HIERO_LLM_TASK_MODELS and sanitizes it', () => {
  const root = mkdtempSync(join(tmpdir(), 'hiero-task-models-'));
  writeFileSync(join(root, '.env'), 'OTHER=keep\n', 'utf8');
  const runtime = Object.create(HieroRuntime.prototype) as HieroRuntime;
  runtime.saveModelSettings({ endpoint: '', model: '', tokens: '', task_models: { planning: ' m1 ', chat: '', bogus: 'x' } as never }, root);
  const text = readFileSync(join(root, '.env'), 'utf8');
  assert.ok(text.includes('OTHER=keep'));
  const line = text.split('\n').find((l) => l.startsWith('HIERO_LLM_TASK_MODELS='));
  assert.ok(line);
  assert.deepEqual(JSON.parse(line.slice('HIERO_LLM_TASK_MODELS='.length)), { planning: 'm1' });
});

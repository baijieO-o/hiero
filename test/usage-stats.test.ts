import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeModelCalls } from '../src/usage-stats.js';

const line = (ts: string, model: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'model.call', ts, model, ok: true, inputTokens: 100, outputTokens: 20, ...extra });

test('summarizes model calls by model and day, skipping other events and malformed lines', () => {
  const stats = summarizeModelCalls([
    line('2026-05-01T10:00:00.000Z', 'gpt-a'),
    line('2026-05-01T11:00:00.000Z', 'gpt-a', { ok: false, inputTokens: 0, outputTokens: 0 }),
    line('2026-05-02T09:00:00.000Z', 'gpt-b', { inputTokens: 50, outputTokens: 5 }),
    JSON.stringify({ name: 'task.start', ts: '2026-05-02T09:00:00.000Z' }),
    '{not json',
  ]);
  assert.deepEqual(stats.total, { calls: 3, failed: 1, input_tokens: 150, output_tokens: 25 });
  assert.deepEqual(stats.models.map((row) => row.model), ['gpt-a', 'gpt-b']);
  assert.equal(stats.models[0]?.calls, 2);
  assert.deepEqual(stats.daily.map((day) => [day.date, day.calls]), [['2026-05-01', 2], ['2026-05-02', 1]]);
});

test('ignores calls before sinceMs', () => {
  const since = Date.parse('2026-05-02T00:00:00.000Z');
  const stats = summarizeModelCalls([line('2026-05-01T10:00:00.000Z', 'gpt-a'), line('2026-05-02T10:00:00.000Z', 'gpt-a')], since);
  assert.equal(stats.total.calls, 1);
});

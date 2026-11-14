import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { normalizeScheduleInput } from '../src/scheduled-tasks.js';

test('keeps only non-empty string acceptance criteria, trimmed', () => {
  const fields = normalizeScheduleInput({ goal: 'check', interval_minutes: 10, acceptance_criteria: [' cmd: npm test ', '', 42, 'cmd: npx tsc -p .'] });
  assert.deepEqual(fields.acceptance_criteria, ['cmd: npm test', 'cmd: npx tsc -p .']);
});

test('defaults to no acceptance criteria when the field is absent or not a list', () => {
  assert.deepEqual(normalizeScheduleInput({ goal: 'check', interval_minutes: 10 }).acceptance_criteria, []);
  assert.deepEqual(normalizeScheduleInput({ goal: 'check', interval_minutes: 10, acceptance_criteria: 'cmd: npm test' }).acceptance_criteria, []);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePlanArguments } from '../src/chat-plan.js';

test('parsePlanArguments accepts well-formed steps and trims titles', () => {
  const steps = parsePlanArguments(JSON.stringify({ steps: [{ title: '  读取配置 ', status: 'in_progress' }, { title: '写测试', status: 'pending' }] }));
  assert.deepEqual(steps, [{ title: '读取配置', status: 'in_progress' }, { title: '写测试', status: 'pending' }]);
});

test('parsePlanArguments rejects invalid status, empty titles, bad JSON and empty plans', () => {
  assert.equal(parsePlanArguments(JSON.stringify({ steps: [{ title: 'a', status: 'running' }] })), undefined);
  assert.equal(parsePlanArguments(JSON.stringify({ steps: [{ title: '   ', status: 'done' }] })), undefined);
  assert.equal(parsePlanArguments('{not json'), undefined);
  assert.equal(parsePlanArguments(JSON.stringify({ steps: [] })), undefined);
});

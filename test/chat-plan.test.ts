import assert from 'node:assert/strict';
import test from 'node:test';
import { PlanIdAllocator, parsePlanArguments, parsePlanSteps } from '../src/chat-plan.js';

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

test('PlanIdAllocator keeps ids for steps whose titles match and never reuses an id', () => {
  const first = new PlanIdAllocator().assign([{ title: '读取', status: 'pending' }, { title: '写代码', status: 'pending' }]);
  assert.deepEqual(first.map((s) => s.id), ['s1', 's2']);

  const revised = new PlanIdAllocator(first).assign([{ title: '读取', status: 'done' }, { title: '写代码', status: 'in_progress' }, { title: '跑测试', status: 'pending' }]);
  assert.deepEqual(revised.map((s) => s.id), ['s1', 's2', 's3']);
  assert.equal(revised[1]?.status, 'in_progress');

  // Dropping a step and adding a new one must not hand the dropped id back out.
  const dropped = new PlanIdAllocator(revised).assign([{ title: '读取', status: 'done' }, { title: '新步骤', status: 'pending' }]);
  assert.deepEqual(dropped.map((s) => s.id), ['s1', 's4']);
});

test('PlanIdAllocator gives each duplicate title its own id', () => {
  const previous = new PlanIdAllocator().assign([{ title: '检查', status: 'pending' }, { title: '检查', status: 'pending' }]);
  const next = new PlanIdAllocator(previous).assign([{ title: '检查', status: 'done' }, { title: '检查', status: 'pending' }]);
  assert.deepEqual(next.map((s) => s.id), ['s1', 's2']);
});

test('parsePlanSteps validates a user edit the same way as a model plan', () => {
  assert.deepEqual(parsePlanSteps([{ title: ' 改过的 ', status: 'pending' }]), [{ title: '改过的', status: 'pending' }]);
  assert.equal(parsePlanSteps([]), undefined);
  assert.equal(parsePlanSteps([{ title: 'x', status: 'unknown' }]), undefined);
  assert.equal(parsePlanSteps('not an array'), undefined);
});

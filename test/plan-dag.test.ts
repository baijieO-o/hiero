import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanDag, runPlanDag, topologicalLayers, type PlanTask } from '../src/plan-dag.js';

const plan = (tasks: object[]) => JSON.stringify({ tasks });

test('parses a valid DAG and groups independent tasks into the same layer', () => {
  const dag = parsePlanDag(plan([
    { id: 'a', goal: 'read a', read_only: true },
    { id: 'b', goal: 'read b', read_only: true },
    { id: 'c', goal: 'combine', depends_on: ['a', 'b'] },
  ]));
  const layers = topologicalLayers(dag).map((layer) => layer.map((task) => task.id));
  assert.deepEqual(layers, [['a', 'b'], ['c']]);
});

test('rejects invalid JSON, unknown dependencies, self dependencies, duplicates and cycles', () => {
  assert.throws(() => parsePlanDag('not json'), /not valid JSON/);
  assert.throws(() => parsePlanDag(plan([{ id: 'a', goal: 'x', depends_on: ['zz'] }])), /unknown task "zz"/);
  assert.throws(() => parsePlanDag(plan([{ id: 'a', goal: 'x', depends_on: ['a'] }])), /depends on itself/);
  assert.throws(() => parsePlanDag(plan([{ id: 'a', goal: 'x' }, { id: 'a', goal: 'y' }])), /Duplicate task id/);
  assert.throws(() => parsePlanDag(plan([
    { id: 'a', goal: 'x', depends_on: ['b'] },
    { id: 'b', goal: 'y', depends_on: ['a'] },
  ])), /dependency cycle/);
});

test('runs read-only tasks in parallel but respects dependencies and the parallel cap', async () => {
  const dag = parsePlanDag(plan([
    { id: 'a', goal: 'a', read_only: true },
    { id: 'b', goal: 'b', read_only: true },
    { id: 'c', goal: 'c', read_only: true },
    { id: 'd', goal: 'd', depends_on: ['a', 'b', 'c'] },
  ]));
  let inFlight = 0;
  let peak = 0;
  const started: string[] = [];
  const outputs = await runPlanDag(dag, async (task: PlanTask) => {
    started.push(task.id);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;
    return `done:${task.id}`;
  }, { maxParallel: 2 });
  assert.equal(peak, 2);
  assert.equal(started.indexOf('d'), 3, 'dependent task must start after its layer');
  assert.equal(outputs.get('d'), 'done:d');
});

test('write-capable tasks in the same layer run sequentially', async () => {
  const dag = parsePlanDag(plan([
    { id: 'w1', goal: 'write 1' },
    { id: 'w2', goal: 'write 2' },
  ]));
  let inFlight = 0;
  let peak = 0;
  await runPlanDag(dag, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return '';
  });
  assert.equal(peak, 1);
});

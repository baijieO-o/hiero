import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentExecutor, ReActResult } from '../src/agent-executor.js';
import { AgentWorkflow, type WorkflowOutcome } from '../src/agent-workflow.js';
import type { TaskContract } from '../src/contracts.js';
import { AgentStateMachine } from '../src/state-machine.js';

function task(workspace: string): TaskContract {
  return {
    task_id: 'task-dag',
    workspace_path: workspace,
    model_config: { preferred_model: 'test', fallback_chain: [] },
    permission_mode: 'standard',
    context_mode: 'ephemeral',
    acceptance_criteria: [],
    budget_envelope: { max_tokens: 4000, max_time_ms: 120_000 },
  };
}

function result(content: string): ReActResult {
  return { response: { model: 'mock', token_id: 't', content }, evidence: [], messages: [] } as unknown as ReActResult;
}

test('a DAG plan runs dependencies first and passes their output to dependents', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-dag-'));
  try {
    const plan = JSON.stringify({ tasks: [
      { id: 'a', goal: 'collect A', depends_on: [], read_only: true },
      { id: 'b', goal: 'collect B', depends_on: [], read_only: true },
      { id: 'c', goal: 'combine', depends_on: ['a', 'b'], read_only: false },
    ] });
    const goals: string[] = [];
    const executor = {
      planWithCapabilities: async () => ({ response: { content: plan }, tools: [] }),
      exec: async (_task: TaskContract, goal: string): Promise<ReActResult> => {
        goals.push(goal);
        return result(goal.startsWith('collect A') ? 'A-out' : goal.startsWith('collect B') ? 'B-out' : 'C-out');
      },
    } as unknown as AgentExecutor;
    const machine = new AgentStateMachine();
    const workflow = new AgentWorkflow(machine, executor, undefined, undefined, { useDagPlan: true, verify: async () => ({ verified: true, checks: [] }) });
    const outcome = await workflow.run(task(workspace), 'goal') as WorkflowOutcome;
    assert.equal(outcome.verification.verified, true);
    assert.equal(goals.length, 3);
    assert.equal(goals[2], 'combine\n\nResults of prerequisite tasks:\na: A-out\nb: B-out');
    assert.equal(outcome.response.content, 'C-out');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a plan that is not a valid DAG falls back to a single linear Exec', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-dag-'));
  try {
    const goals: string[] = [];
    const executor = {
      planWithCapabilities: async () => ({ response: { content: 'just prose, no JSON' }, tools: [] }),
      exec: async (_task: TaskContract, goal: string): Promise<ReActResult> => {
        goals.push(goal);
        return result('done');
      },
    } as unknown as AgentExecutor;
    const workflow = new AgentWorkflow(new AgentStateMachine(), executor, undefined, undefined, { useDagPlan: true, verify: async () => ({ verified: true, checks: [] }) });
    await workflow.run(task(workspace), 'goal');
    assert.deepEqual(goals, ['just prose, no JSON']);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('without useDagPlan the planner is not asked for a DAG and output is executed linearly', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-dag-'));
  try {
    const planOptions: unknown[] = [];
    const executor = {
      planWithCapabilities: async (_t: TaskContract, _g: string, _tools: unknown, options: unknown) => { planOptions.push(options); return { response: { content: '{"tasks":[{"id":"x","goal":"g","depends_on":[]}]}' }, tools: [] }; },
      exec: async (_task: TaskContract, goal: string): Promise<ReActResult> => result(goal),
    } as unknown as AgentExecutor;
    const workflow = new AgentWorkflow(new AgentStateMachine(), executor, undefined, undefined, { verify: async () => ({ verified: true, checks: [] }) });
    await workflow.run(task(workspace), 'goal');
    assert.deepEqual(planOptions, [{ dag: false }]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

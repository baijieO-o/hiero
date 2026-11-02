import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentExecutor, HandoffRequiredError } from '../src/agent-executor.js';
import { AgentWorkflow } from '../src/agent-workflow.js';
import { AgentState, AgentStateMachine } from '../src/state-machine.js';
import { ModelGateway } from '../src/model-gateway.js';
import { ToolGateway } from '../src/tool-gateway.js';
import type { TaskContract } from '../src/contracts.js';

const task: TaskContract = { task_id: 'handoff-auto', workspace_path: '', model_config: { preferred_model: 'mock', fallback_chain: [] }, permission_mode: 'standard', context_mode: 'persistent_md', acceptance_criteria: [], budget_envelope: { max_tokens: 100, max_time_ms: 5000 } };

test('automatically hands off before sending an over-budget model request', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-handoff-'));
  let calls = 0;
  const gateway = new ModelGateway({ complete: async () => { calls += 1; return { model: 'mock', token_id: 'token', content: 'unexpected' }; } }, ['token']);
  const executor = new AgentExecutor(gateway, new ToolGateway());
  const machine = new AgentStateMachine();
  const workflow = new AgentWorkflow(machine, executor);
  const oversizedTask = { ...task, workspace_path: workspace };
  const outcome = await workflow.run(oversizedTask, 'x'.repeat(400));
  assert.equal(calls, 0);
  assert.equal(machine.state, AgentState.Handoff);
  assert.ok('handoff' in outcome);
  const saved = JSON.parse(await readFile(join(workspace, '.hiero', 'handoff.json'), 'utf8')) as { task_goal: string; current_state: string };
  assert.equal(saved.task_goal, 'x'.repeat(400));
  assert.equal(saved.current_state, AgentState.Handoff);
});

test('exposes the threshold as an executable error for direct executor callers', async () => {
  const gateway = new ModelGateway({ complete: async () => { throw new Error('must not call'); } }, ['token']);
  const executor = new AgentExecutor(gateway, new ToolGateway());
  await assert.rejects(executor.plan({ ...task, workspace_path: '.', budget_envelope: { max_tokens: 10, max_time_ms: 1000 } }, 'long context '.repeat(10)), HandoffRequiredError);
});

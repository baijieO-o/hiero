import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentExecutor, ReActResult } from '../src/agent-executor.js';
import { AgentWorkflow, type AutomaticHandoffResult, type WorkflowOutcome } from '../src/agent-workflow.js';
import type { TaskContract } from '../src/contracts.js';
import { AgentState, AgentStateMachine } from '../src/state-machine.js';
import type { VerificationResult } from '../src/verification.js';
import { runVerification } from '../src/verification.js';

function task(workspace: string, acceptanceCriteria: string[] = []): TaskContract {
  return {
    task_id: 'task-verify',
    workspace_path: workspace,
    model_config: { preferred_model: 'test', fallback_chain: [] },
    permission_mode: 'standard',
    context_mode: 'ephemeral',
    acceptance_criteria: acceptanceCriteria,
    budget_envelope: { max_tokens: 4000, max_time_ms: 120_000 },
  };
}

function fakeExecutor(behaviour: { execFails?: number } = {}): { executor: AgentExecutor; execCalls: () => number } {
  let execCalls = 0;
  let failures = behaviour.execFails ?? 0;
  const executor = {
    planWithCapabilities: async () => ({ response: { content: 'plan' }, tools: [] }),
    exec: async (): Promise<ReActResult> => {
      execCalls += 1;
      if (failures > 0) {
        failures -= 1;
        throw new Error('exec failed');
      }
      return { response: 'done', evidence: [], messages: [] } as unknown as ReActResult;
    },
  } as unknown as AgentExecutor;
  return { executor, execCalls: () => execCalls };
}

function verification(verified: boolean): () => Promise<VerificationResult> {
  return async () => ({ verified, checks: [{ criterion: 'cmd: test', status: verified ? 'passed' : 'failed' }] });
}

test('a passing verification completes Exec 鈫?Verify without rewinding', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-verify-'));
  try {
    const machine = new AgentStateMachine();
    const { executor, execCalls } = fakeExecutor();
    let rewinds = 0;
    const workflow = new AgentWorkflow(machine, executor, undefined, undefined, { verify: verification(true), rewind: async () => { rewinds += 1; } });
    const outcome = await workflow.run(task(workspace), 'goal') as WorkflowOutcome;
    assert.equal(machine.state, AgentState.Verify);
    assert.equal(outcome.verification.verified, true);
    assert.equal(outcome.retries, 0);
    assert.equal(execCalls(), 1);
    assert.equal(rewinds, 0);
    assert.deepEqual(machine.transitions.map(({ from, to }) => `${from}->${to}`), ['Plan->Exec', 'Exec->Verify']);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a failed verification rewinds, replans and retries until it passes', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-verify-'));
  try {
    const machine = new AgentStateMachine();
    const { executor, execCalls } = fakeExecutor();
    const results = [false, true];
    let rewinds = 0;
    const workflow = new AgentWorkflow(machine, executor, undefined, undefined, {
      verify: async () => ({ verified: results.shift() ?? true, checks: [] }),
      rewind: async () => { rewinds += 1; },
    });
    const outcome = await workflow.run(task(workspace), 'goal') as WorkflowOutcome;
    assert.equal(outcome.retries, 1);
    assert.equal(execCalls(), 2);
    assert.equal(rewinds, 1);
    assert.equal(machine.state, AgentState.Verify);
    assert.deepEqual(machine.transitions.map(({ from, to }) => `${from}->${to}`), [
      'Plan->Exec', 'Exec->Verify', 'Verify->Rewind', 'Rewind->Plan', 'Plan->Exec', 'Exec->Verify',
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('retries are bounded and exhaustion hands off instead of looping', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-verify-'));
  try {
    const machine = new AgentStateMachine();
    const { executor, execCalls } = fakeExecutor();
    const handoffs: string[] = [];
    const workflow = new AgentWorkflow(machine, executor, undefined, (document) => handoffs.push(document.checkpoint_id), {
      verify: verification(false),
      rewind: async () => {},
      maxRetries: 2,
    });
    const outcome = await workflow.run(task(workspace), 'goal') as AutomaticHandoffResult;
    assert.ok('handoff' in outcome);
    assert.equal(execCalls(), 3);
    assert.equal(machine.state, AgentState.Handoff);
    assert.equal(handoffs.length, 1);
    assert.match(outcome.handoff.completed_steps[0] ?? '', /Verification failed after 3 attempt/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('an execution error rewinds and replans rather than leaving the machine in Exec', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-verify-'));
  try {
    const machine = new AgentStateMachine();
    const { executor, execCalls } = fakeExecutor({ execFails: 1 });
    const workflow = new AgentWorkflow(machine, executor, undefined, undefined, { verify: verification(true), rewind: async () => {} });
    const outcome = await workflow.run(task(workspace), 'goal') as WorkflowOutcome;
    assert.equal(outcome.retries, 1);
    assert.equal(execCalls(), 2);
    assert.equal(machine.state, AgentState.Verify);
    assert.ok(machine.transitions.some(({ from, to }) => from === AgentState.Exec && to === AgentState.Rewind));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a new task can start after a task ends in Verify or Handoff, but not mid-task', () => {
  const machine = new AgentStateMachine();
  machine.transition(AgentState.Exec);
  assert.throws(() => machine.beginTask(), (cause: unknown) => (cause as { record?: { code: string } }).record?.code === 'ORG-003');

  machine.transition(AgentState.Verify);
  machine.beginTask();
  assert.equal(machine.state, AgentState.Plan);

  machine.transition(AgentState.Exec);
  machine.transition(AgentState.Handoff);
  machine.beginTask();
  assert.equal(machine.state, AgentState.Plan);
});

test('a verify run with no cmd criteria passes and reports every criterion as skipped', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-verify-'));
  try {
    const result = await runVerification({ workspacePath: workspace, acceptanceCriteria: ['looks good'], permissionMode: 'standard', run: async () => { throw new Error('must not run'); } });
    assert.equal(result.verified, true);
    assert.equal(result.checks[0]?.status, 'skipped');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a cmd criterion runs its command and fails on a non-zero exit', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-verify-'));
  try {
    const seen: string[] = [];
    const result = await runVerification({
      workspacePath: workspace,
      acceptanceCriteria: ['cmd: npm test'],
      permissionMode: 'standard',
      run: async (_root, command) => { seen.push(command); return { command, cwd: '', exitCode: 1, output: 'boom', timedOut: false }; },
    });
    assert.deepEqual(seen, ['npm test']);
    assert.equal(result.verified, false);
    assert.equal(result.checks[0]?.exitCode, 1);
    assert.equal(result.checks[0]?.output, 'boom');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('strict mode refuses to run cmd criteria', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-verify-'));
  try {
    const result = await runVerification({
      workspacePath: workspace,
      acceptanceCriteria: ['cmd: npm test'],
      permissionMode: 'strict',
      run: async () => { throw new Error('must not run'); },
    });
    assert.equal(result.verified, false);
    assert.equal(result.checks[0]?.status, 'failed');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('failed command checks carry a failure kind and guidance', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-kind-'));
  try {
    const result = await runVerification({
      workspacePath: workspace,
      acceptanceCriteria: ['cmd: node test.js'],
      permissionMode: 'standard',
      run: async () => ({ exitCode: 1, output: 'AssertionError: expected 2 to equal 3', timedOut: false } as never),
    });
    const check = result.checks[0];
    assert.equal(check?.failureKind, 'test_assertion');
    assert.ok((check?.guidance ?? '').length > 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});


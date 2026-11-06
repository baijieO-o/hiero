import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { AgentExecutor, ExecOptions, ReActResult } from '../src/agent-executor.js';
import { AgentWorkflow } from '../src/agent-workflow.js';
import type { EvidenceRecord, TaskContract } from '../src/contracts.js';
import { AgentStateMachine } from '../src/state-machine.js';
import type { VerificationResult } from '../src/verification.js';

function task(): TaskContract {
  return {
    task_id: 'task-step',
    workspace_path: process.cwd(),
    model_config: { preferred_model: 'test', fallback_chain: [] },
    permission_mode: 'standard',
    context_mode: 'ephemeral',
    acceptance_criteria: ['cmd:npm test'],
    budget_envelope: { max_tokens: 4000, max_time_ms: 120_000 },
  };
}

function evidence(tool: string, success = true): EvidenceRecord {
  return { evidence_id: `e-${tool}`, intent_id: 'i', tool_name: tool, result: {}, success, created_at: new Date().toISOString() };
}

/** Runs the workflow with an executor that replays the given evidence batches through onStep. */
async function runWithBatches(batches: EvidenceRecord[][], stepVerify: boolean, verify: () => Promise<VerificationResult>) {
  const feedback: (string | undefined)[] = [];
  const verifyCalls: number[] = [];
  const executor = {
    planWithCapabilities: async () => ({ response: { content: 'plan' }, tools: [] }),
    exec: async (_task: TaskContract, _goal: string, _tools: unknown, options: ExecOptions): Promise<ReActResult> => {
      const all: EvidenceRecord[] = [];
      for (const batch of batches) {
        all.push(...batch);
        feedback.push(await options.onStep?.(all));
      }
      return { response: { model: 'mock', token_id: 't', content: 'done' }, evidence: all, messages: [] } as unknown as ReActResult;
    },
  } as unknown as AgentExecutor;
  const workflow = new AgentWorkflow(new AgentStateMachine(), executor, undefined, undefined, {
    stepVerify,
    verify: async () => { verifyCalls.push(1); return verify(); },
  });
  await workflow.run(task(), 'goal');
  return { feedback, verifyCalls: verifyCalls.length };
}

test('step verify is skipped for read-only batches', async () => {
  const result = await runWithBatches([[evidence('read_file')], [evidence('list_dir')]], true, async () => ({ verified: true, checks: [] }));
  // Only the final Verify runs.
  assert.equal(result.verifyCalls, 1);
  assert.deepEqual(result.feedback, [undefined, undefined]);
});

test('step verify runs after a successful write and feeds failures back to the model', async () => {
  let calls = 0;
  const result = await runWithBatches([[evidence('write_file')]], true, async () => {
    calls += 1;
    return calls === 1
      ? { verified: false, checks: [{ criterion: 'cmd:npm test', status: 'failed', errorSummary: 'expected 2 got 1' }] }
      : { verified: true, checks: [] };
  });
  // The step check runs first and fails; the final Verify then passes.
  assert.equal(result.verifyCalls, 2);
  assert.match(result.feedback[0] ?? '', /Step verification failed/);
  assert.match(result.feedback[0] ?? '', /expected 2 got 1/);
});

test('step verify does not run when disabled', async () => {
  const result = await runWithBatches([[evidence('edit_file')]], false, async () => ({ verified: true, checks: [] }));
  assert.equal(result.verifyCalls, 1);
  assert.deepEqual(result.feedback, [undefined]);
});

test('failed writes do not trigger step verify', async () => {
  const result = await runWithBatches([[evidence('write_file', false)]], true, async () => ({ verified: true, checks: [] }));
  assert.equal(result.verifyCalls, 1);
});

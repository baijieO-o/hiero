import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ContextManager } from '../src/context-manager.js';
import { error, HieroError, type HandoffDocument } from '../src/contracts.js';
import { AgentState, AgentStateMachine } from '../src/state-machine.js';

class MockExecNode {
  public async run(): Promise<void> {
    await Promise.resolve();
    throw new HieroError(error('RUN-001', 'blocker', 'Mock execution failed at 50%.', 'Rewind to the last checkpoint.').record);
  }
}

test('runs execution failure through Rewind and restores a HandoffDocument in a new instance', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-machine-'));

  try {
    const machine = new AgentStateMachine();
    const exec = new MockExecNode();

    machine.transition(AgentState.Exec);
    await assert.rejects(exec.run(), (cause: unknown) => {
      assert.ok(cause instanceof HieroError);
      assert.equal(cause.record.code, 'RUN-001');
      assert.match(cause.record.message, /50%/);
      return true;
    });

    machine.transition(AgentState.Rewind);
    machine.transition(AgentState.Plan);
    assert.equal(machine.state, AgentState.Plan);
    assert.deepEqual(machine.transitions.map(({ from, to }) => `${from}->${to}`), [
      'Plan->Exec',
      'Exec->Rewind',
      'Rewind->Plan',
    ]);

    const context = new ContextManager(workspace);
    assert.equal(context.shouldHandoff(80, 100), true);
    machine.transition(AgentState.Handoff);

    const document: HandoffDocument = {
      checkpoint_id: 'checkpoint-001',
      task_goal: 'Exercise the Hiero state machine end to end.',
      completed_steps: ['Mock execution failed at 50%', 'Rewound to the plan checkpoint'],
      current_state: machine.state,
      decisions_and_rationale: [{ decision: 'Use a mock execution node', reason: 'Keep the test independent of real LLMs.' }],
      next_steps: ['Resume from the handoff checkpoint'],
      active_mcp_servers: [],
      deferred_tool_subset: [],
      mrtr_pending: false,
      human_modified_files: [],
    };

    const handoffPath = await context.save(document);
    assert.match(handoffPath, /handoff\.json$/);

    const restoredContext = new ContextManager(workspace);
    const restored = await restoredContext.load();
    assert.deepEqual(restored, document);
    assert.equal(restored.current_state, AgentState.Handoff);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentExecutor, ReActResult } from '../src/agent-executor.js';
import { AgentWorkflow } from '../src/agent-workflow.js';
import { createWriteFileTool } from '../src/basic-tools.js';
import type { TaskContract } from '../src/contracts.js';
import { ToolGateway } from '../src/tool-gateway.js';
import { AgentStateMachine } from '../src/state-machine.js';
import { WriteSnapshotStore } from '../src/write-snapshots.js';

function task(workspace: string): TaskContract {
  return {
    task_id: 'task-rewind-integration',
    workspace_path: workspace,
    model_config: { preferred_model: 'test', fallback_chain: [] },
    permission_mode: 'standard',
    context_mode: 'ephemeral',
    acceptance_criteria: ['cmd: npm test'],
    budget_envelope: { max_tokens: 4000, max_time_ms: 120_000 },
  };
}

/** Exec writes a file through the real write_file tool, as the model would. */
function writingExecutor(gateway: ToolGateway, content: string): AgentExecutor {
  return {
    planWithCapabilities: async () => ({ response: { content: 'plan' }, tools: [] }),
    exec: async (): Promise<ReActResult> => {
      await gateway.execute('write_file', { path: 'out.txt', content }, 'intent-1', 'auto');
      return { response: 'wrote', evidence: [], messages: [] } as unknown as ReActResult;
    },
  } as unknown as AgentExecutor;
}

/** Fails the first verification and passes the second, so exactly one rewind happens. */
function failOnce(): () => Promise<{ verified: boolean; checks: [] }> {
  let calls = 0;
  return async () => {
    calls += 1;
    return { verified: calls > 1, checks: [] };
  };
}

test('a rewind restores the file the agent overwrote', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hiero-rewind-int-'));
  try {
    await writeFile(join(root, 'out.txt'), 'before', 'utf8');
    const snapshots = new WriteSnapshotStore();
    const gateway = new ToolGateway();
    gateway.register(createWriteFileTool(root, snapshots));
    let seenAtRewind: string | undefined;
    let restoredAtRewind: string | undefined;

    const workflow = new AgentWorkflow(new AgentStateMachine(), writingExecutor(gateway, 'agent output'), undefined, undefined, {
      maxRetries: 1,
      verify: failOnce(),
      rewind: async () => {
        seenAtRewind = await readFile(join(root, 'out.txt'), 'utf8');
        await snapshots.rollback();
        restoredAtRewind = await readFile(join(root, 'out.txt'), 'utf8');
      },
    });
    await workflow.run(task(root), 'goal');

    assert.equal(seenAtRewind, 'agent output');
    assert.equal(restoredAtRewind, 'before');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a rewind removes a file the agent created', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hiero-rewind-int-'));
  try {
    const snapshots = new WriteSnapshotStore();
    const gateway = new ToolGateway();
    gateway.register(createWriteFileTool(root, snapshots));
    let existedAtRewind = false;
    let existsAfterRewind = true;

    const workflow = new AgentWorkflow(new AgentStateMachine(), writingExecutor(gateway, 'fresh'), undefined, undefined, {
      maxRetries: 1,
      verify: failOnce(),
      rewind: async () => {
        existedAtRewind = await stat(join(root, 'out.txt')).then(() => true, () => false);
        await snapshots.rollback();
        existsAfterRewind = await stat(join(root, 'out.txt')).then(() => true, () => false);
      },
    });
    await workflow.run(task(root), 'goal');

    assert.equal(existedAtRewind, true);
    assert.equal(existsAfterRewind, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a rewind keeps a file the human edited after the agent wrote it (RBK-006)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hiero-rewind-int-'));
  try {
    await writeFile(join(root, 'out.txt'), 'before', 'utf8');
    const snapshots = new WriteSnapshotStore();
    const gateway = new ToolGateway();
    gateway.register(createWriteFileTool(root, snapshots));
    let skipped: string[] = [];

    const workflow = new AgentWorkflow(new AgentStateMachine(), writingExecutor(gateway, 'agent output'), undefined, undefined, {
      maxRetries: 1,
      verify: async () => {
        await writeFile(join(root, 'out.txt'), 'human edit', 'utf8');
        return { verified: false, checks: [] };
      },
      rewind: async () => {
        skipped = (await snapshots.rollback()).skipped;
      },
    });
    await workflow.run(task(root), 'goal');

    assert.equal(await readFile(join(root, 'out.txt'), 'utf8'), 'human edit');
    assert.equal(skipped.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

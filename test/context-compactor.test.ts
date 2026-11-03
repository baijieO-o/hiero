import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentExecutor, HandoffRequiredError } from '../src/agent-executor.js';
import { ContextCompactor, COMPACT_SUMMARY_PREFIX } from '../src/context-compactor.js';
import { ModelGateway, type ModelMessage, type ModelResponse, type ModelTransport } from '../src/model-gateway.js';
import { ToolGateway } from '../src/tool-gateway.js';
import { z } from 'zod';
import type { TaskContract } from '../src/contracts.js';

const task: TaskContract = { task_id: 'compact', workspace_path: '', model_config: { preferred_model: 'mock', fallback_chain: [] }, permission_mode: 'standard', context_mode: 'ephemeral', acceptance_criteria: [], budget_envelope: { max_tokens: 100, max_time_ms: 5000 } };

test('replaces older turns with one summary and keeps recent turns verbatim', async () => {
  const seen: string[] = [];
  const compactor = new ContextCompactor(async (_task, transcript) => { seen.push(transcript); return '目标: demo'; }, 2);
  const messages: ModelMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
  ];
  const result = await compactor.compact(task, messages);
  assert.equal(result[0]?.content, 'sys');
  assert.equal(result[1]?.content, `${COMPACT_SUMMARY_PREFIX}\n目标: demo`);
  assert.deepEqual(result.slice(2), messages.slice(3));
  assert.equal(seen.length, 1);
  assert.match(seen[0] ?? '', /user: u1/);
  assert.doesNotMatch(seen[0] ?? '', /u2/);
});

test('does not split an assistant tool_calls message from its tool results', async () => {
  const compactor = new ContextCompactor(async () => 'summary', 2);
  const messages: ModelMessage[] = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] },
    { role: 'tool', content: 'r1', tool_call_id: 'c1', name: 't' },
    { role: 'assistant', content: 'a' },
  ];
  const result = await compactor.compact(task, messages);
  // The first user turn is compacted; the assistant tool_calls message and its tool result stay together.
  assert.equal(result[0]?.content, `${COMPACT_SUMMARY_PREFIX}\nsummary`);
  assert.deepEqual(result.slice(1), messages.slice(1));
});

test('keeps history unchanged when the summary is empty', async () => {
  const compactor = new ContextCompactor(async () => '   ', 1);
  const messages: ModelMessage[] = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }];
  assert.deepEqual(await compactor.compact(task, messages), messages);
});

test('executor compacts over-budget history and continues instead of handing off', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-compact-'));
  const modelInputs: ModelMessage[][] = [];
  let summarizerCalls = 0;
  const transport: ModelTransport = {
    complete: async (request) => {
      modelInputs.push([...(request.messages ?? [])]);
      // First turn asks for a tool; second turn answers. Each call sees the history after compaction.
      // Keep calling a tool with distinct arguments until the model is told to stop after the compaction.
      const toolTurn = modelInputs.length <= 4;
      return toolTurn
        ? { model: 'mock', token_id: 't', content: '', tool_calls: [{ id: `c${modelInputs.length}`, type: 'function', function: { name: 'big_read', arguments: JSON.stringify({ n: modelInputs.length, pad: 'y'.repeat(120) }) } }] }
        : { model: 'mock', token_id: 't', content: 'done' };
    },
  };
  const gateway = new ModelGateway(transport, ['t']);
  const compactor = new ContextCompactor(async () => { summarizerCalls += 1; return '目标: demo'; }, 0);
  const toolGateway = new ToolGateway();
  toolGateway.register({
    name: 'big_read',
    inputSchema: z.object({ n: z.number(), pad: z.string() }),
    execute: () => ({ ok: true, blob: 'z'.repeat(400) }),
    effect: 'read',
  });
  const executor = new AgentExecutor(gateway, toolGateway, 8, undefined, 0.8, compactor);
  const goal = 'short goal';
  const tight = { ...task, workspace_path: workspace, budget_envelope: { max_tokens: 60, max_time_ms: 5000 } };
  const result = await executor.exec(tight, goal, []);
  assert.ok(summarizerCalls >= 1, 'summarizer should run when over budget');
  assert.equal(result.response.content, 'done');
  assert.ok(result.messages.some((message) => message.content.startsWith(COMPACT_SUMMARY_PREFIX)));
});

test('executor still hands off when no compactor is configured', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-compact-off-'));
  const gateway = new ModelGateway({ complete: async () => { throw new Error('must not call'); } }, ['t']);
  const executor = new AgentExecutor(gateway, new ToolGateway());
  const tight = { ...task, workspace_path: workspace, budget_envelope: { max_tokens: 10, max_time_ms: 5000 } };
  await assert.rejects(executor.exec(tight, 'x'.repeat(200), []), HandoffRequiredError);
});

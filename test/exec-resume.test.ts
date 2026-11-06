import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AgentExecutor } from '../src/agent-executor.js';
import type { ModelGateway, ModelResponse } from '../src/model-gateway.js';
import { ToolGateway } from '../src/tool-gateway.js';
import { z } from 'zod';
import type { TaskContract } from '../src/contracts.js';

const task: TaskContract = { task_id: 'exec-resume', workspace_path: '.', model_config: { preferred_model: 'mock', fallback_chain: [] }, permission_mode: 'auto', context_mode: 'ephemeral', acceptance_criteria: [], budget_envelope: { max_tokens: 100_000, max_time_ms: 60_000 } };

function scripted(responses: ModelResponse[]): ModelGateway {
  let index = 0;
  return { complete: async () => responses[Math.min(index++, responses.length - 1)] } as unknown as ModelGateway;
}

function callsResponse(ids: string[]): ModelResponse {
  return { model: 'mock', token_id: 't', content: '', tool_calls: ids.map((id) => ({ id, type: 'function', function: { name: 'count', arguments: `{"value":"${id}"}` } })) } as unknown as ModelResponse;
}

function countingTools(counter: { runs: number }): ToolGateway {
  const tools = new ToolGateway();
  tools.register({ name: 'count', inputSchema: z.object({ value: z.string() }), execute: ({ value }) => { counter.runs += 1; return value; } });
  return tools;
}

test('a checkpoint is saved after every tool call, not only after the batch', async () => {
  const counter = { runs: 0 };
  const snapshots: number[] = [];
  const gateway = scripted([callsResponse(['a', 'b']), { model: 'mock', token_id: 't', content: 'done' } as unknown as ModelResponse]);
  await new AgentExecutor(gateway, countingTools(counter), 5).exec(task, 'goal', [], {
    onCheckpoint: (messages) => { snapshots.push(messages.length); },
  });
  assert.equal(counter.runs, 2);
  // Messages after the assistant turn plus each completed tool result: [user, assistant, tool a] then [.., tool b].
  assert.deepEqual(snapshots, [3, 4]);
});

test('resuming replays completed tool calls from evidence instead of running them again', async () => {
  const first = { runs: 0 };
  const checkpoints: { messages: unknown[]; evidence: unknown[] }[] = [];
  const crashingGateway = scripted([callsResponse(['a', 'b']), { model: 'mock', token_id: 't', content: 'done' } as unknown as ModelResponse]);
  const crashingTools = new ToolGateway();
  crashingTools.register({
    name: 'count',
    inputSchema: z.object({ value: z.string() }),
    execute: ({ value }) => {
      if (value === 'b') throw new Error('simulated crash');
      first.runs += 1;
      return value;
    },
  });
  await assert.rejects(new AgentExecutor(crashingGateway, crashingTools, 5).exec(task, 'goal', [], {
    onCheckpoint: (messages, evidence) => { checkpoints.push({ messages: [...messages], evidence: [...evidence] }); },
  }), /simulated crash/);
  const latest = checkpoints.at(-1);
  assert.ok(latest);
  assert.equal(first.runs, 1);

  const second = { runs: 0 };
  const resumedGateway = scripted([callsResponse(['a', 'b']), { model: 'mock', token_id: 't', content: 'done' } as unknown as ModelResponse]);
  const result = await new AgentExecutor(resumedGateway, countingTools(second), 5).exec(task, 'goal', [], { resume: latest });
  assert.equal(second.runs, 1, 'only the call that never completed should run');
  assert.equal(result.evidence.length, 2);
  assert.equal(result.response.content, 'done');
});

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AgentExecutor } from '../src/agent-executor.js';
import type { ModelGateway, ModelResponse } from '../src/model-gateway.js';
import { ToolGateway } from '../src/tool-gateway.js';
import { z } from 'zod';
import type { TaskContract } from '../src/contracts.js';

const baseTask: TaskContract = { task_id: 'exec-guards', workspace_path: '.', model_config: { preferred_model: 'mock', fallback_chain: [] }, permission_mode: 'auto', context_mode: 'ephemeral', acceptance_criteria: [], budget_envelope: { max_tokens: 100_000, max_time_ms: 60_000 } };

function scriptedGateway(responses: ModelResponse[]): ModelGateway {
  let index = 0;
  return { complete: async () => responses[Math.min(index++, responses.length - 1)] } as unknown as ModelGateway;
}

function toolCallResponse(args: string): ModelResponse {
  return { model: 'mock', token_id: 't', content: '', tool_calls: [{ id: `c-${Math.random()}`, type: 'function', function: { name: 'echo', arguments: args } }] } as unknown as ModelResponse;
}

function echoTools(): ToolGateway {
  const tools = new ToolGateway();
  tools.register({ name: 'echo', inputSchema: z.object({ value: z.string() }), execute: ({ value }) => value });
  return tools;
}

test('stops with MOD-005 when the same tool call repeats three times in a row', async () => {
  const gateway = scriptedGateway([toolCallResponse('{"value":"x"}')]);
  await assert.rejects(new AgentExecutor(gateway, echoTools(), 20).exec(baseTask, 'loop'), /MOD-005/);
});

test('does not trigger MOD-005 when tool arguments change between calls', async () => {
  const gateway = scriptedGateway([toolCallResponse('{"value":"a"}'), toolCallResponse('{"value":"b"}'), toolCallResponse('{"value":"c"}'), { model: 'mock', token_id: 't', content: 'done' } as unknown as ModelResponse]);
  const result = await new AgentExecutor(gateway, echoTools(), 20).exec(baseTask, 'varied');
  assert.equal(result.evidence.length, 3);
  assert.equal(result.response.content, 'done');
});

test('stops with MOD-006 when the task time budget is exhausted', async () => {
  const slowGateway = { complete: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return toolCallResponse('{"value":"x"}'); } } as unknown as ModelGateway;
  const task = { ...baseTask, budget_envelope: { max_tokens: 100_000, max_time_ms: 10 } };
  await assert.rejects(new AgentExecutor(slowGateway, echoTools(), 20).exec(task, 'slow'), /MOD-006/);
});

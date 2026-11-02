import { strict as assert } from 'node:assert';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { AgentExecutor } from '../src/agent-executor.js';
import { AgentWorkflow } from '../src/agent-workflow.js';
import { AgentState, AgentStateMachine } from '../src/state-machine.js';
import { ModelGateway, OpenAICompatibleTransport } from '../src/model-gateway.js';
import { ToolGateway } from '../src/tool-gateway.js';
import { z } from 'zod';
import type { TaskContract } from '../src/contracts.js';

const task: TaskContract = { task_id: 'react-integration', workspace_path: '.', model_config: { preferred_model: 'mock-model', fallback_chain: [] }, permission_mode: 'standard', context_mode: 'ephemeral', acceptance_criteria: [], budget_envelope: { max_tokens: 1000, max_time_ms: 5000 } };

test('runs Plan and Exec through a mock OpenAI-compatible Function Call server', async () => {
  let requestCount = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requestCount += 1;
    response.setHeader('content-type', 'application/json');
    const body = requestCount === 1
      ? { choices: [{ message: { role: 'assistant', content: 'Use echo.', tool_calls: [] } }] }
      : requestCount === 2
        ? { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'echo', arguments: '{"value":"hiero"}' } }] } }] }
        : { choices: [{ message: { role: 'assistant', content: 'Tool completed.' } }] };
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const gateway = new ModelGateway(new OpenAICompatibleTransport(`http://127.0.0.1:${address.port}`), ['test-token']);
    const tools = new ToolGateway();
    tools.register({ name: 'echo', inputSchema: z.object({ value: z.string() }), execute: ({ value }) => value.toUpperCase() });
    const machine = new AgentStateMachine();
    const workflow = new AgentWorkflow(machine, new AgentExecutor(gateway, tools));
    const outcome = await workflow.run(task, 'Echo hiero', [{ type: 'function', function: { name: 'echo', description: 'Echo input', parameters: { type: 'object' } } }]);
    assert.ok('response' in outcome);
    if (!('response' in outcome)) return;
    assert.deepEqual(machine.transitions.map(({ from, to }) => `${from}->${to}`), ['Plan->Exec', 'Exec->Verify']);
    assert.equal(outcome.evidence[0]?.result, 'HIERO');
    assert.equal(outcome.response.content, 'Tool completed.');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()));
  }
});

test('accepts null tool_calls and content from OpenAI-compatible providers', async () => {
  const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hi!', reasoning_content: null, tool_calls: null } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const transport = new OpenAICompatibleTransport(`http://127.0.0.1:${address.port}`);
    const response = await transport.complete({ prompt: 'hi', model: 'm' }, 'token');
    assert.equal(response.content, 'Hi!');
    assert.equal(response.tool_calls, undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()));
  }
});

test('throws MOD-004 for malformed function call arguments', async () => {
  const transport = { complete: async () => ({ model: 'mock', token_id: 'token', content: '', tool_calls: [{ id: 'bad', type: 'function' as const, function: { name: 'echo', arguments: '{' } }] }) };
  const gateway = new ModelGateway(transport, ['token']);
  const tools = new ToolGateway();
  tools.register({ name: 'echo', inputSchema: z.object({ value: z.string() }), execute: ({ value }) => value });
  await assert.rejects(new AgentExecutor(gateway, tools).exec(task, 'bad'), /MOD-004/);
});

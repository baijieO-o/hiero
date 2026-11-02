import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { z } from 'zod';
import { createServer } from 'node:http';
import { ModelGateway, OpenAICompatibleTransport, parseTokenList, type ModelTransport } from '../src/model-gateway.js';
import { parseEnvText } from '../src/llm-env.js';
import { ToolGateway } from '../src/tool-gateway.js';
import type { TaskContract } from '../src/contracts.js';

const task: TaskContract = {
  task_id: 'gateway-test', workspace_path: '.',
  model_config: { preferred_model: 'primary', fallback_chain: ['fallback'] },
  permission_mode: 'standard', context_mode: 'ephemeral', acceptance_criteria: [],
  budget_envelope: { max_tokens: 1000, max_time_ms: 1000 },
};

test('ModelGateway cools 429 tokens and retires 401 tokens', async () => {
  let now = 1_000;
  const calls: string[] = [];
  const transport: ModelTransport = {
    complete: async (request, token) => {
      calls.push(`${request.model}:${token}`);
      if (token === 'rate-limited') throw { status: 429 };
      if (token === 'unauthorized') throw { status: 401 };
      return { model: request.model ?? 'unknown', token_id: token, content: 'ok' };
    },
  };
  const gateway = new ModelGateway(transport, ['rate-limited', 'unauthorized', 'healthy'], () => now);
  const response = await gateway.complete(task, { prompt: 'hello' });
  assert.equal(response.token_id, 'healthy');
  assert.equal(gateway.tokenStatuses()[0]?.cooldownUntil, 61_000);
  assert.equal(gateway.tokenStatuses()[1]?.retired, true);
  assert.deepEqual(calls, ['primary:rate-limited', 'fallback:unauthorized', 'primary:healthy']);
  now = 61_000;
  assert.equal(gateway.tokenStatuses()[0]?.cooldownUntil, 61_000);
});

test('ModelGateway rotates past 5xx and network failures to the next token', async () => {
  const calls: string[] = [];
  const transport: ModelTransport = {
    complete: async (request, token) => {
      calls.push(token);
      if (token === 'broken') throw { status: 503 };
      if (token === 'offline') throw new TypeError('fetch failed');
      return { model: request.model ?? 'unknown', token_id: token, content: 'ok' };
    },
  };
  const gateway = new ModelGateway(transport, ['broken', 'offline', 'healthy'], () => 0);
  const response = await gateway.complete(task, { prompt: 'hello' });
  assert.equal(response.token_id, 'healthy');
  assert.deepEqual(calls, ['broken', 'offline', 'healthy']);
});

test('ModelGateway reports a clear error when every token is rejected', async () => {
  const transport: ModelTransport = { complete: async () => { throw { status: 401 }; } };
  const gateway = new ModelGateway(transport, ['bad-1', 'bad-2'], () => 0);
  await assert.rejects(gateway.complete(task, { prompt: 'hello' }), /MOD-003/);
  assert.equal(gateway.tokenStatuses().every((status) => status.retired), true);
});

test('parseTokenList splits comma, semicolon and newline separators', () => {
  assert.deepEqual(parseTokenList(' a , b;c\n\n d ,'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(parseTokenList(undefined), []);
});

test('parseEnvText reads PowerShell and dotenv style assignments', () => {
  const values = parseEnvText([
    '# comment',
    '$env:HIERO_LLM_ENDPOINT = "https://example.test/v1"',
    'HIERO_LLM_TOKENS=sk-a,sk-b  # trailing comment',
    "HIERO_LLM_MODEL='m-1'",
  ].join('\n'));
  assert.equal(values.HIERO_LLM_ENDPOINT, 'https://example.test/v1');
  assert.equal(values.HIERO_LLM_TOKENS, 'sk-a,sk-b');
  assert.equal(values.HIERO_LLM_MODEL, 'm-1');
});

test('ToolGateway validates input and returns evidence', async () => {
  const gateway = new ToolGateway();
  gateway.register({
    name: 'echo',
    inputSchema: z.object({ value: z.string().min(1) }),
    execute: ({ value }) => value.toUpperCase(),
  });
  const evidence = await gateway.execute('echo', { value: 'hiero' }, 'intent-1', 'standard');
  assert.equal(evidence.intent_id, 'intent-1');
  assert.equal(evidence.result, 'HIERO');
  await assert.rejects(gateway.execute('echo', { value: '' }, 'intent-2', 'standard'), /GOV-002/);
});

test('streams SSE deltas through the OpenAI-compatible transport', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const gateway = new ModelGateway(new OpenAICompatibleTransport(`http://127.0.0.1:${port}/v1`), ['token-a'], () => 0);
    const deltas: string[] = [];
    const response = await gateway.complete(task, {
      prompt: '',
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (text) => deltas.push(text),
    });
    assert.deepEqual(deltas, ['Hel', 'lo']);
    assert.equal(response.content, 'Hello');
  } finally {
    server.close();
  }
});
test('sends image messages as OpenAI multimodal content parts', async () => {
  let body: any;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    body = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'seen' } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const gateway = new ModelGateway(new OpenAICompatibleTransport(`http://127.0.0.1:${port}/v1`), ['token-a'], () => 0);
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    const response = await gateway.complete(task, {
      prompt: '',
      messages: [{ role: 'user', content: 'what is this', images: [image] }],
    });
    assert.equal(response.content, 'seen');
    assert.deepEqual(body.messages[0].content, [
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: image } },
    ]);
  } finally {
    server.close();
  }
});

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

test('ModelGateway waits for the shortest cooldown instead of failing a single-token pool', async () => {
  let now = 0;
  const waits: number[] = [];
  let calls = 0;
  const transport: ModelTransport = {
    complete: async (request, token) => {
      calls += 1;
      if (calls === 1) throw { status: 429 };
      return { model: request.model ?? 'unknown', token_id: token, content: 'ok' };
    },
  };
  const gateway = new ModelGateway(transport, ['only'], () => now, 60_000, async (ms) => {
    waits.push(ms);
    now += ms;
  });
  const response = await gateway.complete(task, { prompt: 'hello' });
  assert.equal(response.content, 'ok');
  assert.deepEqual(waits, [60_000]);
  assert.equal(calls, 2);
});

test('ModelGateway retries through repeated 429s on a single-token pool before giving up', async () => {
  let now = 0;
  let calls = 0;
  const transport: ModelTransport = {
    complete: async (request, token) => {
      calls += 1;
      if (calls <= 3) throw { status: 429 };
      return { model: request.model ?? 'unknown', token_id: token, content: 'ok' };
    },
  };
  const gateway = new ModelGateway(transport, ['only'], () => now, 60_000, async (ms) => { now += ms; });
  const response = await gateway.complete(task, { prompt: 'hello' });
  assert.equal(response.content, 'ok');
  assert.equal(calls, 4);
});

test('ModelGateway still reports MOD-003 when cooldown waits are exhausted by persistent 429s', async () => {
  let now = 0;
  const transport: ModelTransport = { complete: async () => { throw { status: 429 }; } };
  const gateway = new ModelGateway(transport, ['only'], () => now, 60_000, async (ms) => { now += ms; });
  await assert.rejects(gateway.complete(task, { prompt: 'hello' }), /No model token is currently available/);
});

test('ModelGateway supports unauthenticated local OpenAI-compatible models', async () => {
  let receivedToken = 'not-called';
  const gateway = new ModelGateway({
    complete: async (_request, token) => {
      receivedToken = token;
      return { model: 'local-model', token_id: token, content: 'ok' };
    },
  }, []);
  const response = await gateway.complete({ ...task, model_config: { preferred_model: 'qwen3:8b', fallback_chain: [] } }, { prompt: 'hello' });
  assert.equal(receivedToken, '');
  assert.equal(response.content, 'ok');
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
test('sends max_tokens only when configured', async () => {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const endpoint = `http://127.0.0.1:${port}/v1`;
    await new ModelGateway(new OpenAICompatibleTransport(endpoint, undefined, 512), ['token-a'], () => 0).complete(task, { prompt: 'hi' });
    await new ModelGateway(new OpenAICompatibleTransport(endpoint), ['token-a'], () => 0).complete(task, { prompt: 'hi' });
    assert.equal(bodies[0].max_tokens, 512);
    assert.equal('max_tokens' in bodies[1], false);
  } finally {
    server.close();
  }
});
test('applies per-model params from config and reports each call', async () => {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const calls: unknown[] = [];
  const params = (model: string | undefined) => (model === 'tuned' ? { temperature: 0.4, top_p: 0.8, max_tokens: 64 } : { temperature: 0.1 });
  try {
    const transport = new OpenAICompatibleTransport(`http://127.0.0.1:${port}/v1`, undefined, 512, params);
    const gateway = new ModelGateway(transport, ['token-a'], () => 0, undefined, undefined, (event) => calls.push(event));
    const taskFor = (model: string): TaskContract => ({ ...task, model_config: { ...task.model_config, preferred_model: model, fallback_chain: [] } });
    await gateway.complete(taskFor('tuned'), { prompt: 'hi' });
    await gateway.complete(taskFor('plain'), { prompt: 'hi' });
    assert.equal(bodies[0].temperature, 0.4);
    assert.equal(bodies[0].top_p, 0.8);
    assert.equal(bodies[0].max_tokens, 64);
    assert.equal(bodies[1].temperature, 0.1);
    assert.equal('top_p' in bodies[1], false);
    assert.equal(bodies[1].max_tokens, 512);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { model: bodies[0].model, ok: true, inputTokens: 4, outputTokens: 2 });
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

test('OpenAICompatibleTransport aborts a stream that stops sending data', async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"model":"m","choices":[{"delta":{"content":"hi"}}]}\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const transport = new OpenAICompatibleTransport(`http://127.0.0.1:${port}/v1`, 300);
    const started = Date.now();
    await assert.rejects(
      transport.complete({ prompt: 'x', model: 'm', onDelta: () => undefined }, 'token'),
      (err: unknown) => err instanceof Error && err.name === 'TimeoutError' && /stalled/.test(err.message),
    );
    assert.ok(Date.now() - started < 5_000, 'stalled stream should fail within the idle timeout');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('OpenAICompatibleTransport keeps a steadily streaming reply alive past the idle timeout', async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let sent = 0;
      const timer = setInterval(() => {
        sent += 1;
        if (sent > 8) {
          clearInterval(timer);
          res.end('data: [DONE]\n\n');
          return;
        }
        res.write(`data: {"model":"m","choices":[{"delta":{"content":"${sent}"}}]}\n\n`);
      }, 100);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const transport = new OpenAICompatibleTransport(`http://127.0.0.1:${port}/v1`, 300);
    const deltas: string[] = [];
    const result = await transport.complete({ prompt: 'x', model: 'm', onDelta: (text) => deltas.push(text) }, 'token');
    assert.equal(deltas.length, 8);
    assert.equal(result.content, '12345678');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('OpenAICompatibleTransport reports token usage for stream and non-stream replies', async () => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      const parsed = JSON.parse(body) as { stream?: boolean; stream_options?: { include_usage?: boolean } };
      if (parsed.stream) {
        assert.equal(parsed.stream_options?.include_usage, true);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"model":"m","choices":[{"delta":{"content":"hi"}}]}\n\n');
        res.write('data: {"model":"m","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'm', choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const transport = new OpenAICompatibleTransport(`http://127.0.0.1:${port}/v1`);
    const plain = await transport.complete({ prompt: 'x', model: 'm' }, 'token');
    assert.deepEqual(plain.usage, { input_tokens: 5, output_tokens: 2 });
    const streamed = await transport.complete({ prompt: 'x', model: 'm', onDelta: () => undefined }, 'token');
    assert.deepEqual(streamed.usage, { input_tokens: 7, output_tokens: 3 });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HieroRuntime } from '../src/hiero-runtime.js';

interface CapturedEvent {
  type: string;
  payload: Record<string, unknown>;
}

function bufferedChatEvents(runtime: HieroRuntime, requestId: string): CapturedEvent[] {
  const run = (runtime as unknown as { chatRuns: Map<string, { events: string[] }> }).chatRuns.get(requestId);
  return (run?.events ?? []).map((message) => JSON.parse(message) as CapturedEvent);
}

test('a steer queued during a model call is sent to the model on the next call', async () => {
  const steerText = 'please use TypeScript';
  const requests: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
  const fakeClient = { send: () => undefined, readyState: 1 };

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content?: string }> };
      requests.push(parsed);
      const first = requests.length === 1;
      // Queue the supplement while the first model call is still in flight, so it must be applied before the second call.
      if (first) steerInternal({ type: 'chat_steer', request_id: 'steer-loop', steer_id: 's1', text: steerText }, fakeClient);
      const message = first
        ? { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'update_plan', arguments: JSON.stringify({ steps: [{ title: 'step one', status: 'in_progress' }] }) } }] }
        : { role: 'assistant', content: 'done' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock', choices: [{ message }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const workDir = await mkdtemp(join(tmpdir(), 'hiero-steer-loop-'));
  const previousCwd = process.cwd();
  const previousEnv = { endpoint: process.env.HIERO_LLM_ENDPOINT, tokens: process.env.HIERO_LLM_TOKENS };
  process.env.HIERO_LLM_ENDPOINT = `http://127.0.0.1:${address.port}/v1`;
  process.env.HIERO_LLM_TOKENS = 'test-token';
  process.chdir(workDir);
  const runtime = new HieroRuntime(0);
  const steerInternal = (runtime as unknown as { steerChat: (request: unknown, client: unknown) => void }).steerChat.bind(runtime);
  try {
    await runtime.handleChat({ type: 'CHAT', request_id: 'steer-loop', messages: [{ role: 'user', content: 'start' }] } as never);
  } finally {
    await runtime.close();
    process.chdir(previousCwd);
    process.env.HIERO_LLM_ENDPOINT = previousEnv.endpoint;
    process.env.HIERO_LLM_TOKENS = previousEnv.tokens;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.equal(requests.length, 2, 'the loop should make a second model call after the tool round');
  assert.ok(!requests[0]?.messages.some((message) => message.content?.includes(steerText)), 'the first call predates the steer');
  assert.ok(requests[1]?.messages.some((message) => message.role === 'user' && message.content?.includes(steerText)), 'the second call should include the steer');

  const types = bufferedChatEvents(runtime, 'steer-loop').map((event) => event.type);
  assert.ok(types.includes('CHAT_STEER_APPLIED'), 'a steer applied event should be emitted');
});


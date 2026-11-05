import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HieroRuntime } from '../src/hiero-runtime.js';
import { createListDirTool, createReadFileTool } from '../src/basic-tools.js';
import type { RuntimeWebSocketServer } from '../src/runtime-server.js';

interface CapturedEvent {
  type: string;
  payload: Record<string, unknown>;
}

/** Chat events are buffered per run and only sent to attached clients, so tests read the buffer. */
function bufferedChatEvents(runtime: HieroRuntime, requestId: string): CapturedEvent[] {
  const run = (runtime as unknown as { chatRuns: Map<string, { events: string[] }> }).chatRuns.get(requestId);
  return (run?.events ?? []).map((message) => JSON.parse(message) as CapturedEvent);
}

test('chat runs read_file tool call and returns final answer', async () => {
  const requests: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content?: string }> };
      requests.push(parsed);
      const hasToolResult = parsed.messages.some((message) => message.role === 'tool');
      const message = hasToolResult
        ? { role: 'assistant', content: 'the file says hello' }
        : { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'note.txt' }) } }] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock', choices: [{ message }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const workDir = await mkdtemp(join(tmpdir(), 'hiero-chat-'));
  await writeFile(join(workDir, 'note.txt'), 'hello from file', 'utf8');
  const previousCwd = process.cwd();
  const previousEnv = { endpoint: process.env.HIERO_LLM_ENDPOINT, tokens: process.env.HIERO_LLM_TOKENS };
  process.env.HIERO_LLM_ENDPOINT = `http://127.0.0.1:${address.port}/v1`;
  process.env.HIERO_LLM_TOKENS = 'test-token';
  process.chdir(workDir);

  const runtime = new HieroRuntime(0);
  try {
    await runtime.handleChat({ type: 'CHAT', request_id: 'r1', messages: [{ role: 'user', content: 'read note.txt' }] } as never);
  } finally {
    await runtime.close();
    process.chdir(previousCwd);
    process.env.HIERO_LLM_ENDPOINT = previousEnv.endpoint;
    process.env.HIERO_LLM_TOKENS = previousEnv.tokens;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.equal(requests.length, 2);
  const toolMessage = requests[1]?.messages.find((message) => message.role === 'tool') as { content?: string } | undefined;
  assert.ok(toolMessage?.content?.includes('hello from file'), 'tool result should contain file contents');

  const events = bufferedChatEvents(runtime, 'r1');
  const toolEvent = events.find((event) => event.type === 'CHAT_TOOL');
  assert.ok(toolEvent, 'CHAT_TOOL event should be sent');
  assert.equal(toolEvent.payload.name, 'read_file');

  const reply = events.find((event) => event.type === 'CHAT_REPLY');
  assert.ok(reply, 'CHAT_REPLY event should be sent');
  assert.equal(reply.payload.content, 'the file says hello');
});

test('list_dir returns workspace entries and read_file explains directories', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'hiero-list-'));
  await mkdir(join(workDir, 'sub'));
  await writeFile(join(workDir, 'note.txt'), 'x', 'utf8');
  const listTool = createListDirTool(workDir);
  const listed = await listTool.execute(listTool.inputSchema.parse({ path: '.' }));
  assert.deepEqual(listed.entries, [
    { name: 'sub', type: 'directory' },
    { name: 'note.txt', type: 'file' },
  ]);
  const readTool = createReadFileTool(workDir);
  await assert.rejects(async () => readTool.execute({ path: '.' }), /use list_dir/);
  await assert.rejects(async () => listTool.execute({ path: '..' }), /outside|escape|workspace/i);
});

test('read_file tool rejects paths outside the workspace', async () => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content?: string }> };
      const toolMessage = parsed.messages.find((message) => message.role === 'tool');
      const message = toolMessage
        ? { role: 'assistant', content: toolMessage.content ?? '' }
        : { role: 'assistant', content: '', tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: '..\\..\\secret.txt' }) } }] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock', choices: [{ message }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const workDir = await mkdtemp(join(tmpdir(), 'hiero-chat-'));
  const previousCwd = process.cwd();
  const previousEnv = { endpoint: process.env.HIERO_LLM_ENDPOINT, tokens: process.env.HIERO_LLM_TOKENS };
  process.env.HIERO_LLM_ENDPOINT = `http://127.0.0.1:${address.port}/v1`;
  process.env.HIERO_LLM_TOKENS = 'test-token';
  process.chdir(workDir);

  const runtime = new HieroRuntime(0);
  let events: CapturedEvent[] = [];

  try {
    await runtime.handleChat({ type: 'CHAT', request_id: 'r2', messages: [{ role: 'user', content: 'read secret' }] } as never);
    events = bufferedChatEvents(runtime, 'r2');
  } finally {
    await runtime.close();
    process.chdir(previousCwd);
    process.env.HIERO_LLM_ENDPOINT = previousEnv.endpoint;
    process.env.HIERO_LLM_TOKENS = previousEnv.tokens;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const toolEvent = events.find((event) => event.type === 'CHAT_TOOL');
  assert.ok(toolEvent, 'CHAT_TOOL event should be sent');
  assert.match(String(toolEvent.payload.result), /error/);
  assert.ok(events.some((event) => event.type === 'CHAT_REPLY'));
});

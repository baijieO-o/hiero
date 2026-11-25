import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { AnthropicMessagesTransport, normalizeAnthropicEndpoint, toAnthropicMessages, transportForProtocol } from '../src/model-protocols.js';
import { parseProviderList } from '../src/model-gateway.js';

let server: Server;
let baseUrl = '';
let lastBody: Record<string, unknown> | undefined;
let lastHeaders: IncomingMessage['headers'] = {};
let nextStatus = 200;

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      lastBody = JSON.parse(raw) as Record<string, unknown>;
      lastHeaders = req.headers;
      if (nextStatus !== 200) {
        res.writeHead(nextStatus, { 'content-type': 'application/json' });
        res.end('{"error":"nope"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } },
        ],
        usage: { input_tokens: 11, output_tokens: 7 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'object' && address) baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('Anthropic 请求把 system 提取到顶层并转换工具结果', () => {
  const converted = toAnthropicMessages([
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '读文件' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
    { role: 'tool', content: 'hello', tool_call_id: 'toolu_1', name: 'read_file' },
  ]);
  assert.equal(converted.system, '你是助手');
  assert.equal(converted.messages.length, 3);
  assert.deepEqual(converted.messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hello' }] });
});

test('Anthropic 端点规范化补全 /v1/messages', () => {
  assert.equal(normalizeAnthropicEndpoint('https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages');
  assert.equal(normalizeAnthropicEndpoint('https://api.anthropic.com/v1/'), 'https://api.anthropic.com/v1/messages');
  assert.equal(normalizeAnthropicEndpoint('https://gw.example/v1/messages'), 'https://gw.example/v1/messages');
});

test('Anthropic 传输发送正确的请求头与工具定义，并解析 tool_use 与 usage', async () => {
  nextStatus = 200;
  const transport = new AnthropicMessagesTransport(`${baseUrl}/v1/messages`);
  const response = await transport.complete({
    prompt: '读文件',
    model: 'claude-test',
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '读文件' }],
    tools: [{ type: 'function', function: { name: 'read_file', description: '读取', parameters: { type: 'object', properties: {} } } }],
  }, 'sk-test');
  assert.equal(lastHeaders['x-api-key'], 'sk-test');
  assert.equal(lastHeaders['anthropic-version'], '2023-06-01');
  assert.equal(lastBody?.system, 'sys');
  assert.equal(lastBody?.max_tokens, 4096);
  assert.deepEqual((lastBody?.tools as Array<{ input_schema: unknown }>)[0]?.input_schema, { type: 'object', properties: {} });
  assert.equal(response.content, 'checking');
  assert.equal(response.tool_calls?.[0]?.function.name, 'read_file');
  assert.equal(response.tool_calls?.[0]?.function.arguments, '{"path":"a.txt"}');
  assert.deepEqual(response.usage, { input_tokens: 11, output_tokens: 7 });
});

test('Anthropic 传输把 HTTP 错误码原样抛出，供网关做 401/429 处理', async () => {
  nextStatus = 401;
  const transport = new AnthropicMessagesTransport(`${baseUrl}/v1/messages`);
  await assert.rejects(
    transport.complete({ prompt: 'hi', model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] }, 'bad'),
    (cause: unknown) => (cause as { status?: number }).status === 401,
  );
  nextStatus = 200;
});

test('协议配置默认 openai，并接受 anthropic 与 gemini 取值', () => {
  const providers = parseProviderList(JSON.stringify([
    { name: 'a', endpoint: 'https://x', tokens: ['t'], models: ['m'] },
    { name: 'b', endpoint: 'https://y', tokens: ['t'], models: ['m'], protocol: 'anthropic' },
  ]));
  assert.equal(providers[0]?.protocol, 'openai');
  assert.equal(providers[1]?.protocol, 'anthropic');
  assert.throws(() => parseProviderList(JSON.stringify([{ name: 'c', endpoint: 'https://z', tokens: ['t'], models: ['m'], protocol: 'soap' }])), /protocol/);
});

test('transportForProtocol 对未实现的协议报错', () => {
  assert.throws(() => transportForProtocol({ endpoint: 'https://z', protocol: 'gemini' }, undefined, () => ({})), /尚未实现/);
});

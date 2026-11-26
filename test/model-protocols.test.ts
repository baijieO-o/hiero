import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { AnthropicMessagesTransport, GeminiGenerateContentTransport, OpenAIResponsesTransport, normalizeAnthropicEndpoint, normalizeGeminiEndpoint, normalizeResponsesEndpoint, toAnthropicMessages, transportForProtocol } from '../src/model-protocols.js';
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

let geminiStatus = 200;
let geminiBody: Record<string, unknown> | undefined;
let geminiPath = '';
let geminiKey: string | undefined;

test('Gemini 请求使用 systemInstruction、functionDeclarations 与 functionResponse', async () => {
  const geminiServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      geminiPath = req.url ?? '';
      geminiKey = req.headers['x-goog-api-key'] as string | undefined;
      geminiBody = JSON.parse(raw) as Record<string, unknown>;
      if (geminiStatus !== 200) {
        res.writeHead(geminiStatus, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '好的' }, { functionCall: { name: 'read_file', args: { path: 'a.txt' } } }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      }));
    });
  });
  await new Promise<void>((resolve) => geminiServer.listen(0, '127.0.0.1', resolve));
  const port = (geminiServer.address() as { port: number }).port;
  try {
    const transport = new GeminiGenerateContentTransport(`http://127.0.0.1:${port}/v1beta`, { maxTokens: 512 });
    const response = await transport.complete({
      prompt: '读文件',
      model: 'gemini-test',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '读文件' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
        { role: 'tool', content: 'hello', tool_call_id: 'c1', name: 'read_file' },
      ],
      tools: [{ type: 'function', function: { name: 'read_file', description: '读取', parameters: { type: 'object' } } }],
    }, 'gkey');
    assert.equal(geminiPath, '/v1beta/models/gemini-test:generateContent');
    assert.equal(geminiKey, 'gkey');
    assert.deepEqual(geminiBody?.systemInstruction, { parts: [{ text: 'sys' }] });
    assert.deepEqual((geminiBody?.contents as Array<{ role: string }>).map((item) => item.role), ['user', 'model', 'user']);
    assert.deepEqual((geminiBody?.contents as Array<{ parts: unknown[] }>)[2]?.parts, [{ functionResponse: { name: 'read_file', response: { content: 'hello' } } }]);
    assert.deepEqual(geminiBody?.generationConfig, { maxOutputTokens: 512 });
    assert.equal(response.content, '好的');
    assert.equal(response.tool_calls?.[0]?.function.name, 'read_file');
    assert.equal(response.tool_calls?.[0]?.function.arguments, '{"path":"a.txt"}');
    assert.deepEqual(response.usage, { input_tokens: 5, output_tokens: 3 });

    geminiStatus = 429;
    await assert.rejects(
      transport.complete({ prompt: 'hi', model: 'gemini-test', messages: [{ role: 'user', content: 'hi' }] }, 'k'),
      (cause: unknown) => (cause as { status?: number }).status === 429,
    );
    geminiStatus = 200;
  } finally {
    await new Promise<void>((resolve) => geminiServer.close(() => resolve()));
  }
});

test('normalizeGeminiEndpoint 补全 /v1beta，并保留已有版本', () => {
  assert.equal(normalizeGeminiEndpoint('https://generativelanguage.googleapis.com'), 'https://generativelanguage.googleapis.com/v1beta');
  assert.equal(normalizeGeminiEndpoint('https://gw.example/v1'), 'https://gw.example/v1');
});

let responsesStatus = 200;
let responsesBody: Record<string, unknown> | undefined;
let responsesAuth: string | undefined;

test('OpenAI Responses 请求把 system 转为 instructions，并回传 function_call_output', async () => {
  const responsesServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      responsesAuth = req.headers.authorization;
      responsesBody = JSON.parse(raw) as Record<string, unknown>;
      if (responsesStatus !== 200) {
        res.writeHead(responsesStatus, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '\u597d' }] },
          { type: 'function_call', call_id: 'call_9', name: 'read_file', arguments: '{"path":"a.txt"}' },
        ],
        usage: { input_tokens: 4, output_tokens: 2 },
      }));
    });
  });
  await new Promise<void>((resolve) => responsesServer.listen(0, '127.0.0.1', resolve));
  const port = (responsesServer.address() as { port: number }).port;
  try {
    const transport = new OpenAIResponsesTransport(`http://127.0.0.1:${port}/v1/responses`, { maxTokens: 256 });
    const response = await transport.complete({
      prompt: '读文件',
      model: 'gpt-test',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '读文件' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
        { role: 'tool', content: 'hello', tool_call_id: 'call_9', name: 'read_file' },
      ],
      tools: [{ type: 'function', function: { name: 'read_file', description: '读取', parameters: { type: 'object' } } }],
    }, 'sk-resp');
    assert.equal(responsesAuth, 'Bearer sk-resp');
    assert.equal(responsesBody?.instructions, 'sys');
    assert.equal(responsesBody?.max_output_tokens, 256);
    assert.deepEqual((responsesBody?.tools as Array<{ name: string }>)[0]?.name, 'read_file');
    assert.deepEqual((responsesBody?.input as Array<Record<string, unknown>>)[1], { type: 'function_call', call_id: 'call_9', name: 'read_file', arguments: '{"path":"a.txt"}' });
    assert.deepEqual((responsesBody?.input as Array<Record<string, unknown>>)[2], { type: 'function_call_output', call_id: 'call_9', output: 'hello' });
    assert.equal(response.content, '\u597d');
    assert.equal(response.tool_calls?.[0]?.id, 'call_9');
    assert.deepEqual(response.usage, { input_tokens: 4, output_tokens: 2 });

    responsesStatus = 401;
    await assert.rejects(
      transport.complete({ prompt: 'hi', model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] }, 'bad'),
      (cause: unknown) => (cause as { status?: number }).status === 401,
    );
    responsesStatus = 200;
  } finally {
    await new Promise<void>((resolve) => responsesServer.close(() => resolve()));
  }
});

test('normalizeResponsesEndpoint 补全 /v1/responses', () => {
  assert.equal(normalizeResponsesEndpoint('https://api.openai.com'), 'https://api.openai.com/v1/responses');
  assert.equal(normalizeResponsesEndpoint('https://gw.example/v1'), 'https://gw.example/v1/responses');
  assert.equal(normalizeResponsesEndpoint('https://gw.example/v1/responses'), 'https://gw.example/v1/responses');
});

test('transportForProtocol 为 gemini 返回 Gemini transport', () => {
  assert.ok(transportForProtocol({ endpoint: 'https://z', protocol: 'gemini' }, undefined, () => ({})) instanceof GeminiGenerateContentTransport);
});

/** Serves a fixed SSE body for one request, then closes. Used by the streaming tests below. */
async function withSseServer(events: string, run: (url: string) => Promise<void>): Promise<void> {
  const sse = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events);
    });
  });
  await new Promise<void>((resolve) => sse.listen(0, '127.0.0.1', resolve));
  const address = sse.address();
  try {
    if (typeof address === 'object' && address) await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => sse.close(() => resolve()));
  }
}

test('Anthropic streaming: text deltas, tool_use arguments and usage', async () => {
  const events = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"\u4f60"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"\u597d"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_9","name":"read_file","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"a.txt\\"}"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
  await withSseServer(events, async (url) => {
    const deltas: string[] = [];
    const response = await new AnthropicMessagesTransport(`${url}/v1/messages`).complete({
      prompt: 'x', model: 'claude-test', onDelta: (text) => deltas.push(text),
    }, 'sk-test');
    assert.deepEqual(deltas, ['\u4f60', '\u597d']);
    assert.equal(response.content, '\u4f60\u597d');
    assert.equal(response.tool_calls?.[0]?.id, 'toolu_9');
    assert.equal(response.tool_calls?.[0]?.function.arguments, '{"path":"a.txt"}');
    assert.deepEqual(response.usage, { input_tokens: 5, output_tokens: 9 });
  });
});

test('Gemini streaming: SSE text and functionCall', async () => {
  const events = [
    'data: {"candidates":[{"content":{"parts":[{"text":"\u597d"}]}}]}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"a.txt"}}}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4}}\n\n',
  ].join('');
  await withSseServer(events, async (url) => {
    const deltas: string[] = [];
    const response = await new GeminiGenerateContentTransport(`${url}/v1beta`).complete({
      prompt: 'x', model: 'gemini-test', onDelta: (text) => deltas.push(text),
    }, 'key');
    assert.deepEqual(deltas, ['\u597d']);
    assert.equal(response.content, '\u597d');
    assert.equal(response.tool_calls?.[0]?.function.name, 'read_file');
    assert.equal(response.tool_calls?.[0]?.function.arguments, '{"path":"a.txt"}');
    assert.deepEqual(response.usage, { input_tokens: 3, output_tokens: 4 });
  });
});

test('OpenAI Responses streaming: text, function_call and response.completed usage', async () => {
  const events = [
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"\u597d"}\n\n',
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read_file"}}\n\n',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"path\\":\\"a.txt\\"}"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":6}}}\n\n',
  ].join('');
  await withSseServer(events, async (url) => {
    const deltas: string[] = [];
    const response = await new OpenAIResponsesTransport(`${url}/v1/responses`).complete({
      prompt: 'x', model: 'gpt-test', onDelta: (text) => deltas.push(text),
    }, 'sk-test');
    assert.deepEqual(deltas, ['\u597d']);
    assert.equal(response.tool_calls?.[0]?.id, 'call_1');
    assert.equal(response.tool_calls?.[0]?.function.arguments, '{"path":"a.txt"}');
    assert.deepEqual(response.usage, { input_tokens: 2, output_tokens: 6 });
  });
});

test('Anthropic streaming: error event throws MOD-004', async () => {
  await withSseServer('event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n', async (url) => {
    await assert.rejects(
      new AnthropicMessagesTransport(`${url}/v1/messages`).complete({ prompt: 'x', onDelta: () => undefined }, 'sk-test'),
      (err: unknown) => (err as { code?: string }).code === 'MOD-004' || /MOD-004/.test(String(err)),
    );
  });
});

test('requestParams: temperature and max_tokens are sent to Anthropic', async () => {
  nextStatus = 200;
  const transport = transportForProtocol(
    { endpoint: baseUrl, protocol: 'anthropic' },
    1024,
    () => ({ temperature: 0.2 }),
  );
  await transport.complete({ prompt: 'x', model: 'claude-test' }, 'sk-test');
  assert.equal(lastBody?.temperature, 0.2);
  assert.equal(lastBody?.max_tokens, 1024);
});

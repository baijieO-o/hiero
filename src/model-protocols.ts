import { error } from './contracts.js';
import type { ModelMessage, ModelProtocol, ModelProviderConfig, ModelRequest, ModelResponse, ModelToolCall, ModelTransport, ModelUsage } from './model-gateway.js';
import { OpenAICompatibleTransport } from './model-gateway.js';
import { normalizeEndpoint } from './llm-env.js';
import type { ModelParams } from './config.js';

/** Wire-format adapters for non-OpenAI protocols. Each maps the internal OpenAI-style message model to one provider API. */

interface ProtocolFetchOptions {
  timeoutMs?: number;
  maxTokens?: number;
  paramsFor?: (model: string | undefined) => ModelParams;
}

/** Per-model params from config win over the env-level max token default. */
function requestParams(options: ProtocolFetchOptions, model: string | undefined): ModelParams {
  const configured = options.paramsFor?.(model) ?? {};
  const maxTokens = configured.max_tokens ?? options.maxTokens;
  return {
    ...(configured.temperature !== undefined ? { temperature: configured.temperature } : {}),
    ...(configured.top_p !== undefined ? { top_p: configured.top_p } : {}),
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
  };
}

/**
 * Sends one POST. `handle` receives the response plus a callback that resets the stall timer;
 * non-streaming handlers never call it, so the timeout is then a total deadline.
 * Cancellation and stalls map to the same errors as OpenAICompatibleTransport.
 */
async function sendRequest<T>(url: string, headers: Record<string, string>, body: unknown, request: ModelRequest, timeoutMs: number, handle: (response: Response, onChunk: () => void) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  armTimer();
  const onCancel = () => controller.abort();
  if (request.signal?.aborted) controller.abort();
  request.signal?.addEventListener('abort', onCancel, { once: true });
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal });
    if (!response.ok) {
      const failure = new Error(`Model request failed with status ${response.status}`) as Error & { status: number };
      failure.status = response.status;
      throw failure;
    }
    return await handle(response, armTimer);
  } catch (cause) {
    if (request.signal?.aborted) throw error('MOD-007', 'degradation', 'Model request was cancelled by the user.', 'Send a new message to continue.');
    if (timedOut) throw Object.assign(new Error(`Model request stalled: no data received for ${timeoutMs}ms.`, { cause }), { name: 'TimeoutError' });
    throw cause;
  } finally {
    if (timer) clearTimeout(timer);
    request.signal?.removeEventListener('abort', onCancel);
  }
}

function isEventStream(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes('text/event-stream');
}

/** Calls `onData` for every JSON object on an SSE `data:` line. Anthropic and Responses put the event name in `type`; Gemini sends bare objects. */
async function readSseData(body: ReadableStream<Uint8Array>, onChunk: () => void, onData: (payload: Record<string, unknown>) => void): Promise<void> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { return; }
    if (typeof parsed === 'object' && parsed !== null) onData(parsed as Record<string, unknown>);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk();
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      handleLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  handleLine(buffer);
}

function streamFailure(): never {
  throw error('MOD-004', 'blocker', 'Model stream reported an error.', 'Check the provider status and request parameters.');
}

function readUsageCounts(raw: unknown, inputKey: string, outputKey: string): { input?: number; output?: number } {
  if (typeof raw !== 'object' || raw === null) return {};
  const value = raw as Record<string, unknown>;
  const input = value[inputKey];
  const output = value[outputKey];
  return {
    ...(typeof input === 'number' ? { input } : {}),
    ...(typeof output === 'number' ? { output } : {}),
  };
}

function parseArguments(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  return JSON.stringify(raw ?? {});
}

function imageSource(url: string): { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (match) return { type: 'base64', media_type: match[1] ?? 'image/png', data: match[2] ?? '' };
  return { type: 'url', url };
}

/** Converts internal messages to Anthropic Messages format: system goes to a top-level field, tool results become tool_result blocks. */
export function toAnthropicMessages(messages: readonly ModelMessage[]): { system?: string; messages: Record<string, unknown>[] } {
  const systemParts: string[] = [];
  const out: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
      continue;
    }
    if (message.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: message.tool_call_id ?? '', content: message.content };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every((item) => (item as { type?: string }).type === 'tool_result')) {
        (last.content as unknown[]).push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      const blocks: Record<string, unknown>[] = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls) {
        let input: unknown = {};
        try { input = JSON.parse(call.function.arguments || '{}'); } catch { input = {}; }
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (message.images && message.images.length > 0) {
      const blocks: Record<string, unknown>[] = message.images.map((url) => ({ type: 'image', source: imageSource(url) }));
      blocks.push({ type: 'text', text: message.content });
      out.push({ role: message.role, content: blocks });
      continue;
    }
    out.push({ role: message.role, content: message.content });
  }
  return { ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}), messages: out };
}

export function toAnthropicTools(tools: ModelRequest['tools']): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    input_schema: tool.function.parameters,
  }));
}

interface AnthropicBlock {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
}

export function parseAnthropicResponse(payload: unknown, model: string, token: string): ModelResponse {
  if (typeof payload !== 'object' || payload === null) throw error('MOD-004', 'blocker', 'Model response format is invalid.', 'Check the provider response schema.');
  const value = payload as { content?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
  if (!Array.isArray(value.content)) throw error('MOD-004', 'blocker', 'Model response is missing content blocks.', 'Check the provider response schema.');
  let text = '';
  const toolCalls: ModelToolCall[] = [];
  for (const block of value.content as AnthropicBlock[]) {
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: parseArguments(block.input) } });
    }
  }
  const usage: ModelUsage | undefined = typeof value.usage?.input_tokens === 'number' && typeof value.usage?.output_tokens === 'number'
    ? { input_tokens: value.usage.input_tokens, output_tokens: value.usage.output_tokens }
    : undefined;
  return { model, token_id: token, content: text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}), ...(usage ? { usage } : {}) };
}

/** Converts internal messages to Gemini generateContent format: system goes to systemInstruction, assistant becomes role "model". */
export function toGeminiContents(messages: readonly ModelMessage[]): { systemInstruction?: { parts: Record<string, unknown>[] }; contents: Record<string, unknown>[] } {
  const systemParts: Record<string, unknown>[] = [];
  const contents: Record<string, unknown>[] = [];
  const nameById = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push({ text: message.content });
      continue;
    }
    if (message.role === 'tool') {
      const name = message.name ?? nameById.get(message.tool_call_id ?? '') ?? 'tool';
      const part = { functionResponse: { name, response: { content: message.content } } };
      const last = contents[contents.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.parts) && (last.parts as Array<Record<string, unknown>>).every((item) => 'functionResponse' in item)) {
        (last.parts as unknown[]).push(part);
      } else {
        contents.push({ role: 'user', parts: [part] });
      }
      continue;
    }
    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      const parts: Record<string, unknown>[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.tool_calls) {
        nameById.set(call.id, call.function.name);
        let args: unknown = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
        parts.push({ functionCall: { name: call.function.name, args } });
      }
      contents.push({ role: 'model', parts });
      continue;
    }
    const parts: Record<string, unknown>[] = [];
    for (const url of message.images ?? []) {
      const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
      if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }
    parts.push({ text: message.content });
    contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }
  return {
    ...(systemParts.length > 0 ? { systemInstruction: { parts: systemParts } } : {}),
    contents,
  };
}

export function toGeminiTools(tools: ModelRequest['tools']): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return [{
    functionDeclarations: tools.map((tool) => ({
      name: tool.function.name,
      ...(tool.function.description ? { description: tool.function.description } : {}),
      parameters: tool.function.parameters,
    })),
  }];
}

export function parseGeminiResponse(payload: unknown, model: string, token: string): ModelResponse {
  if (typeof payload !== 'object' || payload === null) throw error('MOD-004', 'blocker', 'Model response format is invalid.', 'Check the provider response schema.');
  const value = payload as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: unknown; functionCall?: { name?: unknown; args?: unknown } }> } }>;
    usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
  };
  const parts = value.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) throw error('MOD-004', 'blocker', 'Model response is missing candidates.', 'Check the provider response schema.');
  let text = '';
  const toolCalls: ModelToolCall[] = [];
  parts.forEach((part, index) => {
    if (typeof part.text === 'string') text += part.text;
    const call = part.functionCall;
    if (call && typeof call.name === 'string') {
      toolCalls.push({ id: `call_${index}_${call.name}`, type: 'function', function: { name: call.name, arguments: parseArguments(call.args) } });
    }
  });
  const input = value.usageMetadata?.promptTokenCount;
  const output = value.usageMetadata?.candidatesTokenCount;
  const usage: ModelUsage | undefined = typeof input === 'number' && typeof output === 'number' ? { input_tokens: input, output_tokens: output } : undefined;
  return { model, token_id: token, content: text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}), ...(usage ? { usage } : {}) };
}

/** Gemini generateContent API (POST {base}/v1beta/models/{model}:generateContent, x-goog-api-key auth). */
export class GeminiGenerateContentTransport implements ModelTransport {
  public constructor(private readonly baseUrl: string, private readonly options: ProtocolFetchOptions = {}) {}

  public async complete(request: ModelRequest, token: string): Promise<ModelResponse> {
    if (!this.baseUrl) throw error('MOD-002', 'blocker', 'Model endpoint is not configured.', 'Set the provider endpoint before starting the runtime.');
    const model = request.model ?? 'unknown';
    const { systemInstruction, contents } = toGeminiContents(request.messages ?? [{ role: 'user', content: request.prompt }]);
    const tools = toGeminiTools(request.tools);
    const params = requestParams(this.options, request.model);
    const generationConfig = {
      ...(params.max_tokens ? { maxOutputTokens: params.max_tokens } : {}),
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.top_p !== undefined ? { topP: params.top_p } : {}),
    };
    const body = {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(tools ? { tools } : {}),
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
    };
    const onDelta = request.onDelta;
    const action = onDelta ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:${action}`;
    const headers: Record<string, string> = token ? { 'x-goog-api-key': token } : {};
    return await sendRequest(url, headers, body, request, this.options.timeoutMs ?? 120_000, async (response, onChunk) => {
      if (!onDelta || !isEventStream(response) || !response.body) return parseGeminiResponse(await response.json(), model, token);
      return await readGeminiStream(response.body, onDelta, onChunk, model, token);
    });
  }
}

/** Gemini streams full candidate objects as SSE; each carries text parts and/or functionCall parts. */
async function readGeminiStream(body: ReadableStream<Uint8Array>, onDelta: (text: string) => void, onChunk: () => void, model: string, token: string): Promise<ModelResponse> {
  let text = '';
  let usage: ModelUsage | undefined;
  const toolCalls: ModelToolCall[] = [];
  await readSseData(body, onChunk, (chunk) => {
    const candidate = (chunk.candidates as Array<{ content?: { parts?: Array<{ text?: unknown; functionCall?: { name?: unknown; args?: unknown } }> } }> | undefined)?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part.text === 'string' && part.text.length > 0) {
        text += part.text;
        onDelta(part.text);
      }
      const call = part.functionCall;
      if (call && typeof call.name === 'string') {
        const index = toolCalls.length;
        toolCalls.push({ id: `call_${index}_${call.name}`, type: 'function', function: { name: call.name, arguments: parseArguments(call.args) } });
      }
    }
    const counts = readUsageCounts(chunk.usageMetadata, 'promptTokenCount', 'candidatesTokenCount');
    if (counts.input !== undefined && counts.output !== undefined) usage = { input_tokens: counts.input, output_tokens: counts.output };
  });
  return { model, token_id: token, content: text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}), ...(usage ? { usage } : {}) };
}

/** Accepts a bare base URL or a versioned one and returns the base that ends in /v1beta (or the given version). */
export function normalizeGeminiEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /\/v1(beta|alpha)?$/.test(trimmed) ? trimmed : `${trimmed}/v1beta`;
}

/** Converts internal messages to Responses API input items (function calls and outputs are separate items). */
export function toResponsesInput(messages: readonly ModelMessage[]): { instructions?: string; input: Record<string, unknown>[] } {
  const instructions: string[] = [];
  const input: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      instructions.push(message.content);
      continue;
    }
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id ?? '', output: message.content });
      continue;
    }
    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      if (message.content) input.push({ role: 'assistant', content: message.content });
      for (const call of message.tool_calls) {
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
      continue;
    }
    if (message.images && message.images.length > 0) {
      const content: Record<string, unknown>[] = message.images.map((url) => ({ type: 'input_image', image_url: url }));
      content.push({ type: 'input_text', text: message.content });
      input.push({ role: message.role, content });
      continue;
    }
    input.push({ role: message.role, content: message.content });
  }
  return { ...(instructions.length > 0 ? { instructions: instructions.join('\n\n') } : {}), input };
}

interface ResponsesOutputItem {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  call_id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

export function parseResponsesResponse(payload: unknown, model: string, token: string): ModelResponse {
  if (typeof payload !== 'object' || payload === null) throw error('MOD-004', 'blocker', 'Model response format is invalid.', 'Check the provider response schema.');
  const value = payload as { output?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
  if (!Array.isArray(value.output)) throw error('MOD-004', 'blocker', 'Model response is missing output items.', 'Check the provider response schema.');
  let text = '';
  const toolCalls: ModelToolCall[] = [];
  for (const item of value.output as ResponsesOutputItem[]) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content as Array<{ type?: unknown; text?: unknown }>) {
        if (part.type === 'output_text' && typeof part.text === 'string') text += part.text;
      }
    }
    if (item.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string') {
      toolCalls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: parseArguments(item.arguments) } });
    }
  }
  const input = value.usage?.input_tokens;
  const output = value.usage?.output_tokens;
  const usage: ModelUsage | undefined = typeof input === 'number' && typeof output === 'number' ? { input_tokens: input, output_tokens: output } : undefined;
  return { model, token_id: token, content: text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}), ...(usage ? { usage } : {}) };
}

/** OpenAI Responses API (POST {base}/v1/responses, Bearer auth). Streams SSE when onDelta is set. */
export class OpenAIResponsesTransport implements ModelTransport {
  public constructor(private readonly endpoint: string, private readonly options: ProtocolFetchOptions = {}) {}

  public async complete(request: ModelRequest, token: string): Promise<ModelResponse> {
    if (!this.endpoint) throw error('MOD-002', 'blocker', 'Model endpoint is not configured.', 'Set the provider endpoint before starting the runtime.');
    const { instructions, input } = toResponsesInput(request.messages ?? [{ role: 'user', content: request.prompt }]);
    const tools = request.tools && request.tools.length > 0
      ? request.tools.map((tool) => ({
        type: 'function',
        name: tool.function.name,
        ...(tool.function.description ? { description: tool.function.description } : {}),
        parameters: tool.function.parameters,
      }))
      : undefined;
    const params = requestParams(this.options, request.model);
    const onDelta = request.onDelta;
    const body = {
      model: request.model,
      input,
      ...(instructions ? { instructions } : {}),
      ...(tools ? { tools } : {}),
      ...(params.max_tokens ? { max_output_tokens: params.max_tokens } : {}),
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.top_p !== undefined ? { top_p: params.top_p } : {}),
      ...(onDelta ? { stream: true } : {}),
    };
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    const model = request.model ?? 'unknown';
    return await sendRequest(this.endpoint, headers, body, request, this.options.timeoutMs ?? 120_000, async (response, onChunk) => {
      if (!onDelta || !isEventStream(response) || !response.body) return parseResponsesResponse(await response.json(), model, token);
      return await readResponsesStream(response.body, onDelta, onChunk, model, token);
    });
  }
}

/**
 * Responses SSE: text arrives as response.output_text.delta; function calls appear in response.output_item.added
 * and are completed with their arguments; response.completed carries the final usage.
 */
async function readResponsesStream(body: ReadableStream<Uint8Array>, onDelta: (text: string) => void, onChunk: () => void, model: string, token: string): Promise<ModelResponse> {
  let text = '';
  let usage: ModelUsage | undefined;
  const calls = new Map<string, { id: string; name: string; args: string }>();
  await readSseData(body, onChunk, (event) => {
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      text += event.delta;
      onDelta(event.delta);
    } else if (event.type === 'response.output_item.added') {
      const item = event.item as { type?: unknown; id?: unknown; call_id?: unknown; name?: unknown } | undefined;
      if (item?.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string') {
        calls.set(typeof item.id === 'string' ? item.id : item.call_id, { id: item.call_id, name: item.name, args: '' });
      }
    } else if (event.type === 'response.function_call_arguments.delta' && typeof event.item_id === 'string' && typeof event.delta === 'string') {
      const call = calls.get(event.item_id);
      if (call) call.args += event.delta;
    } else if (event.type === 'response.completed') {
      const counts = readUsageCounts((event.response as { usage?: unknown } | undefined)?.usage, 'input_tokens', 'output_tokens');
      if (counts.input !== undefined && counts.output !== undefined) usage = { input_tokens: counts.input, output_tokens: counts.output };
    } else if (event.type === 'error' || event.type === 'response.failed') {
      streamFailure();
    }
  });
  const toolCalls: ModelToolCall[] = [...calls.values()].map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.args || '{}' } }));
  return { model, token_id: token, content: text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}), ...(usage ? { usage } : {}) };
}


/** Builds the transport for a provider's configured protocol. */
export function transportForProtocol(config: Pick<ModelProviderConfig, 'endpoint' | 'protocol'>, maxTokens: number | undefined, paramsFor: (model: string | undefined) => ModelParams): ModelTransport {
  const options: ProtocolFetchOptions = { ...(maxTokens ? { maxTokens } : {}), paramsFor };
  switch (config.protocol) {
    case 'anthropic':
      return new AnthropicMessagesTransport(normalizeAnthropicEndpoint(config.endpoint), options);
    case 'gemini':
      return new GeminiGenerateContentTransport(normalizeGeminiEndpoint(config.endpoint), options);
    case 'openai-responses':
      return new OpenAIResponsesTransport(normalizeResponsesEndpoint(config.endpoint), options);
    case 'openai':
      return new OpenAICompatibleTransport(normalizeEndpoint(config.endpoint), undefined, maxTokens, paramsFor);
  }
}

/** Normalizes a base URL to the request path that the given protocol uses. */
export function normalizeEndpointForProtocol(raw: string, protocol: ModelProtocol): string {
  switch (protocol) {
    case 'anthropic': return normalizeAnthropicEndpoint(raw);
    case 'gemini': return normalizeGeminiEndpoint(raw);
    case 'openai-responses': return normalizeResponsesEndpoint(raw);
    case 'openai': return normalizeEndpoint(raw);
  }
}

/** Accepts a bare base URL, a /v1 base, or a full /responses URL and returns the responses endpoint. */
export function normalizeResponsesEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (trimmed.endsWith('/responses')) return trimmed;
  return `${trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`}/responses`;
}

/** Accepts a bare base URL or a full /v1/messages URL and returns the messages endpoint. */
export function normalizeAnthropicEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.endsWith('/messages') ? trimmed : `${trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`}/messages`;
}

/** Anthropic Messages API (POST {base}/v1/messages, x-api-key auth). */
export class AnthropicMessagesTransport implements ModelTransport {
  public constructor(private readonly endpoint: string, private readonly options: ProtocolFetchOptions = {}) {}

  public async complete(request: ModelRequest, token: string): Promise<ModelResponse> {
    if (!this.endpoint) throw error('MOD-002', 'blocker', 'Model endpoint is not configured.', 'Set the provider endpoint before starting the runtime.');
    const { system, messages } = toAnthropicMessages(request.messages ?? [{ role: 'user', content: request.prompt }]);
    const tools = toAnthropicTools(request.tools);
    const params = requestParams(this.options, request.model);
    const onDelta = request.onDelta;
    const body = {
      model: request.model,
      max_tokens: params.max_tokens ?? 4096,
      messages,
      ...(system ? { system } : {}),
      ...(tools ? { tools } : {}),
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.top_p !== undefined ? { top_p: params.top_p } : {}),
      ...(onDelta ? { stream: true } : {}),
    };
    const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' };
    if (token) headers['x-api-key'] = token;
    const model = request.model ?? 'unknown';
    return await sendRequest(this.endpoint, headers, body, request, this.options.timeoutMs ?? 120_000, async (response, onChunk) => {
      if (!onDelta || !isEventStream(response) || !response.body) return parseAnthropicResponse(await response.json(), model, token);
      return await readAnthropicStream(response.body, onDelta, onChunk, model, token);
    });
  }
}

/** Reads Anthropic Messages SSE events. Text deltas go to onDelta; tool input JSON is accumulated per block index. */
async function readAnthropicStream(body: ReadableStream<Uint8Array>, onDelta: (text: string) => void, onChunk: () => void, model: string, token: string): Promise<ModelResponse> {
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let hasUsage = false;
  const blocks = new Map<number, { kind: 'text' } | { kind: 'tool'; id: string; name: string; json: string }>();
  await readSseData(body, onChunk, (event) => {
    const index = typeof event.index === 'number' ? event.index : -1;
    if (event.type === 'content_block_start') {
      const block = event.content_block as { type?: unknown; id?: unknown; name?: unknown } | undefined;
      if (block?.type === 'tool_use') {
        blocks.set(index, { kind: 'tool', id: typeof block.id === 'string' ? block.id : `tool_${index}`, name: typeof block.name === 'string' ? block.name : '', json: '' });
      } else if (block?.type === 'text') {
        blocks.set(index, { kind: 'text' });
      }
    } else if (event.type === 'content_block_delta') {
      const delta = event.delta as { type?: unknown; text?: unknown; partial_json?: unknown } | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        text += delta.text;
        onDelta(delta.text);
      } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const block = blocks.get(index);
        if (block?.kind === 'tool') block.json += delta.partial_json;
      }
    } else if (event.type === 'message_start') {
      const usage = (event.message as { usage?: unknown } | undefined)?.usage;
      const counts = readUsageCounts(usage, 'input_tokens', 'output_tokens');
      if (counts.input !== undefined) { inputTokens = counts.input; hasUsage = true; }
    } else if (event.type === 'message_delta') {
      const counts = readUsageCounts(event.usage, 'input_tokens', 'output_tokens');
      if (counts.output !== undefined) { outputTokens = counts.output; hasUsage = true; }
    } else if (event.type === 'error') {
      streamFailure();
    }
  });
  const toolCalls: ModelToolCall[] = [];
  for (const block of [...blocks.values()]) {
    if (block.kind === 'tool') toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: block.json.trim() ? block.json : '{}' } });
  }
  const usage: ModelUsage | undefined = hasUsage ? { input_tokens: inputTokens, output_tokens: outputTokens } : undefined;
  return { model, token_id: token, content: text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}), ...(usage ? { usage } : {}) };
}

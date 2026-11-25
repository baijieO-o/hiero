import { error } from './contracts.js';
import type { ModelMessage, ModelProviderConfig, ModelRequest, ModelResponse, ModelToolCall, ModelTransport, ModelUsage } from './model-gateway.js';
import { OpenAICompatibleTransport } from './model-gateway.js';
import { normalizeEndpoint } from './llm-env.js';
import type { ModelParams } from './config.js';

/** Wire-format adapters for non-OpenAI protocols. Each maps the internal OpenAI-style message model to one provider API. */

interface ProtocolFetchOptions {
  timeoutMs?: number;
  maxTokens?: number;
}

/** Runs one HTTP request with a timeout that is also cancelled by the caller's signal. */
async function postJson(url: string, headers: Record<string, string>, body: unknown, request: ModelRequest, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onCancel = () => controller.abort();
  request.signal?.addEventListener('abort', onCancel, { once: true });
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal });
    if (!response.ok) {
      const failure = new Error(`Model request failed with status ${response.status}`) as Error & { status: number };
      failure.status = response.status;
      throw failure;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onCancel);
  }
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

/** Builds the transport for a provider's configured protocol. */
export function transportForProtocol(config: Pick<ModelProviderConfig, 'endpoint' | 'protocol'>, maxTokens: number | undefined, paramsFor: (model: string | undefined) => ModelParams): ModelTransport {
  switch (config.protocol) {
    case 'anthropic':
      return new AnthropicMessagesTransport(normalizeAnthropicEndpoint(config.endpoint), { ...(maxTokens ? { maxTokens } : {}) });
    case 'openai':
      return new OpenAICompatibleTransport(normalizeEndpoint(config.endpoint), undefined, maxTokens, paramsFor);
    default:
      throw new Error(`协议 ${config.protocol} 尚未实现。`);
  }
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
    const body = {
      model: request.model,
      max_tokens: this.options.maxTokens ?? 4096,
      messages,
      ...(system ? { system } : {}),
      ...(tools ? { tools } : {}),
    };
    const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' };
    if (token) headers['x-api-key'] = token;
    const payload = await postJson(this.endpoint, headers, body, request, this.options.timeoutMs ?? 120_000);
    return parseAnthropicResponse(payload, request.model ?? 'unknown', token);
  }
}

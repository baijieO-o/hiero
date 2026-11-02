import { randomUUID } from 'node:crypto';
import { error, HieroError, type TaskContract } from './contracts.js';

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: readonly string[];
  tool_call_id?: string;
  name?: string;
  tool_calls?: readonly ModelToolCall[];
}

export interface ModelToolDefinition {
  type: 'function';
  function: { name: string; description?: string; parameters: unknown };
}

export interface ModelToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ModelRequest {
  prompt: string;
  model?: string;
  messages?: readonly ModelMessage[];
  tools?: readonly ModelToolDefinition[];
  onDelta?: (text: string) => void;
  /** Aborts the in-flight request when the caller cancels (for example, the user pressed Stop). */
  signal?: AbortSignal;
}

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface ModelResponse {
  model: string;
  token_id: string;
  content: string;
  tool_calls?: readonly ModelToolCall[];
  usage?: ModelUsage;
}

/** Reads OpenAI-style `usage` counts. Returns undefined when the provider omits them. */
function parseUsage(raw: unknown): ModelUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as { prompt_tokens?: unknown; completion_tokens?: unknown };
  if (typeof value.prompt_tokens !== 'number' || typeof value.completion_tokens !== 'number') return undefined;
  return { input_tokens: value.prompt_tokens, output_tokens: value.completion_tokens };
}

export interface ModelTransport {
  complete(request: ModelRequest, token: string): Promise<ModelResponse>;
}

interface TokenState {
  token: string;
  cooldownUntil: number;
  retired: boolean;
}

export class ModelGateway {
  private readonly tokens: TokenState[];
  private cursor = 0;

  public constructor(
    private readonly transport: ModelTransport,
    tokens: readonly string[],
    private readonly now: () => number = Date.now,
    private readonly cooldownMs = 60_000,
  ) {
    this.tokens = tokens.map((token) => ({ token, cooldownUntil: 0, retired: false }));
  }

  public async complete(task: TaskContract, request: Omit<ModelRequest, 'model'>): Promise<ModelResponse> {
    if (request.signal?.aborted) throw error('MOD-007', 'degradation', 'Model request was cancelled by the user.', 'Send a new message to continue.');
    const model = task.model_config.preferred_model;
    const models = [model, ...task.model_config.fallback_chain.filter((candidate) => candidate !== model)];
      const localModel = models[0];
      if (this.tokens.length === 0 && localModel) {
        return await this.transport.complete({ prompt: request.prompt, model: localModel, ...(request.messages ? { messages: request.messages } : {}), ...(request.tools ? { tools: request.tools } : {}), ...(request.onDelta ? { onDelta: request.onDelta } : {}), ...(request.signal ? { signal: request.signal } : {}) }, '');
      }
    if (this.tokens.length === 0) throw error('MOD-003', 'blocker', 'Token pool is empty.', 'Configure a model token or use a local OpenAI-compatible model that does not require authentication.');

    let attempted = 0;
    let lastRetryable = false;
    while (attempted < this.tokens.length * models.length) {
      const tokenState = this.nextAvailableToken();
      if (!tokenState) break;
      const selectedModel = models[attempted % models.length];
      if (!selectedModel) throw error('MOD-001', 'blocker', 'No model is available for this request.', 'Configure a preferred model or fallback chain.');
      attempted += 1;
      try {
        const modelRequest: ModelRequest = { prompt: request.prompt, model: selectedModel, ...(request.messages ? { messages: request.messages } : {}), ...(request.tools ? { tools: request.tools } : {}), ...(request.onDelta ? { onDelta: request.onDelta } : {}), ...(request.signal ? { signal: request.signal } : {}) };
        return await this.transport.complete(modelRequest, tokenState.token);
      } catch (cause) {
        if (request.signal?.aborted) throw error('MOD-007', 'degradation', 'Model request was cancelled by the user.', 'Send a new message to continue.');
        if (cause instanceof HieroError && cause.record.code === 'MOD-007') throw cause;
        const status = statusCode(cause);
        if (status === 429) {
          tokenState.cooldownUntil = this.now() + this.cooldownMs;
          lastRetryable = true;
          continue;
        }
        if (status === 401) {
          tokenState.retired = true;
          lastRetryable = true;
          continue;
        }
        if (isRetryableFailure(cause)) {
          lastRetryable = true;
          continue;
        }
        if (cause instanceof HieroError) throw cause;
        throw error('MOD-002', 'blocker', 'Model channel failed without a recoverable fallback.', 'Inspect the model transport and fallback configuration.');
      }
    }
    if (this.tokens.every((candidate) => candidate.retired)) {
      throw error('MOD-003', 'blocker', 'All model tokens were rejected (401).', 'Replace the invalid tokens in HIERO_LLM_TOKENS.');
    }
    if (lastRetryable) throw error('MOD-003', 'degradation', 'No model token is currently available.', 'Wait for cooldown, check the endpoint, or configure another token.');
    throw error('MOD-001', 'blocker', 'No model is available for this request.', 'Check model configuration, token health, and fallback channels.');
  }

  public tokenStatuses(): readonly { token: string; cooldownUntil: number; retired: boolean }[] {
    return this.tokens.map(({ token, cooldownUntil, retired }) => ({ token, cooldownUntil, retired }));
  }

  private nextAvailableToken(): TokenState | undefined {
    for (let offset = 0; offset < this.tokens.length; offset += 1) {
      const index = (this.cursor + offset) % this.tokens.length;
      const candidate = this.tokens[index];
      if (candidate && !candidate.retired && candidate.cooldownUntil <= this.now()) {
        this.cursor = (index + 1) % this.tokens.length;
        return candidate;
      }
    }
    return undefined;
  }
}

function statusCode(cause: unknown): number | undefined {
  if (cause instanceof HieroError) return undefined;
  if (typeof cause === 'object' && cause !== null && 'status' in cause && typeof cause.status === 'number') return cause.status;
  return undefined;
}

function isRetryableFailure(cause: unknown): boolean {
  const status = statusCode(cause);
  if (status !== undefined) return status >= 500;
  if (cause instanceof HieroError) return false;
  return cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TypeError');
}

export function parseTokenList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[,\n;]/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function toWireMessage(message: ModelMessage): Record<string, unknown> {
  const { images, ...rest } = message;
  if (!images || images.length === 0) return rest;
  return { ...rest, content: [{ type: 'text', text: message.content }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] };
}

export class OpenAICompatibleTransport implements ModelTransport {
  public constructor(private readonly endpoint: string, private readonly timeoutMs = 30_000) {}

  public async complete(request: ModelRequest, token: string): Promise<ModelResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const onCancel = () => controller.abort();
    if (request.signal?.aborted) controller.abort();
    request.signal?.addEventListener('abort', onCancel, { once: true });
    try {
      const endpoint = this.endpoint;
      if (!endpoint) throw error('MOD-002', 'blocker', 'Model endpoint is not configured.', 'Set HIERO_LLM_ENDPOINT before starting the runtime.');
      const streaming = request.onDelta !== undefined;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (token) headers.authorization = 'Bearer ' + token;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: request.model,
          messages: (request.messages ?? [{ role: 'user', content: request.prompt }]).map(toWireMessage),
          ...(request.tools ? { tools: request.tools } : {}),
          ...(streaming ? { stream: true, stream_options: { include_usage: true } } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const failure = new Error(`Model request failed with status ${response.status}`) as Error & { status: number };
        failure.status = response.status;
        throw failure;
      }
      const isEventStream = (response.headers.get('content-type') ?? '').includes('text/event-stream');
      if (streaming && isEventStream && response.body) {
        return await readStream(response.body, request.model ?? 'unknown', token, request.onDelta!);
      }
      const payload: unknown = await response.json();
      return parseModelResponse(payload, request.model ?? 'unknown', token);
    } catch (cause) {
      if (request.signal?.aborted) throw error('MOD-007', 'degradation', 'Model request was cancelled by the user.', 'Send a new message to continue.');
      throw cause;
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', onCancel);
    }
  }
}

async function readStream(body: ReadableStream<Uint8Array>, model: string, token: string, onDelta: (text: string) => void): Promise<ModelResponse> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let content = '';
  let usage: ModelUsage | undefined;
  const toolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = [];
  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let chunk: unknown;
    try { chunk = JSON.parse(data); } catch { return; }
    usage = parseUsage((chunk as { usage?: unknown }).usage) ?? usage;
    const delta = (chunk as { choices?: { delta?: { content?: unknown; tool_calls?: unknown } }[] }).choices?.[0]?.delta;
    const text = delta?.content;
    if (typeof text === 'string' && text.length > 0) {
      content += text;
      onDelta(text);
    }
    if (Array.isArray(delta?.tool_calls)) {
      for (const part of delta.tool_calls as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]) {
        const index = typeof part.index === 'number' ? part.index : toolCalls.length;
        const current = toolCalls[index] ?? (toolCalls[index] = { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (typeof part.id === 'string' && part.id) current.id = part.id;
        if (typeof part.function?.name === 'string') current.function.name += part.function.name;
        if (typeof part.function?.arguments === 'string') current.function.arguments += part.function.arguments;
      }
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      handleLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  handleLine(buffer);
  const completed = toolCalls.filter((call) => call.function.name.length > 0);
  return { model, token_id: token, content, ...(completed.length > 0 ? { tool_calls: completed } : {}), ...(usage ? { usage } : {}) };
}

function parseModelResponse(payload: unknown, model: string, token: string): ModelResponse {
  if (typeof payload !== 'object' || payload === null) throw error('MOD-004', 'blocker', 'Model response format is invalid.', 'Check the provider response schema.');
  const choice = (payload as { choices?: unknown[] }).choices?.[0];
  const message = choice && typeof choice === 'object' ? (choice as { message?: unknown }).message : undefined;
  if (typeof message !== 'object' || message === null) throw error('MOD-004', 'blocker', 'Model response is missing a valid message.', 'Check the provider response schema.');
  const content = (message as { content?: unknown }).content;
  const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
  if (content !== undefined && content !== null && typeof content !== 'string') throw error('MOD-004', 'blocker', 'Model response content is invalid.', 'Check the provider response schema.');
  if (toolCalls !== undefined && toolCalls !== null && !Array.isArray(toolCalls)) throw error('MOD-004', 'blocker', 'Model tool calls are invalid.', 'Check the provider response schema.');
  const parsedCalls = Array.isArray(toolCalls) ? toolCalls.map(parseToolCall) : undefined;
  const usage = parseUsage((payload as { usage?: unknown }).usage);
  return { model, token_id: token, content: typeof content === 'string' ? content : '', ...(parsedCalls && parsedCalls.length > 0 ? { tool_calls: parsedCalls } : {}), ...(usage ? { usage } : {}) };
}

function parseToolCall(raw: unknown): ModelToolCall {
  if (typeof raw !== 'object' || raw === null) throw error('MOD-004', 'blocker', 'Model tool call format is invalid.', 'Check the provider response schema.');
  const value = raw as { id?: unknown; type?: unknown; function?: unknown };
  const fn = value.function;
  if (typeof value.id !== 'string' || value.type !== 'function' || typeof fn !== 'object' || fn === null || typeof (fn as { name?: unknown }).name !== 'string' || typeof (fn as { arguments?: unknown }).arguments !== 'string') {
    throw error('MOD-004', 'blocker', 'Model tool call format is invalid.', 'Check the provider response schema.');
  }
  return { id: value.id, type: 'function', function: { name: (fn as { name: string }).name, arguments: (fn as { arguments: string }).arguments } };
}

export const mockModelTransport = (responses: readonly ModelResponse[]): ModelTransport => {
  let index = 0;
  return { complete: async () => responses[index++] ?? { model: 'mock', token_id: randomUUID(), content: 'mock response' } };
};

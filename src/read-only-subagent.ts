import type { TaskContract } from './contracts.js';
import type { ModelGateway, ModelMessage, ModelResponse, ModelToolDefinition } from './model-gateway.js';
import type { ToolGateway } from './tool-gateway.js';

export const SUBAGENT_MAX_TURNS = 4;
export const SUBAGENT_RESULT_LIMIT = 4_000;

export const SUBAGENT_LIMITS = {
  maxTurns: { min: 1, max: 10, default: SUBAGENT_MAX_TURNS },
  resultLimit: { min: 500, max: 20_000, default: SUBAGENT_RESULT_LIMIT },
  /** Sub-agent calls executed from one model turn. Extra calls in the same turn are rejected. */
  maxConcurrent: { min: 1, max: 4, default: 2 },
  /** Sub-agent calls allowed across one chat request. Prevents runaway delegation. */
  maxPerChat: { min: 1, max: 20, default: 6 },
} as const;

export interface SubagentSettings {
  enabled: boolean;
  maxTurns: number;
  resultLimit: number;
  maxConcurrent: number;
  maxPerChat: number;
}

/** Normalises user-provided sub-agent settings. Non-numeric values fall back to defaults and numbers are clamped. */
export function normalizeSubagentSettings(raw: unknown): SubagentSettings {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const clamp = (value: unknown, limit: { min: number; max: number; default: number }): number => {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return limit.default;
    return Math.min(limit.max, Math.max(limit.min, Math.round(numeric)));
  };
  return {
    enabled: record.enabled !== false,
    maxTurns: clamp(record.maxTurns ?? record.max_turns, SUBAGENT_LIMITS.maxTurns),
    resultLimit: clamp(record.resultLimit ?? record.result_limit, SUBAGENT_LIMITS.resultLimit),
    maxConcurrent: clamp(record.maxConcurrent ?? record.max_concurrent, SUBAGENT_LIMITS.maxConcurrent),
    maxPerChat: clamp(record.maxPerChat ?? record.max_per_chat, SUBAGENT_LIMITS.maxPerChat),
  };
}

/**
 * Decides whether one more sub-agent call may run. `delegatedThisTurn` counts calls already made in the current model turn,
 * `delegatedChatTotal` counts calls made across the whole chat request.
 */
export function canDelegate(limits: Pick<SubagentSettings, 'maxConcurrent' | 'maxPerChat'>, delegatedThisTurn: number, delegatedChatTotal: number): boolean {
  return delegatedThisTurn < limits.maxConcurrent && delegatedChatTotal < limits.maxPerChat;
}

export const DELEGATE_READ_TOOL_DEFINITION: ModelToolDefinition = {
  type: 'function',
  function: {
    name: 'delegate_read',
    description: 'Hand a self-contained research question to a read-only sub-agent. It can only use read_file, list_dir and memory_recall, and returns a short summary. Use it for broad exploration that would otherwise fill your context.',
    parameters: { type: 'object', additionalProperties: false, properties: { task: { type: 'string', description: 'The question or exploration goal, self-contained.' } }, required: ['task'] },
  },
};

export const DELEGATE_WRITE_TOOL_DEFINITION: ModelToolDefinition = {
  type: 'function',
  function: {
    name: 'delegate_write',
    description: 'Hand a self-contained file-editing task to a sub-agent. It can read and write workspace files (write_file needs user approval in strict mode) and returns a short summary. It cannot change memory or delegate further.',
    parameters: { type: 'object', additionalProperties: false, properties: { task: { type: 'string', description: 'The editing goal, self-contained, including target file paths.' } }, required: ['task'] },
  },
};

export interface ReadOnlySubagentOptions {
  modelGateway: ModelGateway;
  toolGateway: ToolGateway;
  /** Tool names the sub-agent may call. Must be read-effect tools; the caller enforces this. */
  allowedTools: readonly ModelToolDefinition[];
  /** Full system prompt for the sub-agent. Defaults to the read-only prompt. */
  systemPrompt?: string;
  task: TaskContract;
  goal: string;
  signal?: AbortSignal;
  maxTurns?: number;
  resultLimit?: number;
}

/**
 * Runs a bounded read-only ReAct loop with its own message history.
 * The parent sees only the returned summary, never the sub-agent transcript.
 */
export async function runReadOnlySubagent(options: ReadOnlySubagentOptions): Promise<string> {
  const { modelGateway, toolGateway, allowedTools, task, goal, signal } = options;
  const maxTurns = options.maxTurns ?? SUBAGENT_MAX_TURNS;
  const resultLimit = options.resultLimit ?? SUBAGENT_RESULT_LIMIT;
  const allowed = new Set(allowedTools.map((tool) => tool.function.name));
  const messages: ModelMessage[] = [
    { role: 'system', content: options.systemPrompt ?? 'You are a read-only research sub-agent. Use the tools to investigate, then reply with a concise final answer (under 300 words). You cannot modify files.' },
    { role: 'user', content: goal },
  ];

  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (signal?.aborted) throw new Error('Sub-agent was cancelled.');
    const response: ModelResponse = await modelGateway.complete(task, { prompt: goal, messages, tools: allowedTools, ...(signal ? { signal } : {}) });
    if (!response.tool_calls || response.tool_calls.length === 0) {
      return truncate(response.content, resultLimit);
    }
    messages.push({ role: 'assistant', content: response.content, tool_calls: response.tool_calls });
    for (const call of response.tool_calls) {
      let result: string;
      if (!allowed.has(call.function.name)) {
        result = JSON.stringify({ error: `Tool '${call.function.name}' is not available to the read-only sub-agent.` });
      } else {
        try {
          const args = JSON.parse(call.function.arguments) as unknown;
          const record = await toolGateway.execute(call.function.name, args, call.id || call.function.name, task.permission_mode);
          result = JSON.stringify(record.result);
        } catch (cause) {
          result = JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) });
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: result });
    }
  }
  return `Sub-agent stopped after ${maxTurns} turns without a final answer. Partial progress is not available; narrow the task.`;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

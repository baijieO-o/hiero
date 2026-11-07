import type { ModelMessage, ModelToolDefinition } from './model-gateway.js';

/** Default context window of the chat model when the gateway does not report one. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

export interface ContextUsageBreakdown {
  window: number;
  total: number;
  system: number;
  tools: number;
  tool_results: number;
  messages: number;
}

/** Same heuristic as the agent executor: about 4 characters per token. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Splits the estimated usage of one chat request into the categories shown in the session info panel. */
export function breakdownContextUsage(messages: readonly ModelMessage[], tools: readonly ModelToolDefinition[], window = DEFAULT_CONTEXT_WINDOW): ContextUsageBreakdown {
  let system = 0;
  let toolResults = 0;
  let conversation = 0;
  for (const message of messages) {
    const tokens = estimateTextTokens(`${message.role}${message.content}`);
    if (message.role === 'system') system += tokens;
    else if (message.role === 'tool') toolResults += tokens;
    else conversation += tokens;
  }
  const toolDefinitions = estimateTextTokens(JSON.stringify(tools));
  const total = system + toolDefinitions + toolResults + conversation;
  return { window, total, system, tools: toolDefinitions, tool_results: toolResults, messages: conversation };
}

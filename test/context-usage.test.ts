import assert from 'node:assert/strict';
import { test } from 'node:test';
import { breakdownContextUsage, estimateTextTokens } from '../src/context-usage.js';
import type { ModelMessage, ModelToolDefinition } from '../src/model-gateway.js';

const tools: ModelToolDefinition[] = [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object' } } }];

test('breakdown separates system, tool results, conversation and tool definitions', () => {
  const messages: ModelMessage[] = [
    { role: 'system', content: 'a'.repeat(400) },
    { role: 'user', content: 'b'.repeat(80) },
    { role: 'tool', content: 'c'.repeat(200), tool_call_id: 'x' } as ModelMessage,
  ];
  const usage = breakdownContextUsage(messages, tools, 128_000);
  assert.equal(usage.window, 128_000);
  assert.equal(usage.system, estimateTextTokens(`system${'a'.repeat(400)}`));
  assert.equal(usage.tool_results, estimateTextTokens(`tool${'c'.repeat(200)}`));
  assert.equal(usage.messages, estimateTextTokens(`user${'b'.repeat(80)}`));
  assert.equal(usage.tools, estimateTextTokens(JSON.stringify(tools)));
  assert.equal(usage.total, usage.system + usage.tools + usage.tool_results + usage.messages);
});

test('estimateTextTokens rounds up at about four characters per token', () => {
  assert.equal(estimateTextTokens(''), 0);
  assert.equal(estimateTextTokens('abcd'), 1);
  assert.equal(estimateTextTokens('abcde'), 2);
});

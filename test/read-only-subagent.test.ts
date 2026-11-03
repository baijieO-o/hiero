import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskContract } from '../src/contracts.js';
import type { ModelGateway, ModelResponse, ModelToolDefinition } from '../src/model-gateway.js';
import { ToolGateway } from '../src/tool-gateway.js';
import { z } from 'zod';
import { canDelegate, DELEGATE_TASK_TOOL_DEFINITION, normalizeSubagentSettings, runReadOnlySubagent } from '../src/read-only-subagent.js';

const task: TaskContract = {
  task_id: 't',
  workspace_path: '.',
  model_config: { preferred_model: 'm', fallback_chain: [] },
  permission_mode: 'auto',
  context_mode: 'ephemeral',
  acceptance_criteria: [],
  budget_envelope: { max_tokens: 4000, max_time_ms: 120_000 },
};

const readTool: ModelToolDefinition = { type: 'function', function: { name: 'read_file', parameters: {} } };

function scriptedModel(responses: ModelResponse[]): ModelGateway {
  let index = 0;
  return { complete: async () => responses[Math.min(index++, responses.length - 1)] } as unknown as ModelGateway;
}

function reply(content: string, toolCalls?: { id: string; name: string; arguments: string }[]): ModelResponse {
  const tool_calls = toolCalls?.map((call) => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.arguments } }));
  return { content, model: 'm', token_id: 't', tool_calls } as unknown as ModelResponse;
}

test('sub-agent returns the final answer when the model needs no tools', async () => {
  const summary = await runReadOnlySubagent({
    modelGateway: scriptedModel([reply('done')]),
    toolGateway: new ToolGateway(),
    allowedTools: [readTool],
    task,
    goal: 'find X',
  });
  assert.equal(summary, 'done');
});

test('sub-agent rejects tools outside the read-only allowlist', async () => {
  const gateway = new ToolGateway();
  let called = false;
  gateway.register({ name: 'write_file', inputSchema: z.object({}), effect: 'workspace', irreversible: true, execute: () => { called = true; return {}; } });
  const model = scriptedModel([reply('', [{ id: '1', name: 'write_file', arguments: '{}' }]), reply('final')]);
  const summary = await runReadOnlySubagent({ modelGateway: model, toolGateway: gateway, allowedTools: [readTool], task, goal: 'g' });
  assert.equal(summary, 'final');
  assert.equal(called, false);
});

test('write sub-agent still goes through the approval hook before writing', async () => {
  const gateway = new ToolGateway();
  let written = false;
  gateway.register({ name: 'write_file', inputSchema: z.object({}).passthrough(), effect: 'workspace', irreversible: true, execute: () => { written = true; return { ok: true }; } });
  const approvals: string[] = [];
  gateway.setApprover(async (name) => { approvals.push(name); return { approved: false }; });
  const writeTool: ModelToolDefinition = { type: 'function', function: { name: 'write_file', parameters: {} } };
  const model = scriptedModel([reply('', [{ id: '1', name: 'write_file', arguments: '{}' }]), reply('denied')]);
  const summary = await runReadOnlySubagent({ modelGateway: model, toolGateway: gateway, allowedTools: [writeTool], task: { ...task, permission_mode: 'strict' }, goal: 'g' });
  assert.equal(summary, 'denied');
  assert.deepEqual(approvals, ['write_file']);
  assert.equal(written, false);
});

test('sub-agent stops after its turn cap', async () => {
  const loop = reply('', [{ id: '1', name: 'read_file', arguments: '{}' }]);
  const gateway = new ToolGateway();
  gateway.register({ name: 'read_file', inputSchema: z.object({}).passthrough(), effect: 'read', execute: () => ({ ok: true }) });
  const summary = await runReadOnlySubagent({ modelGateway: scriptedModel([loop]), toolGateway: gateway, allowedTools: [readTool], task, goal: 'g', maxTurns: 2 });
  assert.match(summary, /stopped after 2 turns/);
});

test('sub-agent truncates its summary to the configured result limit', async () => {
  const summary = await runReadOnlySubagent({ modelGateway: scriptedModel([reply('abcdefghij')]), toolGateway: new ToolGateway(), allowedTools: [readTool], task, goal: 'g', resultLimit: 500 });
  assert.equal(summary, 'abcdefghij');
  const long = await runReadOnlySubagent({ modelGateway: scriptedModel([reply('x'.repeat(600))]), toolGateway: new ToolGateway(), allowedTools: [readTool], task, goal: 'g', resultLimit: 500 });
  assert.equal(long, `${'x'.repeat(500)}…`);
});

test('canDelegate enforces both the per-turn and the per-chat sub-agent caps', () => {
  const limits = { maxConcurrent: 2, maxPerChat: 3 };
  assert.equal(canDelegate(limits, 0, 0), true);
  assert.equal(canDelegate(limits, 1, 1), true);
  assert.equal(canDelegate(limits, 2, 2), false, 'per-turn cap reached');
  assert.equal(canDelegate(limits, 0, 3), false, 'per-chat cap reached even with a fresh turn');
});

test('normalizeSubagentSettings applies defaults and clamps out-of-range values', () => {
  assert.deepEqual(normalizeSubagentSettings(undefined), { enabled: true, maxTurns: 4, resultLimit: 4000, maxConcurrent: 2, maxPerChat: 6 });
  assert.deepEqual(normalizeSubagentSettings({ enabled: false, maxTurns: 99, resultLimit: 1, maxConcurrent: 0, maxPerChat: 99 }), { enabled: false, maxTurns: 10, resultLimit: 500, maxConcurrent: 1, maxPerChat: 20 });
  assert.deepEqual(normalizeSubagentSettings({ maxTurns: 0, resultLimit: 1_000_000 }), { enabled: true, maxTurns: 1, resultLimit: 20_000, maxConcurrent: 2, maxPerChat: 6 });
  assert.deepEqual(normalizeSubagentSettings({ max_turns: '6', result_limit: 'nope', max_concurrent: '4', max_per_chat: 3 }), { enabled: true, maxTurns: 6, resultLimit: 4000, maxConcurrent: 4, maxPerChat: 3 });
});

test('general sub-agent runs an external tool it was given through the gateway', async () => {
  const gateway = new ToolGateway();
  let calls = 0;
  gateway.register({ name: 'mcp_search', inputSchema: z.object({}).passthrough(), effect: 'external', execute: () => { calls += 1; return { hits: 2 }; } });
  const externalTool: ModelToolDefinition = { type: 'function', function: { name: 'mcp_search', parameters: {} } };
  const model = scriptedModel([reply('', [{ id: '1', name: 'mcp_search', arguments: '{}' }]), reply('found 2')]);
  const summary = await runReadOnlySubagent({ modelGateway: model, toolGateway: gateway, allowedTools: [externalTool], task, goal: 'g' });
  assert.equal(summary, 'found 2');
  assert.equal(calls, 1);
});

test('delegate_task is a distinct tool that accepts a task and an optional tools query', () => {
  const properties = DELEGATE_TASK_TOOL_DEFINITION.function.parameters as { properties: Record<string, unknown>; required: string[] };
  assert.deepEqual(Object.keys(properties.properties).sort(), ['task', 'tools']);
  assert.deepEqual(properties.required, ['task']);
  assert.equal(DELEGATE_TASK_TOOL_DEFINITION.function.name, 'delegate_task');
});

test('sub-agent aborts when the signal is already cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runReadOnlySubagent({ modelGateway: scriptedModel([reply('x')]), toolGateway: new ToolGateway(), allowedTools: [readTool], task, goal: 'g', signal: controller.signal }), /cancelled/);
});

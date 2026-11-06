import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { z } from 'zod';
import { ToolGateway } from '../src/tool-gateway.js';
import { hitlBreakpointsFromEnv } from '../src/hiero-runtime.js';

function gatewayWithReadTool(): ToolGateway {
  const gateway = new ToolGateway();
  gateway.register({ name: 'read_thing', inputSchema: z.object({ path: z.string() }), effect: 'read', execute: () => ({ ok: true }) });
  return gateway;
}

test('a breakpoint pauses a read-only tool for approval outside auto mode', async () => {
  const gateway = gatewayWithReadTool();
  const asked: string[] = [];
  gateway.setApprover(async (toolName) => { asked.push(toolName); return { approved: true }; });
  gateway.setBreakpoints(['read_thing']);
  const record = await gateway.execute('read_thing', { path: 'a' }, 'intent', 'standard');
  assert.equal(record.success, true);
  assert.deepEqual(asked, ['read_thing']);
});

test('a denied breakpoint blocks execution', async () => {
  const gateway = gatewayWithReadTool();
  gateway.setApprover(async () => ({ approved: false }));
  gateway.setBreakpoints(['read_thing']);
  await assert.rejects(gateway.execute('read_thing', { path: 'a' }, 'intent', 'standard'), /denied by the operator/);
});

test('a breakpoint without an approver fails closed', async () => {
  const gateway = gatewayWithReadTool();
  gateway.setBreakpoints(['read_thing']);
  await assert.rejects(gateway.execute('read_thing', { path: 'a' }, 'intent', 'standard'), /requires approval \(breakpoint\)/);
});

test('auto mode skips breakpoints', async () => {
  const gateway = gatewayWithReadTool();
  gateway.setApprover(async () => { throw new Error('must not ask in auto mode'); });
  gateway.setBreakpoints(['read_thing']);
  const record = await gateway.execute('read_thing', { path: 'a' }, 'intent', 'auto');
  assert.equal(record.success, true);
});

test('tools without a breakpoint run without asking', async () => {
  const gateway = gatewayWithReadTool();
  gateway.setApprover(async () => { throw new Error('must not ask'); });
  gateway.setBreakpoints(['other_tool']);
  const record = await gateway.execute('read_thing', { path: 'a' }, 'intent', 'standard');
  assert.equal(record.success, true);
});

test('HIERO_HITL_TOOLS is parsed as a trimmed comma-separated list', () => {
  assert.deepEqual(hitlBreakpointsFromEnv({ HIERO_HITL_TOOLS: ' write_file, ,edit_file ' }), ['write_file', 'edit_file']);
  assert.deepEqual(hitlBreakpointsFromEnv({}), []);
});

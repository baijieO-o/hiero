import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CapabilityRouter } from '../src/capability-router.js';

test('a failing MCP server is reported as disconnected instead of throwing', async () => {
  const router = new CapabilityRouter();
  const statuses = await router.reloadMcp([{ name: 'broken', transport: 'stdio', command: 'hiero-no-such-command-xyz' }]);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]?.name, 'broken');
  assert.equal(statuses[0]?.connected, false);
  assert.equal(statuses[0]?.tool_count, 0);
  assert.ok(statuses[0]?.error);
  await router.close();
});

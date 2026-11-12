import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { HotPlugRegistry } from '../src/hot-plug.js';
import { CapabilityRouter } from '../src/capability-router.js';
import { McpToolClient } from '../src/mcp-client.js';
import { ToolGateway } from '../src/tool-gateway.js';
import { z } from 'zod';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHotPlugState } from '../src/hot-plug-state.js';

const tempRoot = () => mkdtempSync(join(tmpdir(), 'hiero-hotplug-'));

const broken = (name: string) => ({ name, transport: 'stdio' as const, command: 'hiero-no-such-command-xyz' });

test('enabling a failing MCP server records the error and disabling removes it', async () => {
  const mcp = new McpToolClient();
  const registry = new HotPlugRegistry(mcp, tempRoot());
  registry.defineMcp(broken('plug-a'));

  const enabled = await registry.enableMcp('plug-a');
  assert.equal(enabled.enabled, true);
  assert.ok(enabled.error);
  assert.deepEqual(registry.list().map((plug) => plug.id), ['mcp:plug-a']);

  const disabled = await registry.disable('mcp:plug-a');
  assert.equal(disabled.enabled, false);
  assert.deepEqual(registry.list(), []);

  await registry.disposeAll();
  await mcp.close();
});

test('skill and built-in tool toggles are runtime-only and default to enabled', () => {
  const registry = new HotPlugRegistry(new McpToolClient(), tempRoot());
  assert.equal(registry.isSkillEnabled('pdf'), true);
  assert.equal(registry.isToolEnabled('web_search'), true);

  registry.setSkillEnabled('pdf', false);
  registry.setToolEnabled('web_search', false);
  assert.equal(registry.isSkillEnabled('pdf'), false);
  assert.equal(registry.isToolEnabled('web_search'), false);
  assert.deepEqual(registry.disabledToolNames(), ['web_search']);

  registry.setSkillEnabled('pdf', true);
  registry.setToolEnabled('web_search', true);
  assert.equal(registry.isSkillEnabled('pdf'), true);
  assert.deepEqual(registry.disabledToolNames(), []);
});

test('unregistering a tool removes it from the gateway', () => {
  const gateway = new ToolGateway();
  gateway.register({ name: 'probe', inputSchema: z.object({}), execute: async () => ({ ok: true }) });
  assert.deepEqual(gateway.registeredNames(), ['probe']);
  assert.equal(gateway.unregister('probe'), true);
  assert.deepEqual(gateway.registeredNames(), []);
  assert.equal(gateway.unregister('probe'), false);
});

test('enabling an unknown MCP definition is rejected', async () => {
  const mcp = new McpToolClient();
  const registry = new HotPlugRegistry(mcp, tempRoot());
  await assert.rejects(() => registry.enableMcp('missing'));
  await registry.disposeAll();
  await mcp.close();
});

test('a runtime-disabled skill is hidden from the router but stays discoverable', async () => {
  const hidden = new Set(['agent_reach']);
  const router = new CapabilityRouter(new McpToolClient(), (name) => !hidden.has(name));
  await router.discoverSkills(process.cwd());
  assert.ok(router.discoveredSkillSummaries().some((s) => s.name === 'agent_reach'), 'agent_reach must be discoverable');
  assert.equal(router.skillSummaries().some((s) => s.name === 'agent_reach'), false);
  hidden.clear();
  assert.equal(router.skillSummaries().some((s) => s.name === 'agent_reach'), true);
});
test('skill and tool toggles persist across registry instances', () => {
  const root = tempRoot();
  const first = new HotPlugRegistry(new McpToolClient(), root);
  first.setSkillEnabled('pdf', false);
  first.setToolEnabled('web_search', false);
  assert.deepEqual(readHotPlugState(root), { disabledSkills: ['pdf'], disabledTools: ['web_search'] });

  const second = new HotPlugRegistry(new McpToolClient(), root);
  assert.equal(second.isSkillEnabled('pdf'), false);
  assert.equal(second.isToolEnabled('web_search'), false);

  second.setSkillEnabled('pdf', true);
  assert.deepEqual(readHotPlugState(root).disabledSkills, []);
  rmSync(root, { recursive: true, force: true });
});
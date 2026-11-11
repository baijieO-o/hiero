import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CapabilityRouter } from '../src/capability-router.js';
import { ToolGateway } from '../src/tool-gateway.js';
import type { McpToolClient } from '../src/mcp-client.js';

function fakeMcp(tools: { name: string; description?: string }[]): McpToolClient {
  return {
    listTools: async () => tools.map((tool) => ({ ...tool, inputSchema: { type: 'object' as const, properties: {} } })),
    callTool: async () => ({ ok: true }),
  } as unknown as McpToolClient;
}

test('CapabilityRouter matches any word in a multi-word tool query', async () => {
  const router = new CapabilityRouter(fakeMcp([
    { name: 'read_file', description: 'Read a file from disk' },
    { name: 'send_mail', description: 'Send an email' },
  ]));
  const found = await router.searchTools('read the file');
  assert.deepEqual(found.map((tool) => tool.function.name), ['read_file']);
  assert.deepEqual(await router.searchTools('   '), []);
});

test('MCP tools require approval in strict mode', async () => {
  const router = new CapabilityRouter(fakeMcp([{ name: 'send_mail', description: 'Send an email' }]));
  const gateway = new ToolGateway();
  await router.registerTools(gateway, 'mail');
  await assert.rejects(() => gateway.execute('send_mail', {}, 'intent', 'strict'), /requires approval/);
});

test('CapabilityRouter exposes skill metadata first and loads full content on demand', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-skills-'));
  try {
    const skillDir = join(workspace, '.agent', 'skills', 'browser');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\ndescription: Browser automation helpers\n---\n# Full browser skill\nSecret implementation details.');
    const router = new CapabilityRouter();
    const summaries = await router.discoverSkills(workspace);
    // Other scopes (~/.copilot, ~/.codex, ~/.agents) may contribute skills, so check only the one this test created.
    const browser = summaries.find((skill) => skill.name === 'browser');
    assert.equal(browser?.description, 'Browser automation helpers');
    assert.match(router.systemPromptMetadata(), /browser: Browser automation helpers/);
    assert.equal(router.systemPromptMetadata().includes('Secret implementation details'), false);
    assert.match((await router.loadSkill('browser'))?.content ?? '', /Secret implementation details/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('CapabilityRouter truncates long skill descriptions in the system prompt only', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-skills-long-'));
  try {
    const longDescription = `When the user wants ${'something very specific '.repeat(20)}`;
    const skillDir = join(workspace, '.agent', 'skills', 'verbose');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), `---\ndescription: ${longDescription}\n---\n# Body`);
    const router = new CapabilityRouter();
    await router.discoverSkills(workspace);
    const line = router.systemPromptMetadata().split('\n').find((item) => item.startsWith('- verbose:')) ?? '';
    assert.ok(line.length > 0 && line.length <= '- verbose: '.length + 120, `metadata line too long: ${line.length}`);
    assert.ok(line.endsWith('…'));
    const detail = await router.loadSkill('verbose');
    assert.equal(detail?.description, longDescription.trim());
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

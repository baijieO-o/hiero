import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CapabilityRouter } from '../src/capability-router.js';
import { LOAD_SKILL_TOOL_DEFINITION, registerLoadSkillTool } from '../src/skill-tool.js';
import { ToolGateway } from '../src/tool-gateway.js';

test('load_skill returns the full SKILL.md body for a discovered skill', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-load-skill-'));
  try {
    const skillDir = join(workspace, '.agent', 'skills', 'report');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\ndescription: Write weekly reports\n---\nStep 1: collect metrics.');
    const router = new CapabilityRouter();
    await router.discoverSkills(workspace);
    const gateway = new ToolGateway();
    registerLoadSkillTool(gateway, router);
    const record = await gateway.execute('load_skill', { name: 'report' }, 'intent', 'standard');
    const result = record.result as { name: string; content: string };
    assert.equal(result.name, 'report');
    assert.match(result.content, /Step 1: collect metrics/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('load_skill reports unknown skill names without throwing', async () => {
  const router = new CapabilityRouter();
  await router.discoverSkills(process.cwd());
  const gateway = new ToolGateway();
  registerLoadSkillTool(gateway, router);
  const record = await gateway.execute('load_skill', { name: 'no-such-skill-xyz' }, 'intent', 'standard');
  assert.match(String((record.result as { error?: string }).error), /Unknown skill/);
});

test('load_skill is a read-only tool definition with a required name', () => {
  assert.equal(LOAD_SKILL_TOOL_DEFINITION.function.name, 'load_skill');
  assert.deepEqual((LOAD_SKILL_TOOL_DEFINITION.function.parameters as { required: string[] }).required, ['name']);
});

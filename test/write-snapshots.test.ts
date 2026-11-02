import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { createWriteFileTool } from '../src/basic-tools.js';
import { ToolGateway } from '../src/tool-gateway.js';
import { WriteSnapshotStore } from '../src/write-snapshots.js';

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'hiero-snap-'));
}

test('rollback restores overwritten files and removes newly created ones', async () => {
  const root = await workspace();
  try {
    const snapshots = new WriteSnapshotStore();
    const gateway = new ToolGateway();
    gateway.register(createWriteFileTool(root, snapshots));
    await writeFile(join(root, 'a.txt'), 'original', 'utf8');
    await gateway.execute('write_file', { path: 'a.txt', content: 'changed' }, 'intent-1', 'auto');
    await gateway.execute('write_file', { path: 'new.txt', content: 'fresh' }, 'intent-1', 'auto');

    const result = await snapshots.rollback();

    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'original');
    await assert.rejects(stat(join(root, 'new.txt')));
    assert.equal(result.restored.length, 2);
    assert.deepEqual(result.skipped, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rollback skips files a human edited after the agent wrote them', async () => {
  const root = await workspace();
  try {
    const snapshots = new WriteSnapshotStore();
    const gateway = new ToolGateway();
    gateway.register(createWriteFileTool(root, snapshots));
    await writeFile(join(root, 'a.txt'), 'original', 'utf8');
    await gateway.execute('write_file', { path: 'a.txt', content: 'agent' }, 'intent-1', 'auto');
    await writeFile(join(root, 'a.txt'), 'human edit', 'utf8');

    const result = await snapshots.rollback();

    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'human edit');
    assert.equal(result.skipped.length, 1);
    assert.equal(result.restored.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('standard mode auto-allows workspace writes without approval', async () => {
  const root = await workspace();
  try {
    const gateway = new ToolGateway();
    gateway.register(createWriteFileTool(root));
    let asked = false;
    gateway.setApprover(async () => { asked = true; return { approved: false }; });

    await gateway.execute('write_file', { path: 'ok.txt', content: 'x' }, 'intent-1', 'standard');

    assert.equal(asked, false);
    assert.equal(await readFile(join(root, 'ok.txt'), 'utf8'), 'x');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('strict mode still requires approval for workspace writes', async () => {
  const root = await workspace();
  try {
    const gateway = new ToolGateway();
    gateway.register(createWriteFileTool(root));
    gateway.setApprover(async () => ({ approved: false }));

    await assert.rejects(gateway.execute('write_file', { path: 'no.txt', content: 'x' }, 'intent-1', 'strict'), /GOV-001/);
    await assert.rejects(stat(join(root, 'no.txt')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('external-effect tools require approval even in standard mode', async () => {
  const gateway = new ToolGateway();
  gateway.register({
    name: 'delete_remote',
    inputSchema: z.unknown(),
    irreversible: true,
    effect: 'external',
    execute: () => 'deleted',
  });
  let asked = 0;
  gateway.setApprover(async () => { asked += 1; return { approved: true }; });

  await gateway.execute('delete_remote', {}, 'intent-1', 'standard');

  assert.equal(asked, 1);
});

test('network tools require approval unless the mode is auto', async () => {
  const gateway = new ToolGateway();
  gateway.register({
    name: 'fetch_url',
    inputSchema: z.unknown(),
    networkAccess: true,
    execute: () => 'ok',
  });
  let asked = 0;
  gateway.setApprover(async () => { asked += 1; return { approved: false }; });

  await assert.rejects(gateway.execute('fetch_url', {}, 'intent-1', 'standard'), /GOV-001/);
  await gateway.execute('fetch_url', {}, 'intent-1', 'auto');
  assert.equal(asked, 1);
});

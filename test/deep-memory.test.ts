import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addDeepMemory, DEEP_MEMORY_ENTRY_LIMIT_CHARS, searchDeepMemory } from '../src/deep-memory.js';

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-deep-memory-'));
  try { await run(workspace); } finally { await rm(workspace, { recursive: true, force: true }); }
}

test('keyword recall ranks the matching project memory first', async () => {
  await withWorkspace(async (workspace) => {
    await addDeepMemory(workspace, 'project', 'Use pnpm for installing dependencies in this repo');
    await addDeepMemory(workspace, 'project', 'The rewind feature restores overwritten files');
    const hits = await searchDeepMemory(workspace, 'how do I install dependencies with pnpm');
    assert.equal(hits[0]?.content, 'Use pnpm for installing dependencies in this repo');
    assert.ok((hits[0]?.score ?? 0) > 0);
  });
});

test('Chinese queries match through character bigrams without a segmenter', async () => {
  await withWorkspace(async (workspace) => {
    await addDeepMemory(workspace, 'project', '回退功能会恢复被覆盖的文件');
    await addDeepMemory(workspace, 'project', '部署使用 docker 容器');
    const hits = await searchDeepMemory(workspace, '怎么回退文件');
    assert.equal(hits[0]?.content, '回退功能会恢复被覆盖的文件');
  });
});

test('unrelated queries return nothing because keyword overlap is below the threshold', async () => {
  await withWorkspace(async (workspace) => {
    await addDeepMemory(workspace, 'project', 'Use pnpm for installing dependencies');
    assert.deepEqual(await searchDeepMemory(workspace, 'weather in paris tomorrow'), []);
  });
});

test('an entry over the MEM-001 character limit is rejected', async () => {
  await withWorkspace(async (workspace) => {
    await assert.rejects(
      addDeepMemory(workspace, 'project', 'x'.repeat(DEEP_MEMORY_ENTRY_LIMIT_CHARS + 1)),
      /MEM-001/,
    );
  });
});

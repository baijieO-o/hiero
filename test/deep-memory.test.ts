import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addDeepMemory, DEEP_MEMORY_ENTRY_LIMIT_CHARS, listDeepMemory, searchDeepMemory, setDeepMemoryEmbedder } from '../src/deep-memory.js';
import { cosineSimilarity, createEmbedder, embeddingConfigFromEnv } from '../src/embedding.js';

// Fake embedder: vectors point along a topic axis so "install" and "package manager" are semantically close.
const topicEmbedder = async (texts: string[]): Promise<number[][]> => texts.map((text) => {
  const lower = text.toLowerCase();
  return [lower.includes('install') || lower.includes('package') || lower.includes('pnpm') ? 1 : 0, lower.includes('rewind') || lower.includes('回退') ? 1 : 0, 0.1];
});

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

test('vector recall finds a memory that shares no keywords with the query', async () => {
  await withWorkspace(async (workspace) => {
    setDeepMemoryEmbedder(topicEmbedder);
    try {
      await addDeepMemory(workspace, 'project', 'Use pnpm for dependencies');
      await addDeepMemory(workspace, 'project', 'Deploy with docker containers');
      const hits = await searchDeepMemory(workspace, 'how to add a package');
      assert.equal(hits[0]?.content, 'Use pnpm for dependencies');
      assert.ok((hits[0]?.vector_score ?? 0) >= 0.5);
      assert.equal(hits[0]?.keyword_score, 0);
    } finally {
      setDeepMemoryEmbedder(undefined);
    }
  });
});

test('an embedding failure falls back to keyword recall and still stores the entry', async () => {
  await withWorkspace(async (workspace) => {
    setDeepMemoryEmbedder(async () => { throw new Error('network down'); });
    try {
      await addDeepMemory(workspace, 'project', 'Use pnpm for installing dependencies');
      const entries = await listDeepMemory(workspace);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.embedding, undefined);
      const hits = await searchDeepMemory(workspace, 'install pnpm');
      assert.equal(hits[0]?.content, 'Use pnpm for installing dependencies');
      assert.equal(hits[0]?.vector_score, undefined);
    } finally {
      setDeepMemoryEmbedder(undefined);
    }
  });
});

test('entries saved before an embedder existed still match by keyword', async () => {
  await withWorkspace(async (workspace) => {
    await addDeepMemory(workspace, 'project', '回退功能会恢复被覆盖的文件');
    setDeepMemoryEmbedder(topicEmbedder);
    try {
      const hits = await searchDeepMemory(workspace, '怎么回退文件');
      assert.equal(hits[0]?.content, '回退功能会恢复被覆盖的文件');
    } finally {
      setDeepMemoryEmbedder(undefined);
    }
  });
});

test('embedding config is read from HIERO_EMBED_* and disabled when unset', () => {
  assert.equal(embeddingConfigFromEnv({}), undefined);
  assert.deepEqual(
    embeddingConfigFromEnv({ HIERO_EMBED_ENDPOINT: ' http://x/v1/embeddings ', HIERO_EMBED_MODEL: 'm', HIERO_EMBED_TOKENS: 'a, b' }),
    { endpoint: 'http://x/v1/embeddings', model: 'm', token: 'a' },
  );
});

test('the OpenAI-compatible embedder sends a bearer token and orders vectors by index', async () => {
  let seenAuth = '';
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    seenAuth = String((init?.headers as Record<string, string>).authorization);
    return new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }), { status: 200 });
  }) as typeof fetch;
  const embed = createEmbedder({ endpoint: 'http://x', model: 'm', token: 'tok' }, fakeFetch);
  assert.deepEqual(await embed(['a', 'b']), [[1, 0], [0, 1]]);
  assert.equal(seenAuth, 'Bearer tok');
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('an entry over the MEM-001 character limit is rejected', async () => {
  await withWorkspace(async (workspace) => {
    await assert.rejects(
      addDeepMemory(workspace, 'project', 'x'.repeat(DEEP_MEMORY_ENTRY_LIMIT_CHARS + 1)),
      /MEM-001/,
    );
  });
});

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { listDirectory, readTextFile } from '../src/workspace-services.js';

describe('workspace-services', () => {
  let root = '';

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'hiero-ws-'));
    await mkdir(join(root, 'sub'));
    for (const name of ['file10.txt', 'file2.txt', 'file1.txt']) await writeFile(join(root, name), name);
    await writeFile(join(root, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d]));
    await writeFile(join(root, 'plain.md'), '# hello');
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists and reads non-ASCII folder and file names without mojibake', async () => {
    const cjkRoot = await mkdtemp(join(tmpdir(), 'hiero-ws-cjk-'));
    try {
      await mkdir(join(cjkRoot, '利维坦读书分享'));
      await writeFile(join(cjkRoot, '利维坦读书分享', '笔记.md'), '中文内容');
      const { entries } = await listDirectory(cjkRoot, '利维坦读书分享');
      assert.deepEqual(entries.map((entry) => entry.name), ['笔记.md']);
      const file = await readTextFile(cjkRoot, '利维坦读书分享/笔记.md');
      assert.equal(file.content, '中文内容');
    } finally {
      await rm(cjkRoot, { recursive: true, force: true });
    }
  });

  it('sorts folders first and names by natural number order', async () => {
    const { entries } = await listDirectory(root, '');
    assert.equal(entries[0]?.name, 'sub');
    const files = entries.filter((entry) => entry.kind === 'file').map((entry) => entry.name);
    assert.deepEqual(files, ['file1.txt', 'file2.txt', 'file10.txt', 'image.bin', 'plain.md']);
  });

  it('reports text files with binary false and full size', async () => {
    const result = await readTextFile(root, 'plain.md');
    assert.equal(result.binary, false);
    assert.equal(result.content, '# hello');
    assert.equal(result.size, 7);
  });

  it('detects binary files by NUL bytes and returns no content', async () => {
    const result = await readTextFile(root, 'image.bin');
    assert.equal(result.binary, true);
    assert.equal(result.content, '');
    assert.equal(result.size, 5);
  });
});

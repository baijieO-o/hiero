import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createWordCountTool } from '../examples/custom-tool/word-count-tool.js';
import { ToolGateway } from '../src/tool-gateway.js';

describe('custom tool example', () => {
  it('registers through ToolGateway and counts a workspace file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hiero-custom-tool-'));
    try {
      await writeFile(join(root, 'note.txt'), 'one two\nthree\n', 'utf8');
      const gateway = new ToolGateway();
      gateway.register(createWordCountTool(root));

      const evidence = await gateway.execute('word_count', { path: 'note.txt' }, 'intent-1', 'standard');
      assert.deepEqual(evidence.result, { lines: 3, words: 3, chars: 14 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects paths outside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hiero-custom-tool-'));
    try {
      const gateway = new ToolGateway();
      gateway.register(createWordCountTool(root));
      await assert.rejects(gateway.execute('word_count', { path: '../escape.txt' }, 'intent-2', 'standard'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

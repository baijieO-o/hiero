import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LONG_REPLY_THRESHOLD, saveLongReply } from '../src/reply-store.js';

test('saveLongReply writes the full reply under .hiero/replies and returns a short summary', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-reply-'));
  const content = 'A'.repeat(LONG_REPLY_THRESHOLD + 500);
  const saved = await saveLongReply(workspace, 'req-12345678901234', content);

  assert.match(saved.path, /^\.hiero\/replies\/.+-req-12345678\.md$/);
  assert.equal(await readFile(join(workspace, saved.path), 'utf8'), content);
  assert.equal(saved.summary.length, 301);
  assert.ok(saved.summary.endsWith('…'));
});

test('saveLongReply sanitizes the request id used in the file name', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-reply-'));
  const saved = await saveLongReply(workspace, '../../evil id', 'x'.repeat(10));
  assert.ok(!saved.path.includes('..'));
  assert.match(saved.path, /^\.hiero\/replies\/[^/]+-evilid\.md$/);
});

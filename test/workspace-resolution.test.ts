import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveChatWorkspace } from '../src/hiero-runtime.js';

test('resolveChatWorkspace falls back to the runtime cwd when no workspace is given', () => {
  assert.equal(resolveChatWorkspace(undefined), process.cwd());
  assert.equal(resolveChatWorkspace('   '), process.cwd());
});

test('resolveChatWorkspace accepts an existing directory and returns it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hiero-ws-'));
  try {
    assert.equal(resolveChatWorkspace(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveChatWorkspace rejects missing paths instead of silently using the runtime root', () => {
  assert.throws(() => resolveChatWorkspace(join(tmpdir(), 'hiero-does-not-exist-xyz')), /工作区不存在或不是文件夹/);
  assert.throws(() => resolveChatWorkspace('hiero'), /工作区不存在或不是文件夹/);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureConversationWorktree, removeConversationWorktree, worktreeSlug } from '../src/worktree.js';

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'hiero-wt-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
  return root;
}

test('creates one worktree per conversation and reuses it', async () => {
  const root = makeRepo();
  try {
    const first = await ensureConversationWorktree(root, 'chat-1', 'fallback');
    assert.equal(first.isolated, true);
    assert.ok(existsSync(join(first.path, '.git')));
    const again = await ensureConversationWorktree(root, 'chat-1', 'fallback');
    assert.equal(again.path, first.path);
    const other = await ensureConversationWorktree(root, 'chat-2', 'fallback');
    assert.notEqual(other.path, first.path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-git folder falls back to the original folder under the fallback policy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hiero-nogit-'));
  try {
    writeFileSync(join(root, 'a.txt'), 'x');
    const info = await ensureConversationWorktree(root, 'chat-1', 'fallback');
    assert.deepEqual(info, { path: root, isolated: false });
    assert.equal(existsSync(join(root, '.git')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('init policy creates a repo, but with no commits it still falls back to the original folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hiero-init-'));
  try {
    const info = await ensureConversationWorktree(root, 'chat-1', 'init');
    assert.equal(info.isolated, false, 'a repo without commits has no HEAD to branch from');
    assert.equal(existsSync(join(root, '.git')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('removal refuses uncommitted changes unless forced', async () => {
  const root = makeRepo();
  try {
    const info = await ensureConversationWorktree(root, 'chat-1', 'fallback');
    writeFileSync(join(info.path, 'dirty.txt'), 'y');
    await assert.rejects(removeConversationWorktree(root, 'chat-1'));
    await removeConversationWorktree(root, 'chat-1', true);
    assert.equal(existsSync(info.path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('slug strips path characters so ids cannot escape the worktrees folder', () => {
  assert.equal(worktreeSlug('../../etc'), 'etc');
});

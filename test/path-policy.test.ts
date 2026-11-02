import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspacePath } from '../src/basic-tools.js';

test('resolveWorkspacePath rejects traversal, absolute paths, and symlink escapes', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'hiero-ws-'));
  const outside = mkdtempSync(join(tmpdir(), 'hiero-out-'));
  try {
    const workspace = join(sandbox, 'ws');
    mkdirSync(join(workspace, 'src'), { recursive: true });
    assert.equal(resolveWorkspacePath(workspace, 'src/new.ts'), join(workspace, 'src', 'new.ts'));
    assert.throws(() => resolveWorkspacePath(workspace, '../escape.txt'), /inside the configured workspace/);
    assert.throws(() => resolveWorkspacePath(workspace, join(outside, 'x.txt')), /inside the configured workspace/);
    try {
      symlinkSync(outside, join(workspace, 'link'), 'junction');
    } catch {
      return;
    }
    assert.throws(() => resolveWorkspacePath(workspace, 'link/secret.txt'), /inside the configured workspace/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

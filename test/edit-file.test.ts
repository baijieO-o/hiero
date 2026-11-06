import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createEditFileTool } from '../src/basic-tools.js';
import { ToolGateway } from '../src/tool-gateway.js';
import { WriteSnapshotStore } from '../src/write-snapshots.js';

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'hiero-edit-'));
}

test('edit_file replaces a unique occurrence and leaves the rest untouched', async () => {
  const root = await workspace();
  try {
    const gateway = new ToolGateway();
    gateway.register(createEditFileTool(root));
    await writeFile(join(root, 'a.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');

    await gateway.execute('edit_file', { path: 'a.ts', old_string: 'const b = 2;', new_string: 'const b = 3;' }, 'intent-1', 'auto');

    assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'const a = 1;\nconst b = 3;\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('edit_file rejects a missing old_string without modifying the file', async () => {
  const root = await workspace();
  try {
    const gateway = new ToolGateway();
    gateway.register(createEditFileTool(root));
    await writeFile(join(root, 'a.txt'), 'hello', 'utf8');

    await assert.rejects(gateway.execute('edit_file', { path: 'a.txt', old_string: 'missing', new_string: 'x' }, 'intent-1', 'auto'), /not found/);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'hello');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('edit_file rejects an ambiguous old_string without modifying the file', async () => {
  const root = await workspace();
  try {
    const gateway = new ToolGateway();
    gateway.register(createEditFileTool(root));
    await writeFile(join(root, 'a.txt'), 'x and x', 'utf8');

    await assert.rejects(gateway.execute('edit_file', { path: 'a.txt', old_string: 'x', new_string: 'y' }, 'intent-1', 'auto'), /matches 2 places/);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'x and x');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('edit_file records a snapshot so rollback restores the pre-edit content', async () => {
  const root = await workspace();
  try {
    const snapshots = new WriteSnapshotStore();
    const gateway = new ToolGateway();
    gateway.register(createEditFileTool(root, snapshots));
    await writeFile(join(root, 'a.txt'), 'before', 'utf8');

    await gateway.execute('edit_file', { path: 'a.txt', old_string: 'before', new_string: 'after' }, 'intent-1', 'auto');
    const result = await snapshots.rollback();

    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'before');
    assert.equal(result.restored.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('write snapshots persist to disk and survive a reload', async () => {
  const root = await workspace();
  try {
    const file = join(root, 'snapshots.json');
    const first = new WriteSnapshotStore(file);
    first.recordWrite(join(root, 'a.txt'), 'old', 'new');

    const reloaded = new WriteSnapshotStore(file);

    assert.equal(reloaded.list().length, 1);
    assert.equal(reloaded.list()[0]?.previous, 'old');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProcessManager } from '../src/process-manager.js';

function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting for process'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

test('ProcessManager records output, flags error lines, and marks a finished process as exited', async () => {
  const manager = new ProcessManager();
  const info = manager.start('Write-Output "server ready"; Write-Error "boom failed"', process.cwd(), 'agent');
  await waitFor(() => manager.list().find((p) => p.id === info.id)?.status === 'exited');

  const output = manager.output(info.id);
  assert.ok(output.some((line) => line.text.includes('server ready') && !line.error));
  assert.ok(output.some((line) => line.text.includes('boom') && line.error));
  const finished = manager.list().find((p) => p.id === info.id);
  assert.equal(finished?.origin, 'agent');
  assert.ok((finished?.errorLines ?? 0) >= 1);
});

test('ProcessManager keeps only the newest lines within its buffer limit', async () => {
  const manager = new ProcessManager(5);
  const info = manager.start('1..20 | ForEach-Object { Write-Output "line $_" }', process.cwd(), 'manual');
  await waitFor(() => manager.list().find((p) => p.id === info.id)?.status === 'exited');

  const output = manager.output(info.id);
  assert.equal(output.length, 5);
  assert.ok(output.at(-1)?.text.includes('line 20'));
});

test('ProcessManager stop returns false for unknown or already-finished processes', async () => {
  const manager = new ProcessManager();
  assert.equal(manager.stop('missing'), false);
  const info = manager.start('Write-Output done', process.cwd(), 'manual');
  await waitFor(() => manager.list().find((p) => p.id === info.id)?.status === 'exited');
  assert.equal(manager.stop(info.id), false);
});

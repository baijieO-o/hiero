import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state-store.js';

function withFileStore(run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'hiero-state-'));
  try {
    run(join(dir, 'hiero.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('task transitions are recorded and finished tasks keep their status', () => {
  withFileStore((path) => {
    const store = new StateStore(path);
    store.startTask('t1', 'D:/ws', 'build a thing');
    store.recordTransition('t1', 'Plan', 'Exec');
    store.recordTransition('t1', 'Exec', 'Verify');
    store.finishTask('t1', 'completed');

    const [task] = store.listTasks();
    assert.equal(task?.status, 'completed');
    assert.equal(task?.last_state, 'Verify');
    assert.deepEqual(store.listTransitions('t1').map((row) => row.to_state), ['Exec', 'Verify']);
    store.close();
  });
});

test('tasks still running after a restart are marked interrupted', () => {
  withFileStore((path) => {
    const first = new StateStore(path);
    first.startTask('t-crash', 'D:/ws', 'long job');
    first.recordTransition('t-crash', 'Plan', 'Exec');
    first.close();

    const restarted = new StateStore(path);
    assert.deepEqual(restarted.markRunningAsInterrupted(), ['t-crash']);
    const [task] = restarted.listTasks();
    assert.equal(task?.status, 'interrupted');
    assert.equal(task?.last_state, 'Exec');
    assert.deepEqual(restarted.markRunningAsInterrupted(), []);
    restarted.close();
  });
});

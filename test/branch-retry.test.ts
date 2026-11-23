import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSerializedApprover, pickBranchWinner, runBranchRetry } from '../src/branch-retry.js';

test('serialized approver starts the second request only after the first settles', async () => {
  const started: string[] = [];
  let release: (() => void) | undefined;
  const approve = createSerializedApprover(async (name: string) => {
    started.push(name);
    if (name === 'first') await new Promise<void>((resolve) => { release = resolve; });
    return name;
  });
  const first = approve('first');
  const second = approve('second');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['first'], 'second request must wait while the first is pending');
  release?.();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.deepEqual(started, ['first', 'second']);
});

test('serialized approver keeps queueing after a rejected request', async () => {
  const approve = createSerializedApprover(async (name: string) => {
    if (name === 'bad') throw new Error('denied');
    return name;
  });
  await assert.rejects(approve('bad'), /denied/);
  assert.equal(await approve('good'), 'good');
});

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'hiero-branch-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, 'base.txt'), 'base\n');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: root });
  return root;
}

test('winning candidate is merged into the root and losing candidates leave no trace', async () => {
  const root = makeRepo();
  try {
    const result = await runBranchRetry({
      root,
      roundId: 'r1',
      width: 3,
      attempt: async (path, index) => {
        writeFileSync(join(path, `candidate-${index}.txt`), `from ${index}`);
        return { verified: index === 1, steps: index + 1, summary: `candidate ${index}` };
      },
    });
    assert.equal(result.winner?.index, 1);
    assert.equal(readFileSync(join(root, 'candidate-1.txt'), 'utf8'), 'from 1');
    assert.equal(existsSync(join(root, 'candidate-0.txt')), false);
    assert.equal(existsSync(join(root, 'candidate-2.txt')), false);
    assert.equal(existsSync(join(root, '.hiero', 'branches', 'r1-1')), false);
    const branches = execFileSync('git', ['branch', '--list', 'hiero/branch-*'], { cwd: root, encoding: 'utf8' });
    assert.equal(branches.trim(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no verified candidate means nothing is merged and the root is unchanged', async () => {
  const root = makeRepo();
  try {
    const result = await runBranchRetry({
      root,
      roundId: 'r2',
      width: 2,
      attempt: async (path) => {
        writeFileSync(join(path, 'bad.txt'), 'bad');
        return { verified: false, steps: 1, summary: 'failed' };
      },
    });
    assert.equal(result.winner, undefined);
    assert.equal(existsSync(join(root, 'bad.txt')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a candidate that throws is recorded and does not stop the others', async () => {
  const root = makeRepo();
  try {
    const result = await runBranchRetry({
      root,
      roundId: 'r3',
      width: 2,
      attempt: async (path, index) => {
        if (index === 0) throw new Error('model unavailable');
        writeFileSync(join(path, 'ok.txt'), 'ok');
        return { verified: true, steps: 1, summary: 'ok' };
      },
    });
    assert.equal(result.attempts.find((entry) => entry.index === 0)?.error, 'model unavailable');
    assert.equal(result.winner?.index, 1);
    assert.equal(readFileSync(join(root, 'ok.txt'), 'utf8'), 'ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pickBranchWinner prefers verified attempts and then fewer steps', () => {
  const winner = pickBranchWinner([
    { index: 0, branch: 'a', attempt: { verified: false, steps: 1, summary: '' } },
    { index: 1, branch: 'b', attempt: { verified: true, steps: 5, summary: '' } },
    { index: 2, branch: 'c', attempt: { verified: true, steps: 2, summary: '' } },
  ]);
  assert.equal(winner?.index, 2);
});

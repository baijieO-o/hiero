import assert from 'node:assert/strict';
import test from 'node:test';
import { diffLines, diffStats } from '../frontend/src/diff-model.js';

test('diffLines marks unchanged, added and removed lines', () => {
  const lines = diffLines('a\nb\nc', 'a\nx\nc\nd');
  assert.deepEqual(lines, [
    { kind: 'same', text: 'a' },
    { kind: 'del', text: 'b' },
    { kind: 'add', text: 'x' },
    { kind: 'same', text: 'c' },
    { kind: 'add', text: 'd' },
  ]);
  assert.deepEqual(diffStats(lines), { added: 2, removed: 1 });
});

test('diffLines treats an empty side as zero lines', () => {
  assert.deepEqual(diffStats(diffLines('', 'one\ntwo')), { added: 2, removed: 0 });
  assert.deepEqual(diffStats(diffLines('one', '')), { added: 0, removed: 1 });
});

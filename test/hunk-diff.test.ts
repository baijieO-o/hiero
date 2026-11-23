import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { applyHunks, computeHunks } from '../src/hunk-diff.js';

const all = (hunks: { id: number }[]) => new Set(hunks.map((h) => h.id));

test('identical text produces no hunks', () => {
  assert.deepEqual(computeHunks('a\nb', 'a\nb'), []);
});

test('accepting every hunk reproduces the modified text', () => {
  const original = 'one\ntwo\nthree\nfour\nfive';
  const modified = 'one\n2\nthree\nfour\nfive\nsix';
  const hunks = computeHunks(original, modified);
  assert.equal(applyHunks(original, hunks, all(hunks)), modified);
});

test('accepting no hunk keeps the original text', () => {
  const original = 'a\nb\nc';
  const modified = 'a\nX\nc\nd';
  const hunks = computeHunks(original, modified);
  assert.equal(applyHunks(original, hunks, new Set()), original);
});

test('applies only the chosen hunk when several changes exist', () => {
  const original = 'a\nb\nc\nd\ne';
  const modified = 'A\nb\nc\nd\nE';
  const hunks = computeHunks(original, modified);
  assert.equal(hunks.length, 2);
  assert.equal(applyHunks(original, hunks, new Set([hunks[1]!.id])), 'a\nb\nc\nd\nE');
});

test('creating content from an empty file', () => {
  const hunks = computeHunks('', 'hello\nworld');
  assert.equal(applyHunks('', hunks, all(hunks)), 'hello\nworld');
});
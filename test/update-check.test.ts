import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, parseLatestTag } from '../src/update-check.js';

test('parseLatestTag picks the highest semver tag', () => {
  const out = [
    'aaa\trefs/tags/v0.2.0',
    'bbb\trefs/tags/v0.10.1',
    'ccc\trefs/tags/v0.9.9',
    'ddd\trefs/tags/latest',
  ].join('\n');
  assert.equal(parseLatestTag(out), '0.10.1');
});

test('parseLatestTag returns undefined without version tags', () => {
  assert.equal(parseLatestTag(''), undefined);
  assert.equal(parseLatestTag('aaa\trefs/tags/nightly'), undefined);
});

test('compareVersions orders semver numerically', () => {
  assert.ok(compareVersions([0, 2, 4], [0, 2, 3]) > 0);
  assert.ok(compareVersions([0, 10, 0], [0, 9, 9]) > 0);
  assert.equal(compareVersions([1, 0, 0], [1, 0, 0]), 0);
});

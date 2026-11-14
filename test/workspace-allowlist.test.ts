import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { isAllowedWorkspace, loadAllowlist, saveAllowlist } from '../src/workspace-allowlist.js';
import { resolveChatWorkspace } from '../src/hiero-runtime.js';

test('a missing allowlist file only allows the fallback root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hiero-allow-'));
  try {
    assert.deepEqual(loadAllowlist(join(dir, 'none.json'), '/work/app'), [resolve('/work/app')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt allowlist file falls back to the fallback root instead of allowing everything', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hiero-allow-'));
  try {
    const path = join(dir, 'allow.json');
    writeFileSync(path, '{not json', 'utf8');
    assert.deepEqual(loadAllowlist(path, '/work/app'), [resolve('/work/app')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isAllowedWorkspace accepts the root and its children, but not sibling prefixes', () => {
  const root = resolve('/projects/alpha');
  assert.equal(isAllowedWorkspace([root], root), true);
  assert.equal(isAllowedWorkspace([root], join(root, 'src')), true);
  assert.equal(isAllowedWorkspace([root], resolve('/projects/alpha-evil')), false);
  assert.equal(isAllowedWorkspace([root], resolve('/projects/beta')), false);
});

test('resolveChatWorkspace rejects a real folder that is outside the allowlist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hiero-ws-'));
  const inside = join(dir, 'inside');
  const outside = join(dir, 'outside');
  mkdirSync(inside);
  mkdirSync(outside);
  try {
    assert.equal(resolveChatWorkspace(inside, [inside]), inside);
    assert.throws(() => resolveChatWorkspace(outside, [inside]), /不在允许列表中/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveAllowlist round-trips and de-duplicates roots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hiero-allow-'));
  try {
    const path = join(dir, 'nested', 'allow.json');
    saveAllowlist(path, ['/a', '/a', '/b']);
    assert.deepEqual(loadAllowlist(path, '/fallback'), [resolve('/a'), resolve('/b')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

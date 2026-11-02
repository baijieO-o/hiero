import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { checkCommandPolicy, parsePermissionMode } from '../src/permission-policy.js';

test('parsePermissionMode maps Chinese labels and enum values', () => {
  assert.equal(parsePermissionMode('严格', 'standard'), 'strict');
  assert.equal(parsePermissionMode('标准', 'strict'), 'standard');
  assert.equal(parsePermissionMode('自动', 'strict'), 'auto');
  assert.equal(parsePermissionMode('auto', 'strict'), 'auto');
  assert.equal(parsePermissionMode('bogus', 'strict'), 'strict');
  assert.equal(parsePermissionMode(undefined, 'standard'), 'standard');
});

test('strict mode refuses every shell command', () => {
  assert.equal(checkCommandPolicy('ls', 'strict').allowed, false);
});

test('standard mode allows read-only commands and blocks others', () => {
  assert.equal(checkCommandPolicy('git status', 'standard').allowed, true);
  assert.equal(checkCommandPolicy('git push origin main', 'standard').allowed, false);
  assert.equal(checkCommandPolicy('rm -rf build', 'standard').allowed, false);
  assert.equal(checkCommandPolicy('ls | sh', 'standard').allowed, false);
  assert.equal(checkCommandPolicy('cat a; rm a', 'standard').allowed, false);
  assert.equal(checkCommandPolicy('', 'standard').allowed, false);
});

test('standard mode rejects git flags that write files or run programs', () => {
  assert.equal(checkCommandPolicy('git diff --output=out.txt', 'standard').allowed, false);
  assert.equal(checkCommandPolicy('git log -o out.txt', 'standard').allowed, false);
  assert.equal(checkCommandPolicy('git diff --ext-diff', 'standard').allowed, false);
  assert.equal(checkCommandPolicy('git show --textconv HEAD', 'standard').allowed, false);
});

test('standard mode rejects path arguments outside the workspace', () => {
  assert.equal(checkCommandPolicy('cat src/index.ts', 'standard').allowed, true);
  assert.equal(checkCommandPolicy('cat ../secret.txt', 'standard').allowed, false);
  assert.equal(checkCommandPolicy('cat C:\\Windows\\win.ini', 'standard').allowed, false);
  assert.equal(checkCommandPolicy('ls /etc', 'standard').allowed, false);
  assert.equal(checkCommandPolicy('head ~/.ssh/id_rsa', 'standard').allowed, false);
});

test('auto mode allows any command', () => {
  assert.equal(checkCommandPolicy('rm -rf build', 'auto').allowed, true);
});

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SecretStore } from '../src/secret-store.js';
import { loadLocalLlmEnv, migrateEnvSecrets } from '../src/llm-env.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'hiero-secrets-'));
}

test('secret store round-trips a value and never writes plaintext to disk', () => {
  const dir = tempDir();
  try {
    const store = new SecretStore(dir);
    store.set('HIERO_LLM_TOKENS', 'sk-plain-canary-123');
    assert.equal(store.get('HIERO_LLM_TOKENS'), 'sk-plain-canary-123');
    assert.deepEqual(store.list(), ['HIERO_LLM_TOKENS']);
    const onDisk = readFileSync(join(dir, 'secrets.enc.json'), 'utf8');
    assert.ok(!onDisk.includes('sk-plain-canary-123'), 'ciphertext file must not contain the plaintext');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secret store rejects names outside its allow-list', () => {
  const dir = tempDir();
  try {
    const store = new SecretStore(dir);
    assert.throws(() => store.set('PATH' as never, 'x'), /Unknown secret name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secret store delete removes a value and reports whether it existed', () => {
  const dir = tempDir();
  try {
    const store = new SecretStore(dir);
    store.set('HIERO_BRAVE_API_KEY', 'brave-key');
    assert.equal(store.delete('HIERO_BRAVE_API_KEY'), true);
    assert.equal(store.get('HIERO_BRAVE_API_KEY'), undefined);
    assert.equal(store.delete('HIERO_BRAVE_API_KEY'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration moves secrets out of .env, keeps other lines, and writes a backup', () => {
  const dir = tempDir();
  try {
    const store = new SecretStore(join(dir, 'store'));
    writeFileSync(join(dir, '.env'), [
      'HIERO_LLM_ENDPOINT=https://example.test/v1',
      'HIERO_LLM_TOKENS=sk-migrate-canary',
      'HIERO_LLM_PROVIDERS=[{"name":"p","endpoint":"https://x","tokens":["sk-prov-canary"],"models":["m"]}]',
      'HIERO_BRAVE_API_KEY=brave-canary',
      'OTHER_SETTING=keep-me',
      '',
    ].join('\n'), 'utf8');

    const moved = migrateEnvSecrets(store, dir);
    assert.deepEqual(moved.sort(), ['HIERO_BRAVE_API_KEY', 'HIERO_LLM_PROVIDERS', 'HIERO_LLM_TOKENS']);
    assert.equal(store.get('HIERO_LLM_TOKENS'), 'sk-migrate-canary');

    const env = readFileSync(join(dir, '.env'), 'utf8');
    assert.ok(!env.includes('sk-migrate-canary'));
    assert.ok(!env.includes('sk-prov-canary'));
    assert.ok(!env.includes('brave-canary'));
    assert.ok(env.includes('HIERO_LLM_ENDPOINT=https://example.test/v1'));
    assert.ok(env.includes('OTHER_SETTING=keep-me'));
    assert.ok(existsSync(join(dir, '.env.bak')), 'backup must be written before removing lines');
    assert.ok(readFileSync(join(dir, '.env.bak'), 'utf8').includes('sk-migrate-canary'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration is idempotent and does not overwrite existing store values', () => {
  const dir = tempDir();
  try {
    const store = new SecretStore(join(dir, 'store'));
    store.set('HIERO_LLM_TOKENS', 'sk-current');
    writeFileSync(join(dir, '.env'), 'HIERO_LLM_TOKENS=sk-stale\n', 'utf8');
    assert.deepEqual(migrateEnvSecrets(store, dir), []);
    assert.equal(store.get('HIERO_LLM_TOKENS'), 'sk-current');
    assert.deepEqual(migrateEnvSecrets(store, dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadLocalLlmEnv injects secrets from the store into process.env', () => {
  const dir = tempDir();
  const saved = process.env.HIERO_BRAVE_API_KEY;
  try {
    delete process.env.HIERO_BRAVE_API_KEY;
    const store = new SecretStore(join(dir, 'store'));
    store.set('HIERO_BRAVE_API_KEY', 'brave-from-store');
    loadLocalLlmEnv(dir, store);
    assert.equal(process.env.HIERO_BRAVE_API_KEY, 'brave-from-store');
  } finally {
    if (saved === undefined) delete process.env.HIERO_BRAVE_API_KEY; else process.env.HIERO_BRAVE_API_KEY = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { normalizeEndpoint, writeLocalEnv } from '../src/llm-env.js';

test('normalizeEndpoint appends /chat/completions once and trims slashes', () => {
  assert.equal(normalizeEndpoint('https://example.test/v1/'), 'https://example.test/v1/chat/completions');
  assert.equal(normalizeEndpoint('https://example.test/v1/chat/completions'), 'https://example.test/v1/chat/completions');
  assert.equal(normalizeEndpoint('  '), '');
});

test('writeLocalEnv replaces HIERO_LLM_* lines and keeps unrelated lines', () => {
  const root = mkdtempSync(join(tmpdir(), 'hiero-env-'));
  writeFileSync(join(root, '.env'), '# comment\nOTHER=keep\nHIERO_LLM_MODEL=old\n\n', 'utf8');
  writeLocalEnv({ HIERO_LLM_ENDPOINT: 'https://new.test/v1', HIERO_LLM_MODEL: 'new-model', HIERO_LLM_TOKENS: 'a,b' }, root);
  const text = readFileSync(join(root, '.env'), 'utf8');
  assert.ok(text.includes('# comment'));
  assert.ok(text.includes('OTHER=keep'));
  assert.ok(!text.includes('HIERO_LLM_MODEL=old'));
  assert.ok(text.includes('HIERO_LLM_TOKENS=a,b'));
  assert.equal(text.match(/HIERO_LLM_MODEL=/g)?.length, 1);
});

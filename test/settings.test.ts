import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HieroRuntime } from '../src/hiero-runtime.js';
import { SecretStore } from '../src/secret-store.js';

test('saveModelSettings keeps existing tokens when the token field is blank', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hiero-save-'));
  const previous = { endpoint: process.env.HIERO_LLM_ENDPOINT, tokens: process.env.HIERO_LLM_TOKENS, model: process.env.HIERO_LLM_MODEL };
  process.env.HIERO_LLM_TOKENS = 'kept-one,kept-two';
  const runtime = new HieroRuntime(0);
  runtime.secrets = new SecretStore(join(root, 'store'));
  runtime.secrets.set('HIERO_LLM_TOKENS', 'kept-one,kept-two');
  try {
    const saved = runtime.saveModelSettings({ endpoint: 'https://save.test/v1', model: 'save-model', tokens: '' }, root);
    assert.equal(saved.endpoint, 'https://save.test/v1/chat/completions');
    assert.equal(saved.model, 'save-model');
    assert.equal(saved.token_count, 2);
    const text = readFileSync(join(root, '.env'), 'utf8');
    assert.ok(!text.includes('kept-one'), 'tokens must not be written to .env');
    assert.ok(text.includes('HIERO_LLM_ENDPOINT=https://save.test/v1/chat/completions'));
    assert.equal(runtime.secrets.get('HIERO_LLM_TOKENS'), 'kept-one,kept-two');
  } finally {
    await runtime.close();
    for (const [key, value] of Object.entries({ HIERO_LLM_ENDPOINT: previous.endpoint, HIERO_LLM_TOKENS: previous.tokens, HIERO_LLM_MODEL: previous.model })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('readModelSettings reports token count without exposing token values', async () => {
  const previous = { endpoint: process.env.HIERO_LLM_ENDPOINT, tokens: process.env.HIERO_LLM_TOKENS, model: process.env.HIERO_LLM_MODEL };
  process.env.HIERO_LLM_ENDPOINT = 'https://example.test/v1';
  process.env.HIERO_LLM_TOKENS = 'secret-one, secret-two';
  process.env.HIERO_LLM_MODEL = 'demo-model';
  const runtime = new HieroRuntime(0);
  try {
    const settings = runtime.readModelSettings();
    assert.equal(settings.endpoint, 'https://example.test/v1');
    assert.equal(settings.model, 'demo-model');
    assert.equal(settings.token_count, 2);
    assert.ok(!JSON.stringify(settings).includes('secret'));
  } finally {
    await runtime.close();
    for (const [key, value] of Object.entries({ HIERO_LLM_ENDPOINT: previous.endpoint, HIERO_LLM_TOKENS: previous.tokens, HIERO_LLM_MODEL: previous.model })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

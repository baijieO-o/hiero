import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HieroRuntime } from '../src/hiero-runtime.js';

test('saveModelSettings keeps existing tokens when the token field is blank', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hiero-save-'));
  const previous = { endpoint: process.env.HIERO_LLM_ENDPOINT, tokens: process.env.HIERO_LLM_TOKENS, model: process.env.HIERO_LLM_MODEL };
  process.env.HIERO_LLM_TOKENS = 'kept-one,kept-two';
  try {
    const runtime = new HieroRuntime(0);
    const saved = runtime.saveModelSettings({ endpoint: 'https://save.test/v1', model: 'save-model', tokens: '' }, root);
    assert.deepEqual(saved, { endpoint: 'https://save.test/v1/chat/completions', model: 'save-model', token_count: 2 });
    const text = readFileSync(join(root, '.env'), 'utf8');
    assert.ok(text.includes('HIERO_LLM_TOKENS=kept-one,kept-two'));
    assert.ok(text.includes('HIERO_LLM_ENDPOINT=https://save.test/v1/chat/completions'));
    await runtime.close();
  } finally {
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
  try {
    const runtime = new HieroRuntime(0);
    const settings = runtime.readModelSettings();
    assert.deepEqual(settings, { endpoint: 'https://example.test/v1', model: 'demo-model', token_count: 2 });
    assert.ok(!JSON.stringify(settings).includes('secret'));
    await runtime.close();
  } finally {
    for (const [key, value] of Object.entries({ HIERO_LLM_ENDPOINT: previous.endpoint, HIERO_LLM_TOKENS: previous.tokens, HIERO_LLM_MODEL: previous.model })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

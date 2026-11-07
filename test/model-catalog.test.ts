import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { modelsEndpoint } from '../src/llm-env.js';
import { fetchModelCatalog } from '../src/hiero-runtime.js';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('modelsEndpoint strips the chat completions path and appends /models', () => {
  assert.equal(modelsEndpoint('https://api.example.com/v1'), 'https://api.example.com/v1/models');
  assert.equal(modelsEndpoint('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1/models');
  assert.equal(modelsEndpoint(''), '');
});

test('fetchModelCatalog returns sorted, de-duplicated model ids', async () => {
  let requestedUrl = '';
  const fetchImpl = (async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return jsonResponse(200, { data: [{ id: 'gpt-6-luna' }, { id: 'codex-auto-review' }, { id: 'gpt-6-luna' }, { object: 'x' }] });
  }) as typeof fetch;
  const models = await fetchModelCatalog('https://api.example.com/v1', 'sk-test', fetchImpl);
  assert.equal(requestedUrl, 'https://api.example.com/v1/models');
  assert.deepEqual(models, ['codex-auto-review', 'gpt-6-luna']);
});

test('fetchModelCatalog reports upstream HTTP errors', async () => {
  const fetchImpl = (async () => jsonResponse(401, { error: 'bad key' })) as typeof fetch;
  await assert.rejects(fetchModelCatalog('https://api.example.com/v1', 'sk-test', fetchImpl), /HTTP 401/);
});

test('fetchModelCatalog requires a base URL and an API key', async () => {
  const fetchImpl = (async () => jsonResponse(200, { data: [] })) as typeof fetch;
  await assert.rejects(fetchModelCatalog('', 'sk-test', fetchImpl), /Base URL/);
  await assert.rejects(fetchModelCatalog('https://api.example.com/v1', '', fetchImpl), /API Key/);
});


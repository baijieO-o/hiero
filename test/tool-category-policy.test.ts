import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { z } from 'zod';
import { ToolGateway } from '../src/tool-gateway.js';
import { categoryOf, normalizeCategoryRules, DEFAULT_CATEGORY_RULES } from '../src/tool-category-policy.js';

test('categoryOf maps effects and network access onto approval categories', () => {
  assert.equal(categoryOf({ effect: 'read' }), 'read');
  assert.equal(categoryOf({ effect: 'workspace' }), 'write');
  assert.equal(categoryOf({ effect: 'external' }), 'execute');
  assert.equal(categoryOf({ effect: 'external', networkAccess: true }), 'network');
  assert.equal(categoryOf({}), 'read');
});

test('normalizeCategoryRules keeps valid entries and falls back to defaults', () => {
  assert.deepEqual(normalizeCategoryRules(undefined), DEFAULT_CATEGORY_RULES);
  assert.deepEqual(normalizeCategoryRules({ write: 'auto', network: 'bogus' }), { ...DEFAULT_CATEGORY_RULES, write: 'auto' });
});

test('category rules gate write tools in standard mode and leave reads automatic', async () => {
  const gateway = new ToolGateway();
  gateway.register({ name: 'reader', effect: 'read', inputSchema: z.object({}), execute: () => 'ok' });
  gateway.register({ name: 'writer', effect: 'workspace', inputSchema: z.object({}), execute: () => 'ok' });
  await assert.rejects(() => gateway.execute('writer', {}, 'intent-w', 'standard'));
  assert.equal((await gateway.execute('reader', {}, 'intent-r', 'standard')).result, 'ok');
});

test('auto permission mode skips category approval', async () => {
  const gateway = new ToolGateway();
  gateway.register({ name: 'writer', effect: 'workspace', inputSchema: z.object({}), execute: () => 'ok' });
  assert.equal((await gateway.execute('writer', {}, 'intent-a', 'auto')).result, 'ok');
});

test('setting write to auto lets standard-mode writes through', async () => {
  const gateway = new ToolGateway();
  gateway.setCategoryRules(normalizeCategoryRules({ write: 'auto' }));
  gateway.register({ name: 'writer', effect: 'workspace', inputSchema: z.object({}), execute: () => 'ok' });
  assert.equal((await gateway.execute('writer', {}, 'intent-o', 'standard')).result, 'ok');
});

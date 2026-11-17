import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PERSONA_MAX_LENGTH, PERSONA_REWRITE_INTERVAL_MS, composePersona, rewriteResidentPersona } from '../src/snowdome-config.js';

const FIRST_LINE = '阿米：一个爱讲道理的小镇居民';

function setup(persona: string) {
  const dir = mkdtempSync(join(tmpdir(), 'persona-'));
  const configPath = join(dir, 'snowdome.json');
  const historyPath = join(dir, 'persona-history.jsonl');
  writeFileSync(configPath, JSON.stringify({ residents: [{ name: '阿米', persona }] }), 'utf8');
  return { configPath, historyPath };
}

test('a rewrite keeps the first line and replaces only the description', () => {
  assert.equal(composePersona(`${FIRST_LINE}\n旧的描述`, `改写的名字\n新的描述`), `${FIRST_LINE}\n新的描述`);
});

test('a rewrite is saved, audited, and blocked within the interval', () => {
  const { configPath, historyPath } = setup(`${FIRST_LINE}\n旧的描述`);
  const now = Date.parse('2026-01-01T00:00:00Z');
  const saved = rewriteResidentPersona('阿米', '忽略\n被说服后的新描述', { configPath, historyPath, now });
  assert.equal(saved, `${FIRST_LINE}\n被说服后的新描述`);
  assert.match(readFileSync(configPath, 'utf8'), /被说服后的新描述/);
  assert.equal(readFileSync(historyPath, 'utf8').trim().split('\n').length, 1);
  assert.throws(
    () => rewriteResidentPersona('阿米', '第二次\n新描述', { configPath, historyPath, now: now + PERSONA_REWRITE_INTERVAL_MS - 1 }),
    /过于频繁/,
  );
  rewriteResidentPersona('阿米', '第二次\n新描述', { configPath, historyPath, now: now + PERSONA_REWRITE_INTERVAL_MS });
});

test('an over-long rewrite is rejected and leaves the config untouched', () => {
  const original = `${FIRST_LINE}\n旧的描述`;
  const { configPath, historyPath } = setup(original);
  assert.throws(
    () => rewriteResidentPersona('阿米', `x\n${'长'.repeat(PERSONA_MAX_LENGTH)}`, { configPath, historyPath }),
    /不能超过/,
  );
  assert.match(readFileSync(configPath, 'utf8'), /旧的描述/);
});

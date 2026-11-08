import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { exportTheme, parseThemeFile, sanitizePalette } from '../frontend/src/theme-model.js';

test('sanitizePalette keeps only whitelisted variables with hex colors', () => {
  const result = sanitizePalette({
    '--bg': '#101010',
    '--accent': '#abc',
    '--text': 'red',
    '--unknown': '#ffffff',
    '--border': 'url(evil)',
  });
  assert.deepEqual(result, { '--bg': '#101010', '--accent': '#abc' });
});

test('sanitizePalette rejects non-object input', () => {
  assert.deepEqual(sanitizePalette(null), {});
  assert.deepEqual(sanitizePalette([]), {});
  assert.deepEqual(sanitizePalette('#fff'), {});
});

test('exportTheme round-trips through parseThemeFile', () => {
  const text = exportTheme('测试', { '--bg': '#000000', '--text': '#ffffff' });
  const parsed = parseThemeFile(text);
  assert.deepEqual(parsed, { name: '测试', palette: { '--bg': '#000000', '--text': '#ffffff' } });
});

test('parseThemeFile rejects invalid JSON and wrong formats', () => {
  assert.equal(parseThemeFile('not json'), null);
  assert.equal(parseThemeFile(JSON.stringify({ format: 'other', version: 1, palette: { '--bg': '#000' } })), null);
  assert.equal(parseThemeFile(JSON.stringify({ format: 'hiero-theme', version: 2, palette: { '--bg': '#000' } })), null);
});

test('parseThemeFile rejects files without any valid color', () => {
  const text = JSON.stringify({ format: 'hiero-theme', version: 1, palette: { '--bg': 'javascript:x' } });
  assert.equal(parseThemeFile(text), null);
});

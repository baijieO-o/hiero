import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CodeIndex, createSymbolSearchTool, extractSymbols } from '../src/code-index.js';

test('extractSymbols finds TypeScript declarations with kinds and line numbers', () => {
  const source = [
    'export class Runner {}',
    'export interface Options { a: number }',
    'export type Mode = "a" | "b";',
    'export const build = (x: number) => x;',
    'export async function run() {}',
    'const plain = 1;',
  ].join('\n');
  const symbols = extractSymbols('a.ts', source);
  assert.deepEqual(symbols.map(({ name, kind, line }) => ({ name, kind, line })), [
    { name: 'Runner', kind: 'class', line: 1 },
    { name: 'Options', kind: 'interface', line: 2 },
    { name: 'Mode', kind: 'type', line: 3 },
    { name: 'build', kind: 'const', line: 4 },
    { name: 'run', kind: 'function', line: 5 },
  ]);
});

test('extractSymbols finds Python defs and classes', () => {
  const symbols = extractSymbols('m.py', 'class Engine:\n    pass\n\ndef start():\n    pass\n');
  assert.deepEqual(symbols.map((s) => [s.name, s.kind]), [['Engine', 'class'], ['start', 'function']]);
});

test('CodeIndex searches across the workspace and skips ignored directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hiero-index-'));
  try {
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'src', 'alpha.ts'), 'export function findUser() {}\n');
    await writeFile(join(root, 'src', 'beta.ts'), 'export class UserStore {}\n');
    await writeFile(join(root, 'node_modules', 'pkg', 'index.ts'), 'export function findUser() {}\n');

    const index = new CodeIndex(root);
    const hits = await index.searchSymbols('user');
    assert.deepEqual(hits.map((h) => [h.name, h.path]).sort(), [['UserStore', 'src/beta.ts'], ['findUser', 'src/alpha.ts']]);
    assert.equal(hits.some((h) => h.path.startsWith('node_modules')), false);
    assert.equal((await index.stats()).files, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('symbol_search tool returns matches and is read-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hiero-index-'));
  try {
    await writeFile(join(root, 'x.ts'), 'export function exactName() {}\nexport function exactNameExtra() {}\n');
    const tool = createSymbolSearchTool(new CodeIndex(root));
    assert.equal(tool.effect, 'read');
    const result = await tool.execute({ query: 'exactName' });
    assert.equal(result.symbols[0]?.name, 'exactName');
    assert.equal(result.symbols.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ConfigWatcher, loadConfig, mergeConfig, paramsForModel, parseConfigLayer } from '../src/config.js';
import { Telemetry } from '../src/telemetry.js';

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hiero-config-'));
  roots.push(dir);
  return dir;
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value), 'utf8');
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('config layers', () => {
  it('lets env beat workspace beats user for the logging file', () => {
    const home = tempDir();
    const workspace = tempDir();
    writeJson(join(home, '.hiero', 'config.json'), { logging: { file: 'user.jsonl' } });
    writeJson(join(workspace, '.hiero', 'config.json'), { logging: { file: 'workspace.jsonl' } });

    assert.equal(loadConfig({ home, workspace, env: {} }).logging.file, 'workspace.jsonl');
    assert.equal(loadConfig({ home, workspace, env: { HIERO_LOG_FILE: 'env.jsonl' } }).logging.file, 'env.jsonl');
  });

  it('merges per-model overrides on top of defaults', () => {
    const user = parseConfigLayer(JSON.stringify({ models: { defaults: { temperature: 0.2, top_p: 0.9 }, overrides: { fast: { temperature: 0.7 } } } }));
    const workspace = parseConfigLayer(JSON.stringify({ models: { overrides: { fast: { max_tokens: 512 } } } }));
    const config = mergeConfig([user, workspace]);

    assert.deepEqual(paramsForModel(config, 'fast'), { temperature: 0.7, top_p: 0.9, max_tokens: 512 });
    assert.deepEqual(paramsForModel(config, 'other'), { temperature: 0.2, top_p: 0.9 });
    assert.deepEqual(paramsForModel(config, undefined), { temperature: 0.2, top_p: 0.9 });
  });

  it('ignores invalid fields and malformed JSON without failing', () => {
    assert.deepEqual(parseConfigLayer('{ not json'), {});
    const layer = parseConfigLayer(JSON.stringify({
      models: { defaults: { temperature: 9, top_p: 0.5, max_tokens: -3 } },
      logging: { file: 42 },
    }));
    assert.deepEqual(layer.models?.defaults, { top_p: 0.5 });
    assert.equal(layer.logging, undefined);
  });
});

describe('ConfigWatcher', () => {
  it('picks up a layer file created after startup on the next read', () => {
    const home = tempDir();
    const watcher = new ConfigWatcher({ home, env: {} });
    assert.deepEqual(paramsForModel(watcher.current(), 'm'), {});

    writeJson(join(home, '.hiero', 'config.json'), { models: { defaults: { temperature: 0.3 } } });
    assert.equal(paramsForModel(watcher.current(), 'm').temperature, 0.3);
  });

  it('reloads when a layer file is edited and reports no change otherwise', () => {
    const home = tempDir();
    const path = join(home, '.hiero', 'config.json');
    writeJson(path, { models: { defaults: { temperature: 0.1 } } });
    const watcher = new ConfigWatcher({ home, env: {} });
    assert.equal(watcher.refreshIfChanged(), false);

    writeJson(path, { models: { defaults: { temperature: 0.8 } } });
    const later = new Date(Date.now() + 5_000);
    utimesSync(path, later, later);
    assert.equal(watcher.refreshIfChanged(), true);
    assert.equal(paramsForModel(watcher.current(), undefined).temperature, 0.8);
    assert.equal(watcher.refreshIfChanged(), false);
  });
});

describe('Telemetry', () => {
  it('appends one JSON line per event and counts by name', () => {
    const dir = tempDir();
    const file = join(dir, 'logs', 'hiero.jsonl');
    const telemetry = new Telemetry(file, () => new Date('2026-01-01T00:00:00.000Z'));
    telemetry.record({ name: 'model.call', model: 'm', ok: true, inputTokens: 3 });
    telemetry.record({ name: 'model.call', model: 'm', ok: false });

    const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], { ts: '2026-01-01T00:00:00.000Z', name: 'model.call', model: 'm', ok: true, inputTokens: 3 });
    assert.deepEqual(telemetry.snapshot(), { 'model.call': 2 });
  });

  it('counts events without a file and never throws on write failure', () => {
    const telemetry = new Telemetry(undefined);
    telemetry.record({ name: 'tool.call' });
    assert.deepEqual(telemetry.snapshot(), { 'tool.call': 1 });

    const blocked = join(tempDir(), 'file.txt');
    writeFileSync(blocked, 'x');
    const broken = new Telemetry(join(blocked, 'nested.jsonl'));
    assert.doesNotThrow(() => broken.record({ name: 'model.call' }));
    assert.deepEqual(broken.snapshot(), { 'model.call': 1 });
  });
});

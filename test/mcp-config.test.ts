import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readMcpConfig, saveMcpConfig, toClientConfig } from '../src/mcp-config.js';

test('MCP config round-trips stdio servers and defaults missing fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hiero-mcp-'));
  try {
    assert.deepEqual(readMcpConfig(root).servers.map((server) => server.name), ['filesystem']);
    const saved = saveMcpConfig({ servers: [{ name: 'fs', command: 'npx', args: ['-y', 'server-fs'] }] }, root);
    assert.equal(saved.servers[0]?.transport, 'stdio');
    assert.equal(saved.servers[0]?.enabled, true);
    const loaded = readMcpConfig(root);
    assert.deepEqual(loaded.servers, saved.servers);
    assert.deepEqual(toClientConfig(loaded.servers[0]!), { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'server-fs'] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('MCP config rejects sse transport, duplicate names and invalid names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hiero-mcp-'));
  try {
    assert.throws(() => saveMcpConfig({ servers: [{ name: 'remote', transport: 'sse', command: 'x' }] }, root));
    assert.throws(() => saveMcpConfig({ servers: [{ name: 'a', command: 'x' }, { name: 'a', command: 'y' }] }, root), /重复/);
    assert.throws(() => saveMcpConfig({ servers: [{ name: 'bad name!', command: 'x' }] }, root));
    assert.throws(() => saveMcpConfig({ servers: [{ name: 'empty', command: '  ' }] }, root), /command/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

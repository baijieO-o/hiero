import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { expandEnvPlaceholders, readMcpConfig, saveMcpConfig, toClientConfig } from '../src/mcp-config.js';

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

test('MCP config accepts sse and http servers with a url and maps them to client config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hiero-mcp-'));
  try {
    const saved = saveMcpConfig({ servers: [
      { name: 'remote', transport: 'sse', url: 'http://localhost:9000/sse' },
      { name: 'stream', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
    ] }, root);
    assert.deepEqual(toClientConfig(saved.servers[0]!), { name: 'remote', transport: 'sse', url: 'http://localhost:9000/sse' });
    assert.deepEqual(toClientConfig(saved.servers[1]!), { name: 'stream', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } });
    assert.throws(() => saveMcpConfig({ servers: [{ name: 'bad', transport: 'http', url: 'ftp://x' }] }, root));
    assert.throws(() => saveMcpConfig({ servers: [{ name: 'a', command: 'x' }, { name: 'a', command: 'y' }] }, root), /重复/);
    assert.throws(() => saveMcpConfig({ servers: [{ name: 'bad name!', command: 'x' }] }, root));
    assert.throws(() => saveMcpConfig({ servers: [{ name: 'empty', command: '  ' }] }, root), /command/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('MCP presets resolve ${VAR} placeholders from the environment at connect time only', () => {
  assert.equal(expandEnvPlaceholders('postgres://${DB_USER}@host', { DB_USER: 'alice' }), 'postgres://alice@host');
  assert.throws(() => expandEnvPlaceholders('${MISSING_TOKEN}', {}), /MISSING_TOKEN/);
  process.env.GH_TEST_TOKEN = 'secret-value';
  try {
    const client = toClientConfig({ name: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'server'], enabled: true, env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GH_TEST_TOKEN}' } });
    assert.equal(client.env?.GITHUB_PERSONAL_ACCESS_TOKEN, 'secret-value');
  } finally {
    delete process.env.GH_TEST_TOKEN;
  }
});
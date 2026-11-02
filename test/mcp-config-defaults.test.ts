import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_MCP_CONFIG, mcpConfigPath, readMcpConfig, saveMcpConfig } from '../src/mcp-config.js';

function tempRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `hiero-mcp-${label}-`));
}

describe('default MCP servers', () => {
  it('injects the default server and writes it to disk when no config exists', () => {
    const root = tempRoot('fresh');
    try {
      assert.deepEqual(readMcpConfig(root), DEFAULT_MCP_CONFIG);
      assert.deepEqual(JSON.parse(readFileSync(mcpConfigPath(root), 'utf8')), DEFAULT_MCP_CONFIG);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not re-inject the default after the user removes it', () => {
    const root = tempRoot('remove');
    try {
      readMcpConfig(root);
      saveMcpConfig({ servers: [] }, root);
      assert.deepEqual(readMcpConfig(root).servers, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a user-edited default entry as written', () => {
    const root = tempRoot('edit');
    try {
      readMcpConfig(root);
      saveMcpConfig({ servers: [{ name: 'filesystem', command: 'node', args: ['x.js'], enabled: false }] }, root);
      assert.deepEqual(readMcpConfig(root).servers, [
        { name: 'filesystem', transport: 'stdio', command: 'node', args: ['x.js'], enabled: false },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not overwrite an existing config file', () => {
    const root = tempRoot('existing');
    try {
      mkdirSync(join(root, '.hiero'), { recursive: true });
      writeFileSync(mcpConfigPath(root), JSON.stringify({ servers: [{ name: 'mine', command: 'a' }] }), 'utf8');
      assert.deepEqual(readMcpConfig(root).servers.map((server) => server.name), ['mine']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

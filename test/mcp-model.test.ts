import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildCustomServer, describeServer, needsEnableConfirmation, parseKeyValueLines, plaintextSecretProblem } from '../frontend/src/mcp-model.js';

const base = { name: 'demo', transport: 'stdio' as const, command: 'npx', args: '-y\npkg', url: '', secrets: '' };

test('parseKeyValueLines reads KEY=VALUE lines and rejects a line without =', () => {
  assert.deepEqual(parseKeyValueLines('A=1\n\nB=x=y'), { ok: true, record: { A: '1', B: 'x=y' } });
  assert.equal(parseKeyValueLines('NOEQUALS').ok, false);
});

test('plaintextSecretProblem allows  placeholders and blocks literal secret keys', () => {
  assert.equal(plaintextSecretProblem('GITHUB_TOKEN', '${REMOTE_TOKEN}'), null);
  assert.match(plaintextSecretProblem('GITHUB_TOKEN', 'ghp_abc') ?? '', /占位符/);
  assert.match(plaintextSecretProblem('GITHUB_TOKEN', 'ghp_abc${X}') ?? '', /占位符/);
  assert.equal(plaintextSecretProblem('LOG_LEVEL', 'debug'), null);
});

test('buildCustomServer creates a disabled stdio server with args and env', () => {
  const result = buildCustomServer({ ...base, secrets: 'MODE=read' }, []);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.server, { name: 'demo', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { MODE: 'read' }, enabled: false });
});

test('buildCustomServer rejects duplicate and invalid names', () => {
  assert.equal(buildCustomServer(base, ['demo']).ok, false);
  const invalid = buildCustomServer({ ...base, name: 'bad name' }, []);
  assert.equal(invalid.ok, false);
});

test('buildCustomServer rejects a literal token in the environment', () => {
  const result = buildCustomServer({ ...base, secrets: 'API_KEY=sk-123' }, []);
  assert.equal(result.ok, false);
});

test('buildCustomServer accepts a remote URL with a placeholder header', () => {
  const result = buildCustomServer({ ...base, transport: 'http', url: 'https://example.com/mcp', secrets: 'Authorization=Bearer ${REMOTE_TOKEN}' }, []);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.server.transport, 'http');
  assert.deepEqual(result.server.headers, { Authorization: 'Bearer ${REMOTE_TOKEN}' });
  assert.equal(buildCustomServer({ ...base, transport: 'http', url: 'https://example.com/mcp', secrets: 'Authorization=Bearer ghp_abc${X}' }, []).ok, false);
});

test('buildCustomServer rejects URLs with embedded credentials and non-http schemes', () => {
  assert.equal(buildCustomServer({ ...base, transport: 'sse', url: 'https://user:pass@example.com/mcp' }, []).ok, false);
  assert.equal(buildCustomServer({ ...base, transport: 'sse', url: 'ftp://example.com' }, []).ok, false);
});

test('every server requires explicit confirmation before enabling, and descriptions name the target', () => {
  assert.equal(needsEnableConfirmation({ name: 'a', enabled: false, transport: 'http', url: 'https://x' }), true);
  assert.match(describeServer({ name: 'a', enabled: false, command: 'npx', args: ['-y'] }), /npx -y/);
  assert.match(describeServer({ name: 'a', enabled: false, transport: 'sse', url: 'https://x' }), /https:\/\/x/);
});
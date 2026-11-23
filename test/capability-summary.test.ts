import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilityPromptBlock, mcpCapability, toggledCapability } from '../src/capability-summary.js';

test('MCP server is available only when enabled and connected', () => {
  assert.equal(mcpCapability('fs', true, { name: 'fs', connected: true, tool_count: 3 }).state, 'available');
  assert.equal(mcpCapability('fs', false, { name: 'fs', connected: true, tool_count: 3 }).state, 'disabled');
  assert.deepEqual(mcpCapability('fs', true, { name: 'fs', connected: false, tool_count: 0, error: 'spawn failed' }), { name: 'fs', state: 'unconnected', reason: 'spawn failed' });
});

test('prompt block names usable capabilities and explains unusable ones', () => {
  const block = capabilityPromptBlock([
    toggledCapability('read_file', true),
    toggledCapability('write_file', false),
    mcpCapability('web', true, { name: 'web', connected: false, tool_count: 0, error: 'timeout\n after 5s' }),
  ]);
  assert.match(block, /Currently usable capabilities: read_file\./);
  assert.match(block, /write_file（已停用）/);
  assert.match(block, /web（未连接：timeout after 5s）/);
  assert.doesNotMatch(block, /Currently usable capabilities: [^.]*write_file/);
});

test('MCP server is retrying only while its plug is backing off', () => {
  const failed = { name: 'fs', connected: false, tool_count: 0, error: 'spawn failed' };
  assert.deepEqual(mcpCapability('fs', true, failed, true), { name: 'fs', state: 'retrying', reason: 'spawn failed' });
  assert.equal(mcpCapability('fs', true, failed).state, 'unconnected');
  assert.equal(mcpCapability('fs', false, failed, true).state, 'disabled');
});

test('prompt block is empty when there are no capabilities', () => {
  assert.equal(capabilityPromptBlock([]), '');
});

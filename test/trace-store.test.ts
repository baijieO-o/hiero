import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendChatTrace, listChatTraces } from '../src/trace-store.js';

test('chat traces are appended to the workspace and read back oldest first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hiero-trace-'));
  try {
    assert.deepEqual(await listChatTraces(dir), []);
    await appendChatTrace(dir, 'req-1', [{ seq: 1, kind: 'reply', label: 'done', startedAt: 1, ok: true }]);
    await appendChatTrace(dir, 'req-2', [{ seq: 1, kind: 'error', label: 'fail', startedAt: 2, ok: false }]);
    const traces = await listChatTraces(dir);
    assert.deepEqual(traces.map((trace) => trace.request_id), ['req-1', 'req-2']);
    assert.equal(traces[1]?.events[0]?.kind, 'error');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listChatTraces keeps only the most recent entries and skips empty timelines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hiero-trace-'));
  try {
    await appendChatTrace(dir, 'empty', []);
    for (let i = 0; i < 4; i += 1) {
      await appendChatTrace(dir, `req-${i}`, [{ seq: 1, kind: 'reply', label: 'done', startedAt: i }]);
    }
    const traces = await listChatTraces(dir, 2);
    assert.deepEqual(traces.map((trace) => trace.request_id), ['req-2', 'req-3']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
